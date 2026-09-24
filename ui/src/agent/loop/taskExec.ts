// The task-scoped AgentEnv the APP uses: ONE native undo transaction
// (batch_begin … batch_end) spans every step of an agent task, so a single
// Cmd+Z — or the drawer's Undo — reverts the whole task. Native semantics
// verified: MoshOps::beginTxn coalesces every command while `inBatch`, and the
// dev mock mirrors it (per-command pushUndo suppressed inside a batch).
//
// Lifecycle hardening (the approved Phase-B design):
// - LAZY open: the batch opens on the first step that carries a mutating
//   command, so a purely read-only task never touches the undo stack.
// - SELF-HEAL: if batch_begin answers "a batch is already open" (a zombie from
//   a prior JS crash — the hazard window grows from ms to minutes with a
//   multi-step task), close it and retry once.
// - close() in a finally on every exit path; idempotent.
// - The destructive budget is TASK-cumulative: 6 removes in step 1 leave only
//   4 for the rest of the task, and delete_time_range still consumes the whole
//   budget (destructiveScreen weights).

import { useStore } from "../../store";
import { SCALES, TONICS, inScale, keyLabel, resolveKey, scaleMask } from "../../musicalKey";
import { validateCommand } from "../commands";
import {
  destructiveWeight, isDestructiveCommand,
  MAX_DESTRUCTIVE_PER_BATCH, DESTRUCTIVE_BLOCK_REASON,
} from "../destructiveScreen";
import { MEMORY_COMMANDS, handleRememberPreference } from "../memory/rememberPreference";
import { bumpPatternUsesIfMatched } from "../memory/usesTracking";
import type { AgentEnv, StepCommandResult } from "../loopSeam";
import type { SessionKey, Snapshot } from "../../types";
import { awaitRendersSettled, RENDER_JOB_COMMANDS } from "./jobWait";
import { createNativeTaskExecutor, type NativeTaskBinding } from "./nativeTask";

export type TaskMeta = { utterance?: string; source?: string };

type ExecResult = { ok: boolean; error?: string; data?: unknown };
export type TaskExecDeps = {
  bounded?: NativeTaskBinding;
  /** Step-1 slice 6 — the third argument is the task's provenance (`meta.source`,
   *  default "agent_loop"), forwarded as the `origin` sibling on every envelope. */
  exec?: (command: string, args?: Record<string, unknown>, origin?: string) => Promise<ExecResult>;
  refresh?: () => Promise<void>;
  /** The task's abort signal — a settle-wait cancels pending renders on abort. */
  signal?: { aborted: boolean };
  /** Render-settle timeout override (tests). */
  settleTimeoutMs?: number;
};

// Commands a step may run WITHOUT opening the task's undo transaction. Kept
// deliberately small — anything not listed is treated as mutating.
const READ_ONLY = new Set([
  "list_builtins", "list_plugins", "list_takes", "list_track_outputs",
  "detect_clip_bpm", "get_rhymes", "analyze_lyrics",
]);

const IN_KEY_REQUEST = /\b(?:in (?:the )?key|(?:keep|stay|remain)[^.!?]{0,24}in (?:the )?key)\b/i;
const MELODY_REQUEST = /\b(?:melody|melodic)\b/i;

// FINDINGS.md #4 (2026-09-23 walkthrough) -- "build me a lofi sketch" called
// create_track({name:"Keys", type:"audio"}) and the task ended before any
// add_midi_clip/add_note ever landed, leaving a silent, instrument-less,
// content-less "Keys" track -- the reply even said "I'll add a cozy bed, just
// one layer" while never doing so. Scoped to melodic-INSTRUMENT names, not
// "any empty track this task made": taskExec.test.ts already has several tasks
// that create a track and rename/keep it with no clip at all (LoopTrack/
// Renamed, AfterHeal, Kept, Real, Vocal) and expect it to survive close() --
// that is a deliberate, exercised outcome (a scaffold track for a later step,
// or a plain placeholder track), not the defect. The defect is specifically a
// MELODIC PART that never got an instrument/notes. A blanket "any empty
// created track, unless the utterance mentions recording" rule was considered
// and rejected: none of LoopTrack/AfterHeal/Kept/Real's utterances ("build a
// beat", none, none, none) mention recording, so that rule would delete all of
// them and break those tests. EXPLICIT_EMPTY_TRACK_REQUEST below is the
// narrower opt-out this design still wants: if the ask itself says the track
// should stay empty/for later, skip the repair entirely for this task.
const MELODIC_TRACK_NAME_RE = /\b(?:keys?|piano|synth|pad|lead|bass|chords?|melody|melodic|guitar|strings?|organ|rhodes|wurlitzer)\b/i;
const EXPLICIT_EMPTY_TRACK_REQUEST = /\b(?:empty|blank|placeholder)\b|\bfor (?:me|you) to (?:record|play|fill|write)\b|\brecord into (?:it|this|that)\b/i;

// FINDINGS.md #4 -- the same task's add_drum_pattern passed the EXISTING Drums
// track's id with no clipId, and bridge.mock.ts's add_drum_pattern (mirroring
// the native handler, see its own header comment at case "add_drum_pattern")
// just PUSHES a new clip at `start` -- it does not replace or check for
// collisions. The command already has a documented, SAFE in-place-edit path
// (pass `clipId`, which replaces only the named lanes of an existing clip --
// see its ArgSpec desc in commands.ts), so refusing the trackId-only
// collision here closes a silent side door without removing any capability.
const OVERLAP_GUARDED_COMMANDS = new Set(["add_drum_pattern", "add_midi_clip"]);

function clipPlacementOverlapError(command: string, args: Record<string, unknown>, snap: Snapshot): string | null {
  if (!OVERLAP_GUARDED_COMMANDS.has(command)) return null;
  if (typeof args.clipId === "string" && args.clipId) return null; // explicit in-place edit
  const trackId = typeof args.trackId === "string" ? args.trackId : "";
  if (!trackId) return null; // add_drum_pattern's own "omit to create a new Drums track" path
  const track = snap.tracks.find((t) => t.id === trackId);
  if (!track || track.clips.length === 0) return null;

  const start = typeof args.start === "number" && Number.isFinite(args.start) ? args.start : 0;
  const beatsPerBar = snap.session.timeSigNumerator ?? 4;
  const beatSec = (4 / (snap.session.timeSigDenominator ?? 4)) * (60 / (snap.session.tempo || 120));
  const end = command === "add_midi_clip"
    ? start + (typeof args.length === "number" && args.length > 0 ? args.length : beatsPerBar * beatSec)
    : start + (typeof args.bars === "number" && args.bars > 0 ? args.bars : 1) * beatsPerBar * beatSec;

  const hit = track.clips.find((c) => start < c.start + c.length && c.start < end);
  if (!hit) return null;
  return `${command} at ${start.toFixed(2)}s would overlap the existing clip "${hit.name}" `
    + `(${hit.start.toFixed(2)}s-${(hit.start + hit.length).toFixed(2)}s) on this track; `
    + `place it on a new track, in an empty range, or pass clipId to edit "${hit.name}" in place.`;
}

function noteKeyError(command: string, args: Record<string, unknown>, key: SessionKey, melody: boolean): string | null {
  if (command !== "add_note" && command !== "set_note") return null;
  const resolved = resolveKey(key);
  const pitches = Array.isArray(args.notes)
    ? args.notes.map((note, index) => ({
        label: `notes[${index}]`,
        pitch: (note as Record<string, unknown>).pitch,
      }))
    : [{ label: "", pitch: args.pitch }];
  for (const candidate of pitches) {
    const pitch = candidate.pitch;
    if (typeof pitch !== "number" || !Number.isFinite(pitch)) continue;
    const prefix = candidate.label ? `${candidate.label} ` : "";
    if (melody && (pitch < 48 || pitch > 84))
      return `${command} ${prefix}pitch ${Math.round(pitch)} is outside the practical melody register; use an actual MIDI note from 48 to 84`;
    if (resolved.mode === "chromatic" || inScale(pitch, scaleMask(resolved))) continue;
    const allowed = SCALES[resolved.mode].map((offset) => TONICS[(resolved.tonic + offset) % 12]).join(" ");
    return `${command} ${prefix}pitch ${Math.round(pitch)} is outside ${keyLabel(key)}; use one of ${allowed}`;
  }
  return null;
}

// Step-1 slice 4 — the ONLY keys of a result payload that reach the model, in the
// order they render. Everything else in `data` (names, values, file paths, job
// handles) stays behind the seam exactly as before.
const RESULT_ID_KEYS = ["trackId", "clipId", "bus", "busNumber", "index", "padId"] as const;

/** The loop-safe id subset of a command's result payload: string ids (non-empty)
 *  and finite numeric ids under the RESULT_ID_KEYS names, from a plain object
 *  payload only. Undefined — never `{}` — when there is nothing to keep. */
export function pickResultIds(data: unknown): Record<string, string | number> | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const payload = data as Record<string, unknown>;
  const ids: Record<string, string | number> = {};
  for (const key of RESULT_ID_KEYS) {
    const v = payload[key];
    if (typeof v === "string" && v !== "") ids[key] = v;
    else if (typeof v === "number" && Number.isFinite(v)) ids[key] = v;
  }
  return Object.keys(ids).length ? ids : undefined;
}

function newTurnId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* non-crypto fallback below */ }
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type TaskExecutor = {
  env: AgentEnv;
  /** P1 produce-lane preflight (produceTemplate.ts) — deterministic, non-model-
   *  authored setup that needs each command's raw `data` payload (a trackId to
   *  chain the next call) rather than the loop-safe {command,ok,error} envelope
   *  env.runBatch returns. Opens the SAME undo transaction as env.runBatch (lazy,
   *  skipped for READ_ONLY commands) so the whole task — preflight included —
   *  still reverts as one undo unit. Bypasses catalog validation/destructive
   *  screening: callers pass only commands they constructed themselves, never
   *  model output. */
  execRaw(command: string, args?: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: unknown }>;
  /** Close the task's undo transaction (idempotent; call in a finally). */
  close(): Promise<void>;
  /** Whether the native batch was actually opened (false for read-only tasks). */
  opened(): boolean;
};

export function createTaskExecutor(label: string, meta: TaskMeta = {}, deps: TaskExecDeps = {}): TaskExecutor {
  if (deps.bounded) return createNativeTaskExecutor(deps.bounded, deps);
  const seam = deps.exec
    ?? ((c: string, a?: Record<string, unknown>, o?: string) => useStore.getState().exec(c, a, undefined, o));
  // Step-1 slice 6 — ONE provenance value for the whole task: the same `source` the
  // batch_begin marker carries in its args (below) also rides every envelope of the
  // task as `origin`, so MoshOps stamps it on each JSONL line beside the turn_id.
  const origin = meta.source ?? "agent_loop";
  const exec = (c: string, a?: Record<string, unknown>) => seam(c, a, origin);
  const refresh = deps.refresh ?? (() => useStore.getState().refresh());
  let opened = false;
  let closed = false;
  let destructiveUsed = 0;
  // trackId -> the `type` arg this task's create_track call was given (undefined = default
  // "audio"). Only tracks CREATED BY THIS TASK are ever candidates for repairEmptyMelodicTracks.
  const createdTrackTypes = new Map<string, string | undefined>();

  async function getSnapshot(): Promise<Snapshot> {
    await refresh();
    const s = useStore.getState().snapshot;
    if (!s) throw new Error("task env: store has no snapshot");
    return s;
  }

  async function ensureOpen(): Promise<void> {
    if (opened) return;
    // FS-B2a (H2) — `utterance` is omitted when no real transcript reached us, never
    // faked from `label` (which is Moshi's own text). See executor.ts's turnMarkerArgs.
    const args: Record<string, unknown> = {
      name: label,
      turn_id: newTurnId(),
      source: meta.source ?? "agent_loop",
    };
    if (meta.utterance) args.utterance = meta.utterance;
    let begin = await exec("batch_begin", args);
    if (!begin.ok && /already open/i.test(begin.error ?? "")) {
      await exec("batch_end", {}); // heal the zombie, then retry once
      begin = await exec("batch_begin", args);
    }
    if (!begin.ok) throw new Error(`batch_begin failed: ${begin.error ?? "unknown error"}`);
    opened = true;
  }

  const env: AgentEnv = {
    getSnapshot,
    async runBatch(_stepLabel, calls) {
      if (closed) throw new Error("task executor is closed");
      type Entry = StepCommandResult & { index: number };
      const entries: Entry[] = [];
      const valid: Array<{ index: number; command: string; args: Record<string, unknown> }> = [];
      let constrainedKey: SessionKey | undefined;
      const melodyRequest = MELODY_REQUEST.test(meta.utterance ?? "");
      if (IN_KEY_REQUEST.test(meta.utterance ?? "")
          && calls.some((c) => c.command === "add_note" || c.command === "set_note" || c.command === "set_key"))
        constrainedKey = (await getSnapshot()).session.key;
      let overlapSnapshot: Snapshot | undefined;
      if (calls.some((c) => OVERLAP_GUARDED_COMMANDS.has(c.command)))
        overlapSnapshot = await getSnapshot();
      const memoryCalls = calls
        .map((c, index) => ({ c, index }))
        .filter(({ c }) => MEMORY_COMMANDS.has(c.command));
      // AGT-MEM (M3) — same interception as executor.ts's runAgentBatch: intercepted
      // BEFORE validateCommand, run immediately (no batch_begin needed — a memory
      // write touches no ValueTree), never counted toward the destructive screen or
      // ensureOpen()'s "does this step need the undo transaction" check below.
      for (const { c, index } of memoryCalls) {
        const r = await handleRememberPreference(c.args, exec);
        entries.push({ index, command: r.command, ok: r.ok, error: r.error });
      }
      calls.forEach((c, index) => {
        if (MEMORY_COMMANDS.has(c.command)) return;   // already handled above
        const args = (c.args ?? {}) as Record<string, unknown>;
        let err = validateCommand(c.command, args);
        if (!err && constrainedKey && c.command === "set_key")
          constrainedKey = { tonic: String(args.tonic), mode: String(args.mode) };
        if (!err && constrainedKey) err = noteKeyError(c.command, args, constrainedKey, melodyRequest);
        if (!err && overlapSnapshot) err = clipPlacementOverlapError(c.command, args, overlapSnapshot);
        if (err) entries.push({ index, command: c.command, ok: false, error: err });
        else valid.push({ index, command: c.command, args });
      });

      // Task-cumulative destructive screen (same reporting shape as runAgentBatch).
      const stepWeight = valid.reduce((n, c) => n + destructiveWeight(c.command), 0);
      let allowed = valid;
      if (destructiveUsed + stepWeight > MAX_DESTRUCTIVE_PER_BATCH) {
        for (const c of valid)
          if (isDestructiveCommand(c.command))
            entries.push({ index: c.index, command: c.command, ok: false, error: DESTRUCTIVE_BLOCK_REASON });
        allowed = valid.filter((c) => !isDestructiveCommand(c.command));
      } else {
        destructiveUsed += stepWeight;
      }

      if (allowed.some((c) => !READ_ONLY.has(c.command))) await ensureOpen();
      for (const c of allowed) {
        const r = await exec(c.command, c.args);
        const ids = pickResultIds(r.data);
        entries.push({ index: c.index, command: c.command, ok: r.ok, error: r.ok ? undefined : r.error, ...(ids ? { ids } : {}) });
        // AGT-MEM (M4, item 6) — same fire-and-forget "uses" tracking as executor.ts's
        // runAgentBatch (see that file's comment / usesTracking.ts's header).
        if (r.ok) void bumpPatternUsesIfMatched(c.command, c.args, exec);
        if (r.ok && c.command === "create_track") {
          const newId = ids?.trackId;
          if (typeof newId === "string" && newId)
            createdTrackTypes.set(newId, typeof c.args.type === "string" ? c.args.type : undefined);
        }
      }

      // A render's ok = "job submitted"; the OBSERVATION must see the settled
      // state (the audio landed / errored) or the next step reasons over limbo.
      const started = allowed.filter((c) =>
        RENDER_JOB_COMMANDS.has(c.command)
        && entries.some((e) => e.index === c.index && e.ok)
        && typeof c.args.clipId === "string");
      if (started.length > 0)
        await awaitRendersSettled({ getSnapshot }, started.map((c) => c.args.clipId as string), {
          signal: deps.signal,
          timeoutMs: deps.settleTimeoutMs,
          onAbort: async (clipId) => { await exec("cancel_render", { clipId }); },
        });

      entries.sort((a, b) => a.index - b.index);
      return {
        results: entries.map(({ command, ok, error, ids }) => ({ command, ok, error, ...(ids ? { ids } : {}) })),
        snapshot: await getSnapshot(),
      };
    },
  };

  /** Removes a track THIS TASK created that ends the task empty and melodic-named -- see
   *  MELODIC_TRACK_NAME_RE's header comment. Skipped entirely when the ask itself said the
   *  track should stay empty/for later (EXPLICIT_EMPTY_TRACK_REQUEST). Called from close(),
   *  before batch_end, so the removal is inside the same undo transaction as everything else
   *  the task did. */
  async function repairEmptyMelodicTracks(): Promise<void> {
    if (createdTrackTypes.size === 0) return;
    if (EXPLICIT_EMPTY_TRACK_REQUEST.test(meta.utterance ?? "")) return;
    let liveSnapshot: Snapshot | undefined;
    for (const [trackId, requestedType] of createdTrackTypes) {
      if (requestedType && requestedType !== "audio") continue; // "drum" auto-loads a kit
      liveSnapshot ??= await getSnapshot();
      const track = liveSnapshot.tracks.find((t) => t.id === trackId);
      if (!track || track.clips.length > 0) continue;
      if (!MELODIC_TRACK_NAME_RE.test(track.name)) continue;
      await exec("remove_track", { trackId });
    }
  }

  return {
    env,
    async execRaw(command, args) {
      if (closed) throw new Error("task executor is closed");
      if (!READ_ONLY.has(command)) await ensureOpen();
      return exec(command, args ?? {});
    },
    opened: () => opened,
    async close() {
      if (closed) return;
      closed = true;
      if (opened) {
        await repairEmptyMelodicTracks();
        await exec("batch_end", {});
        await refresh();
      }
    },
  };
}

/** Revert the last agent TASK — one undo covers the whole transaction. */
export async function undoAgentTask(): Promise<boolean> {
  const { exec, refresh } = useStore.getState();
  const result = await exec("undo");
  await refresh();
  if (!result.ok) return false;
  if (result.data === true) return true;
  if (result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) return false;
  return "undone" in result.data && (result.data as { undone?: unknown }).undone === true;
}
