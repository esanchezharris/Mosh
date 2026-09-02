// The app-side glue for an agentic task: composer text in → the loop runs over
// the TASK-scoped executor (one undo unit), progress streams into the task
// store (the drawer renders it), Moshi utters only at the beats (ACK_WORKING on
// start, DONE/HUH/UHOH at the end — no per-step creature spam). Provider failure
// is explicit in packaged builds; only the existing dev/e2e surface may use the
// deterministic loop brain, matching the single-shot posture.
//
// Loop tasks deliberately do NOT set agentChangeSet — the drawer carries the
// per-step detail, so the ChangeToast stays quiet for them by construction.
//
// M2 (Phase-B memory lane, flag `agentMemory`): the memory section is computed ONCE
// here, before the loop starts (loop.ts's FSM is pure/deps-injected — it never calls
// the bridge itself), and passed through LoopDeps.memory so every step's prompt
// carries the SAME section (hydration/ranking is a one-time task cost, never a
// per-step one).
//
// M3: the memory section ALSO carries the remember_preference pseudo-command's
// serve-time doc (memory/rememberPreference.ts) whenever the flag is on, regardless
// of pool content — see brain.ts's memorySectionFor for why (a fresh install must
// still learn the tool exists). `memory` is undefined only when the flag itself is
// off, so it's the ONLY case where every step's prompt stays byte-identical to the
// pre-M2 shape.

import { archivePair, brainChat, demoBrainAvailable } from "../../bridge";
import { inScale, resolveKey, scaleMask } from "../../musicalKey";
import { useSettings } from "../../settings/store";
import { useStore } from "../../store";
import { runAgentLoop, type ChatMessage, type LoopRun } from "./loop";
import { buildProduceSystemPrompt, isProduceAsk, PRODUCE_BUDGETS } from "./producePrompt";
import { createTaskExecutor, undoAgentTask } from "./taskExec";
import { mockLoopChat } from "./loopBrainMock";
import { hasSequentialMarkers } from "./router";
import { useTaskStore } from "./taskStore";
import type { AgentCommandCall } from "../destructiveScreen";
import type { AgentEnv } from "../loopSeam";
import { ensureMemoryHydrated, poolsNonEmpty } from "../memory/hydrate";
import { retrieveContext } from "../memory/retrieveContext";
import { rememberPreferenceToolDoc } from "../memory/rememberPreference";
import type { Snapshot } from "../../types";

export const agenticLoopEnabled = (flag: string | undefined): boolean => flag === "1";
export const loopAllowedFor = (flag: string | undefined, multiplayerActive: boolean): boolean =>
  agenticLoopEnabled(flag) && !multiplayerActive;
export const agenticLoopOn = (): boolean =>
  agenticLoopEnabled(import.meta.env.VITE_MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP);
const memoryOn = (): boolean => useSettings.getState().get("agentMemory") !== false;

/** Mirrors brain.ts's memorySectionFor — same flag, same hydrate+retrieveContext+
 *  tool-doc pairing. Kept as its own function (not shared with brain.ts) since the
 *  two call sites differ in WHEN they call it: brain.ts per turn, this one ONCE per
 *  task before the loop starts. Returns undefined (not "") only when the flag is
 *  off — LoopDeps.memory is itself optional, and buildLoopSystemPrompt's own
 *  omitted/undefined contract is what keeps that path byte-identical when off. */
async function memorySectionFor(query: string): Promise<string | undefined> {
  if (!memoryOn()) return undefined;
  const pools = await ensureMemoryHydrated();
  const retrieved = poolsNonEmpty(pools) ? retrieveContext(query, pools) : "";
  return [retrieved, rememberPreferenceToolDoc()].filter(Boolean).join("\n\n");
}

/** The loop runs only when the flag is on AND we're not in a multiplayer
 *  session (v1: a long-lived open batch vs the MP lock table is unplaytested —
 *  gate it off; bounded studio skills stay available in MP). */
export const loopAllowed = (): boolean =>
  loopAllowedFor(import.meta.env.VITE_MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP, useStore.getState().mp.active);

export type TaskUi = {
  say(text: string | null): void;
  utter(intent: string, say?: string): void;
};

const END_UTTER: Record<LoopRun["outcome"], { intent: string; fallback?: string }> = {
  done: { intent: "DONE" },
  need_user: { intent: "HUH" },
  budget: { intent: "UHOH", fallback: "ran out of road — want me to keep going?" },
  error: { intent: "UHOH", fallback: "hmm — that broke partway" },
  aborted: { intent: "IDLE_MURMUR", fallback: "stopped — kept what's done" },
};
const BRAIN_UNAVAILABLE_SAY = "can't reach my brain — check setup and try again";
const COMPACT_MELODY_ASK = /\b(?:melody|melodic)\b/i;
const COMPACT_IN_KEY_ASK = /\b(?:in (?:the )?key|(?:keep|stay|remain)[^.!?]{0,24}in (?:the )?key)\b/i;
const COMPACT_ADDITIONAL_ACTION = /\b(?:and|also)\s+(?!(?:keep|stay|remain)\b)/i;
const COMPACT_MELODY_VELOCITIES = [88, 82, 86, 80, 85, 81, 87, 83] as const;

export type CompactMelodySpec = {
  clipId: string;
  trackName: string;
  allowedPitches: readonly number[];
  prompt: string;
};

export function compactMelodySpec(text: string, snap: Snapshot): CompactMelodySpec | null {
  if (!COMPACT_MELODY_ASK.test(text)
      || !COMPACT_IN_KEY_ASK.test(text)
      || hasSequentialMarkers(text)
      || COMPACT_ADDITIONAL_ACTION.test(text)) return null;
  const query = text.toLowerCase();
  const track = snap.tracks.find((candidate) =>
    candidate.name.trim() !== "" && query.includes(candidate.name.toLowerCase()));
  const clip = track?.clips.find((candidate) => candidate.type === "midi");
  if (!track || !clip) return null;
  const key = resolveKey(snap.session.key);
  if (key.mode === "chromatic") return null;
  const mask = scaleMask(key);
  const allowedPitches = Array.from({ length: 13 }, (_, index) => index + 69)
    .filter((pitch) => inScale(pitch, mask));
  return {
    clipId: clip.id,
    trackName: track.name,
    allowedPitches,
    prompt: `Reply only as compact JSON {"p":[n,n,n,n,n,n,n,n]}. Choose exactly 8 varied MIDI pitches for a simple melody. Every n must be one of ${allowedPitches.join(",")}. No words or other keys.`,
  };
}

export function compactMelodyCommand(content: string, spec: CompactMelodySpec): AgentCommandCall | null {
  let source = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first >= 0 && last > first) source = source.slice(first, last + 1);
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    if (!Array.isArray(parsed.p) || parsed.p.length !== 8) return null;
    const allowed = new Set(spec.allowedPitches);
    const pitches = parsed.p.filter((pitch): pitch is number =>
      typeof pitch === "number" && Number.isInteger(pitch) && allowed.has(pitch));
    if (pitches.length !== 8 || new Set(pitches).size < 3) return null;
    return {
      command: "add_note",
      args: {
        clipId: spec.clipId,
        notes: pitches.map((pitch, index) => ({
          pitch,
          start: index * 0.5,
          length: 0.5,
          velocity: COMPACT_MELODY_VELOCITIES[index],
        })),
      },
    };
  } catch {
    return null;
  }
}

async function chatWithFallback(messages: ChatMessage[]): Promise<{ content: string; ms?: number }> {
  try {
    return await brainChat(messages);
  } catch {
    if (demoBrainAvailable()) return mockLoopChat(messages);
    throw new Error(BRAIN_UNAVAILABLE_SAY);
  }
}

// Produce lane is CLOUD-ONLY by owner decision ("frontier now, distill later",
// docs/POSTMORTEM-2026-09.md): a full production pass on the local assistant
// model is exactly the silent quality substitution the postmortem bans. Try the
// cloud providers in order and VERIFY the responder (a requested-but-incomplete
// provider resolves to a fallback natively — the result's `provider` field is
// the truth). No local fallback: failing loudly beats producing quietly worse.
const PRODUCE_CLOUD_PROVIDERS = ["deepseek", "openai", "xai"] as const;
async function produceCloudChat(messages: ChatMessage[]): Promise<{ content: string; ms?: number }> {
  if (demoBrainAvailable()) return mockLoopChat(messages); // dev/e2e surface stays deterministic
  let lastError: unknown;
  for (const p of PRODUCE_CLOUD_PROVIDERS) {
    try {
      const r = await brainChat(messages, p);
      if (r.provider && r.provider !== p) { lastError = new Error(`${p} not configured (served by ${r.provider})`); continue; }
      return r;
    } catch (e) { lastError = e; }
  }
  throw new Error(
    "Produce mode needs a configured cloud brain (a provider's *_API_KEY, *_BASE_URL and *_MODEL env trio) — " +
    "refusing to run a full production pass on the local assistant model. " +
    (lastError instanceof Error ? lastError.message : ""),
  );
}

async function runCompactMelodyTask(
  text: string,
  env: AgentEnv,
  signal: { aborted: boolean },
): Promise<LoopRun | null> {
  const initialSnapshot = await env.getSnapshot();
  const spec = compactMelodySpec(text, initialSnapshot);
  if (!spec) return null;
  const progress = (event: Parameters<ReturnType<typeof useTaskStore.getState>["progress"]>[0]) =>
    useTaskStore.getState().progress(event);
  progress({ kind: "phase", phase: "planning" });
  if (signal.aborted)
    return { finalSnapshot: initialSnapshot, transcript: [], stepCount: 0, deferred: true, outcome: "aborted" };

  const startedAt = Date.now();
  let content: string;
  try {
    content = (await brainChat([
      { role: "system", content: spec.prompt },
      { role: "user", content: text },
    ])).content;
  } catch (error) {
    if (demoBrainAvailable()) content = '{"p":[69,71,72,74,76,77,79,81]}';
    else return {
      finalSnapshot: initialSnapshot,
      transcript: [],
      stepCount: 0,
      deferred: true,
      outcome: "error",
      error: `${BRAIN_UNAVAILABLE_SAY}: ${String(error).slice(0, 120)}`,
    };
  }
  if (signal.aborted)
    return { finalSnapshot: initialSnapshot, transcript: [], stepCount: 0, deferred: true, outcome: "aborted" };

  const command = compactMelodyCommand(content, spec);
  if (!command)
    return {
      finalSnapshot: initialSnapshot,
      transcript: [],
      stepCount: 0,
      deferred: true,
      outcome: "need_user",
      say: "I couldn't shape a clean in-key phrase yet.",
    };

  const goal = `Add a simple in-key melody to ${spec.trackName}`;
  progress({ kind: "plan", plan: [{ goal, commands: [command] }] });
  progress({ kind: "step-start", index: 0, goal, commands: [command] });
  const step = await env.runBatch(goal, [command]);
  progress({ kind: "step-result", index: 0, results: step.results });
  const ok = step.results.length === 1 && step.results[0]?.ok === true;
  return {
    finalSnapshot: step.snapshot,
    transcript: [{ commands: [command], results: step.results, invalidCount: 0, ms: Date.now() - startedAt }],
    stepCount: 1,
    deferred: false,
    outcome: ok ? "done" : "error",
    say: ok ? `a little in-key melody for ${spec.trackName}` : undefined,
    error: ok ? undefined : step.results[0]?.error,
  };
}

/** Run one agentic task end-to-end. Resolves when the task finishes (any outcome). */
export async function runLoopTask(text: string, ui: TaskUi): Promise<LoopRun> {
  const store = useTaskStore.getState();
  const signal = store.begin(text);
  ui.utter("ACK_WORKING");

  const exec = createTaskExecutor(text.slice(0, 48), { utterance: text, source: "agent_loop" }, { signal });
  let run: LoopRun;
  try {
    const compactMelody = await runCompactMelodyTask(text, exec.env, signal);
    if (compactMelody) run = compactMelody;
    else {
      const memory = await memorySectionFor(text);
      // P1 produce lane (flag `produceLane`, default OFF): an explicit produce ask
      // gets the genre-rule prompt and full-pass budgets; everything else keeps the
      // DOSAGE lane byte-identically (systemPrompt/budgets omitted).
      const produce = useSettings.getState().get("produceLane") === true && isProduceAsk(text);
      run = await runAgentLoop({ ask: text }, {
        chat: produce ? produceCloudChat : chatWithFallback,
        env: exec.env,
        signal,
        onProgress: (ev) => useTaskStore.getState().progress(ev),
        memory,
        ...(produce ? { systemPrompt: buildProduceSystemPrompt, budgets: PRODUCE_BUDGETS } : {}),
      });
    }
  } finally {
    await exec.close(); // the task's undo transaction closes on EVERY exit path
  }

  useTaskStore.getState().finish(run);

  // Archive the task transcript for the future LOOP dataset lane — a NEW,
  // versioned surface (source-tagged; the multi-step reply contract must never
  // fold into the single-shot SFT mixes). Best-effort, no-op outside native.
  void archivePair({
    source: "agent-loop",
    v: 1,
    utterance: text,
    outcome: run.outcome,
    steps: run.transcript.map((s) => ({
      commands: s.commands,
      results: s.results.map((r) => ({ command: r.command, ok: r.ok, error: r.error })),
    })),
  }).catch(() => { /* archival must never affect the task */ });

  const end = END_UTTER[run.outcome];
  const sayText = run.say ?? (run.error?.includes(BRAIN_UNAVAILABLE_SAY) ? BRAIN_UNAVAILABLE_SAY : end.fallback);
  ui.say(sayText ?? null);
  ui.utter(end.intent, sayText);
  return run;
}

export { undoAgentTask };
