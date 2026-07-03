// SFT dataset builder — turn importer programs + harvested tuples into a
// chat-format JSONL that teaches a local LLM to emit Moshi's {intent, commands}
// replies. This is the Phase-4 cold-start data: the content-generation behavior
// (note/clip population) that GEPA proved prompt-tuning canNOT teach.
//
// Built in TS (not Python) on purpose: every example's system prompt is produced
// by the SAME buildSystemPrompt() the app serves at runtime, so the model trains
// on byte-identical inputs. Each assistant target is the exact parseReply contract
// ({intent, commands:[{command,args}]}) and is self-verified to round-trip through
// parseReply + validateCommand + a clean mock apply, so a clean-trained model's raw
// output needs zero post-processing.

import type { Snapshot, CommandResult } from "../types";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../bridge.mock";
import { validateCommand } from "../agent/commands";
import { buildSystemPrompt, DEFAULT_RULES, parseReply } from "../agent/brainCore";
import { isAgentCallable, type Tuple, type CommandCall } from "../harvest/tupleSchema";
import { runBound } from "../gepa/metric";
import type { BoundCommand, ImportProgram } from "../import/emit";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type RenderedExample = { id: string; sourceId: string; messages: ChatMessage[]; goldCommandNames: string[] };

// A sliced task before rendering: a setup prefix (unscored, logical $refs) + the
// target slice the model should learn to emit + a natural utterance + intent.
export type RawExample = {
  id: string;
  sourceId: string;
  utterance: string;
  startCommands: BoundCommand[];
  targetCommands: BoundCommand[];
  goldCommandNames: string[];
  intent: string;
};

export type SliceOptions = { maxStart?: number; max?: number; maxNotes?: number };

// Utterances must be FAITHFUL to the gold args. The v2 corpus paired relative
// phrasings ("turn it up a little") with the project's ABSOLUTE volume (mostly
// db:0) — an unlearnable mapping that zeroed the whole mixer category on eval
// (2026-07 training audit). Absolute gold ⇒ absolute utterance; relative
// phrasings come from relativeMixerExamples() below, whose gold really is
// current ± delta.
const MIXER: Record<string, (name: string, args: Record<string, unknown>) => string> = {
  set_track_volume: (n, a) => {
    const db = Number(a.db);
    return db === 0 ? `set the "${n}" track back to 0 dB` : `set the "${n}" track volume to ${db} dB`;
  },
  set_track_pan: (n, a) => {
    const p = Number(a.pan);
    return p === 0 ? `center the "${n}" track` : `pan the "${n}" track ${Math.round(Math.abs(p) * 100)}% ${p >= 0 ? "right" : "left"}`;
  },
  set_track_mute: (n) => `mute the "${n}" track`,
  set_track_solo: (n) => `solo the "${n}" track`,
};

// Relative-move vocabulary with a FIXED, learnable convention: touch/hair = 2 dB,
// bit/little = 3 dB, explicit "by N dB" = N. Deterministic rotation, no RNG.
const RELATIVE_MOVES: Array<{ phrase: (n: string) => string; delta: number }> = [
  { phrase: (n) => `turn the "${n}" track up a touch`, delta: 2 },
  { phrase: (n) => `turn the "${n}" track up a bit`, delta: 3 },
  { phrase: (n) => `give the "${n}" track a little more level`, delta: 3 },
  { phrase: (n) => `boost the "${n}" track by 6 dB`, delta: 6 },
  { phrase: (n) => `bring the "${n}" track down a touch`, delta: -2 },
  { phrase: (n) => `pull the "${n}" track down a bit`, delta: -3 },
  { phrase: (n) => `back the "${n}" track off a little`, delta: -3 },
  { phrase: (n) => `bring the "${n}" track down by 4 dB`, delta: -4 },
];

// Sibling coverage for the same relative-instruction class (program Stage 1.2):
// pan convention touch = 10%, bit/little = 15%, explicit "by N%" = N; tempo
// convention touch = 2 BPM, bit/little = 5, explicit "by N" = N. Emitted only
// when the target stays in range — clamping would teach a wrong delta.
const RELATIVE_PAN_MOVES: Array<{ phrase: (n: string) => string; delta: number }> = [
  { phrase: (n) => `nudge the "${n}" track a touch left`, delta: -0.1 },
  { phrase: (n) => `push the "${n}" track a bit right`, delta: 0.15 },
  { phrase: (n) => `ease the "${n}" track a little left`, delta: -0.15 },
  { phrase: (n) => `pan the "${n}" track right by 25%`, delta: 0.25 },
];
const RELATIVE_TEMPO_MOVES: Array<{ phrase: () => string; delta: number }> = [
  { phrase: () => "bring the tempo up a touch", delta: 2 },
  { phrase: () => "speed it up a bit", delta: 5 },
  { phrase: () => "slow it down a little", delta: -5 },
  { phrase: () => "push the tempo up by 10", delta: 10 },
  { phrase: () => "pull the tempo down a touch", delta: -2 },
];

/**
 * Cut an importer program into gradeable SFT tasks, emitting the FULL target
 * command slice (every add_note with its args) — unlike gepa/sliceProgram which
 * keeps only command names for the metric. Note-population keeps the add_midi_clip
 * in the SETUP (the model can't reference a clip it creates the same turn).
 */
export function sliceProgramFull(program: ImportProgram, sourceId: string, opts: SliceOptions = {}): RawExample[] {
  const maxStart = opts.maxStart ?? 50;
  const max = opts.max ?? 1000;
  const maxNotes = opts.maxNotes ?? 64; // cap a populate target so MIDI's long note runs don't make giant examples
  const cmds = program.commands;
  const out: RawExample[] = [];

  const trackName = new Map<string, string>();
  const relativeSeen = new Set<string>();
  for (const c of cmds) if (c.command === "create_track" && c.bind) trackName.set(c.bind, String(c.args.name ?? "track"));
  const nameOf = (arg: unknown) => trackName.get(typeof arg === "string" ? arg.replace(/^\$/, "") : "") ?? "track";

  const push = (utterance: string, startEnd: number, target: BoundCommand[], intent = "ACK_GOT_IT") => {
    if (out.length >= max || startEnd > maxStart || target.length === 0) return;
    out.push({
      id: `${sourceId}#${out.length}`,
      sourceId,
      utterance,
      startCommands: cmds.slice(0, startEnd),
      targetCommands: target,
      goldCommandNames: target.map((c) => c.command),
      intent,
    });
  };

  let tempoRelSeen = false;
  const panRelSeen = new Set<string>();
  for (let i = 0; i < cmds.length && out.length < max; i++) {
    const c = cmds[i];
    if (c.command === "set_tempo") {
      push(`set the tempo to ${c.args.bpm}`, i, [c]);
      // TRUE relative tempo task (sibling of the volume convention): the setup
      // includes this absolute set, gold = current + delta.
      const cur = Number(c.args.bpm);
      if (!tempoRelSeen && Number.isFinite(cur)) {
        tempoRelSeen = true;
        const mv = RELATIVE_TEMPO_MOVES[out.length % RELATIVE_TEMPO_MOVES.length];
        const target = cur + mv.delta;
        if (target >= 40 && target <= 300)
          push(mv.phrase(), i + 1, [{ command: "set_tempo", args: { bpm: target } }]);
      }
    }
    else if (c.command === "set_key") push(`set the key to ${c.args.tonic} ${c.args.mode}`, i, [c]);
    else if (c.command === "set_time_signature") push(`change to ${c.args.numerator}/${c.args.denominator} time`, i, [c]);
    else if (MIXER[c.command]) {
      push(MIXER[c.command](nameOf(c.args.trackId), c.args), i, [c]);
      // TRUE relative task: the setup includes this absolute set (current level is
      // known = c.args.db), the gold is current + delta per the fixed convention.
      if (c.command === "set_track_volume" && !relativeSeen.has(String(c.args.trackId))) {
        relativeSeen.add(String(c.args.trackId));
        const mv = RELATIVE_MOVES[out.length % RELATIVE_MOVES.length];
        const cur = Number(c.args.db);
        if (Number.isFinite(cur))
          push(mv.phrase(nameOf(c.args.trackId)), i + 1, [
            { command: "set_track_volume", args: { trackId: c.args.trackId, db: cur + mv.delta } },
          ]);
      }
      // TRUE relative pan task (same class): gold = current + delta, in [-1, 1].
      if (c.command === "set_track_pan" && !panRelSeen.has(String(c.args.trackId))) {
        panRelSeen.add(String(c.args.trackId));
        const mv = RELATIVE_PAN_MOVES[out.length % RELATIVE_PAN_MOVES.length];
        const cur = Number(c.args.pan);
        const target = Math.round((cur + mv.delta) * 100) / 100;
        if (Number.isFinite(cur) && Math.abs(target) <= 1)
          push(mv.phrase(nameOf(c.args.trackId)), i + 1, [
            { command: "set_track_pan", args: { trackId: c.args.trackId, pan: target } },
          ]);
      }
    }
    else if (c.command === "add_midi_clip") {
      const name = nameOf(c.args.trackId);
      push(`add a MIDI clip to the "${name}" track`, i, [c]);
      // populate: the clip exists (this add_midi_clip is in the setup); target = its notes.
      const notes: BoundCommand[] = [];
      for (let j = i + 1; j < cmds.length && cmds[j].command === "add_note" && notes.length < maxNotes; j++) notes.push(cmds[j]);
      if (notes.length) push(`write a short pattern into the clip on the "${name}" track`, i + 1, notes);
    }
  }
  return out;
}

// Resolve "$ref" args from env, validate, apply through the mock, and return the
// RESOLVED concrete commands (the assistant target). Operates on the current mock
// session; mirrors gepa/metric.runBound but returns the resolved CommandCalls.
async function resolveApply(cmds: BoundCommand[], env: Map<string, string>): Promise<{ resolved: CommandCall[]; ok: boolean }> {
  const resolved: CommandCall[] = [];
  let ok = true;
  for (const bc of cmds) {
    const args: Record<string, unknown> = {};
    let unbound = false;
    for (const [k, v] of Object.entries(bc.args)) {
      if (typeof v === "string" && v.startsWith("$")) {
        const real = env.get(v.slice(1));
        if (real === undefined) { unbound = true; break; }
        args[k] = real;
      } else args[k] = v;
    }
    if (unbound || !isAgentCallable(bc.command) || validateCommand(bc.command, args)) { ok = false; continue; }
    const res = await mockExecute<CommandResult>({ command: bc.command, args });
    if (res.ok) {
      resolved.push({ command: bc.command, args });
      if (bc.bind) {
        const data = (res.data ?? {}) as Record<string, unknown>;
        const id = data.trackId ?? data.clipId;
        if (typeof id === "string") env.set(bc.bind, id);
      }
    } else ok = false;
  }
  return { resolved, ok };
}

/**
 * Render one raw task into a chat example: replay the setup to get the snapshot
 * the model sees, resolve+apply the target, and assemble the message triple.
 * Returns null if the setup or target doesn't cleanly apply (drops bad data).
 */
export async function renderExample(raw: RawExample): Promise<RenderedExample | null> {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const env = new Map<string, string>();
  const setup = await runBound(raw.startCommands, env);
  if (setup.applied !== setup.total) return null; // broken setup → unusable example
  const snapshotBefore = await mockSnapshot<Snapshot>();

  const { resolved, ok } = await resolveApply(raw.targetCommands, env);
  if (!ok || resolved.length === 0) return null;

  const assistant = JSON.stringify({ intent: raw.intent, commands: resolved });
  const back = parseReply(assistant);
  if (!back.commands || back.commands.length !== resolved.length) return null; // must round-trip

  return {
    id: raw.id,
    sourceId: raw.sourceId,
    goldCommandNames: raw.goldCommandNames,
    messages: [
      { role: "system", content: buildSystemPrompt(DEFAULT_RULES, snapshotBefore) },
      { role: "user", content: raw.utterance },
      { role: "assistant", content: assistant },
    ],
  };
}

/** Replay a setup prefix and return the snapshot the brain would see (for HUH
 *  examples that need a real session state). Null if the setup doesn't apply. */
export async function snapshotForSetup(startCommands: BoundCommand[]): Promise<Snapshot | null> {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const env = new Map<string, string>();
  const setup = await runBound(startCommands, env);
  if (setup.applied !== setup.total) return null;
  return mockSnapshot<Snapshot>();
}

/** Project a harvested/generated Tuple straight into a chat example. The tuple
 *  already carries snapshotBefore + concrete commands, so no replay is needed. */
export function tupleToExample(t: Tuple, idx: number): RenderedExample | null {
  if (!t.outcome.appliedClean || !t.outcome.replayClean || t.outcome.undone) return null;
  if (!t.utterance.trim()) return null;
  const commands = t.commands.filter((c) => c.agentCallable && c.ok).map((c) => ({ command: c.command, args: c.args }));
  if (commands.length === 0) return null;
  const assistant = JSON.stringify({ intent: "ACK_GOT_IT", commands });
  if (!parseReply(assistant).commands?.length) return null;
  return {
    id: `tuple#${idx}`,
    sourceId: "tuples",
    goldCommandNames: commands.map((c) => c.command),
    messages: [
      { role: "system", content: buildSystemPrompt(DEFAULT_RULES, t.snapshotBefore) },
      { role: "user", content: t.utterance },
      { role: "assistant", content: assistant },
    ],
  };
}

// A small set of deliberately under-specified asks → the model should DEFER
// (intent HUH, no commands) so SFT doesn't make it over-act. Rendered against a
// real snapshot drawn from the corpus.
const HUH_UTTERANCES = ["make it better", "do something cool", "fix it", "you decide", "make it sound professional"];

/** Build HUH/defer examples from snapshots harvested out of rendered positives. */
export function huhExamples(snapshots: Snapshot[], limit: number): RenderedExample[] {
  const out: RenderedExample[] = [];
  for (let i = 0; i < snapshots.length && out.length < limit; i++) {
    const utterance = HUH_UTTERANCES[i % HUH_UTTERANCES.length];
    const assistant = JSON.stringify({ intent: "HUH", say: "tell me what to change" });
    out.push({
      id: `huh#${out.length}`,
      sourceId: "huh",
      goldCommandNames: [],
      messages: [
        { role: "system", content: buildSystemPrompt(DEFAULT_RULES, snapshots[i]) },
        { role: "user", content: utterance },
        { role: "assistant", content: assistant },
      ],
    });
  }
  return out;
}

// ── splitting ────────────────────────────────────────────────────────────────
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export type Split = { train: RenderedExample[]; valid: RenderedExample[]; test: RenderedExample[] };

/** Deterministic split GROUPED BY sourceId (all examples of one project land in
 *  the same split — no train/test leakage across a project). Whole sources are
 *  greedily assigned to the least-filled split (by count/target ratio), so small
 *  corpora still get non-empty valid/test buckets instead of an all-or-nothing
 *  modulo bucketing. */
export function splitBySource(examples: RenderedExample[], ratios: [number, number, number], seed: number): Split {
  const total = examples.length;
  const target = { train: (total * ratios[0]) / 100, valid: (total * ratios[1]) / 100, test: (total * ratios[2]) / 100 };
  const groups = new Map<string, RenderedExample[]>();
  for (const e of examples) {
    const g = groups.get(e.sourceId);
    if (g) g.push(e); else groups.set(e.sourceId, [e]);
  }
  const sources = [...groups.keys()].sort((a, b) => hashStr(`${seed}:${a}`) - hashStr(`${seed}:${b}`) || (a < b ? -1 : 1));
  const split: Split = { train: [], valid: [], test: [] };
  const count = { train: 0, valid: 0, test: 0 };
  const keys = ["train", "valid", "test"] as const;
  for (const s of sources) {
    const g = groups.get(s)!;
    const pick = keys.filter((k) => target[k] > 0).sort((a, b) => count[a] / target[a] - count[b] / target[b])[0] ?? "train";
    split[pick].push(...g);
    count[pick] += g.length;
  }
  return split;
}

/** Serialize rendered examples to chat JSONL ({"messages":[...]}). */
export function toJsonl(examples: RenderedExample[]): string {
  return examples.map((e) => JSON.stringify({ messages: e.messages })).join("\n") + (examples.length ? "\n" : "");
}

/** Eval JSONL for the verifier (gepa/metric.evaluate): id/utterance/startCommands/
 *  goldCommandNames — only importer-slice raws have startCommands. */
export function evalJsonl(raws: RawExample[]): string {
  const rows = raws.map((r) => ({ id: r.id, utterance: r.utterance, startCommands: r.startCommands, goldCommandNames: r.goldCommandNames }));
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}
