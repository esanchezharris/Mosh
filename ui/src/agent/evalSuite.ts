// The autonomous agentic eval: a golden set of natural-language asks, each with a
// machine-checkable rubric for "did the brain plan the RIGHT valid commands?". This
// is the bar an LLM has to clear before a human spends ears on it. Shared by the
// gated quick test (brainEval.test.ts) and the multi-model matrix runner
// (scripts/evalMatrix.mts) so there's ONE source of truth for what "correct" means.
//
// Pure — imports only the catalog validator + the reply parser, no bridge/store.
import type { Snapshot } from "../types";
import { validateCommand } from "./commands";
import { parseReply } from "./parseReply";

/** Plugins the eval pretends are installed, injected into the prompt so plugin-by-name is testable. */
export const EVAL_PLUGINS = ["OTT", "Vital", "Pro-Q 3", "Valhalla VintageVerb"];

/** The fixed session every case reasons over (real ids the brain must reuse). */
export const EVAL_SNAPSHOT = {
  session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 },
  tracks: [
    { id: "t-drums", name: "Drums", volumeDb: 0, mute: false, solo: false, clips: [{ id: "c-dr1", type: "wave", start: 0 }] },
    { id: "t-bass", name: "Bass", volumeDb: -3, mute: false, solo: false, clips: [] },
  ],
} as unknown as Snapshot;

type Cmd = { command: string; args?: Record<string, unknown> };
type Reply = { intent?: string; commands: Cmd[] };

const find = (cs: Cmd[], name: string) => cs.find((c) => c.command === name);
const n = (v: unknown) => (typeof v === "number" ? v : NaN);
const REAL_IDS = ["t-drums", "t-bass"];

export type EvalCase = {
  id: string;
  ask: string;
  want: string; // human description of the rubric, for the report
  check: (r: Reply) => boolean;
};

export const EVAL_CASES: EvalCase[] = [
  { id: "create-track", ask: "make a new track called Keys", want: "create_track with name ~ Keys",
    check: (r) => { const c = find(r.commands, "create_track"); return !!c && /key/i.test(String(c.args?.name ?? "")); } },
  { id: "tempo", ask: "set the tempo to 90 bpm", want: "set_tempo bpm=90",
    check: (r) => n(find(r.commands, "set_tempo")?.args?.bpm) === 90 },
  { id: "mute-named", ask: "mute the bass", want: "set_track_mute t-bass true",
    check: (r) => { const c = find(r.commands, "set_track_mute"); return c?.args?.trackId === "t-bass" && c?.args?.mute === true; } },
  { id: "volume-named", ask: "turn the drums down a bit", want: "set_track_volume on t-drums, lower (db<0)",
    check: (r) => { const c = find(r.commands, "set_track_volume"); return c?.args?.trackId === "t-drums" && n(c?.args?.db) < 0; } },
  { id: "pan", ask: "pan the bass to the left", want: "set_track_pan t-bass <0",
    check: (r) => { const c = find(r.commands, "set_track_pan"); return c?.args?.trackId === "t-bass" && n(c?.args?.pan) < 0; } },
  { id: "play", ask: "play it", want: "set_transport action toggle|play",
    check: (r) => { const a = find(r.commands, "set_transport")?.args?.action; return a === "toggle" || a === "play"; } },
  { id: "stop", ask: "stop the music", want: "set_transport action stop",
    check: (r) => find(r.commands, "set_transport")?.args?.action === "stop" },
  { id: "solo", ask: "solo the drums", want: "set_track_solo t-drums true",
    check: (r) => { const c = find(r.commands, "set_track_solo"); return c?.args?.trackId === "t-drums" && c?.args?.solo === true; } },
  { id: "undo", ask: "undo that", want: "undo",
    check: (r) => !!find(r.commands, "undo") },
  { id: "save", ask: "save the project", want: "save",
    check: (r) => !!find(r.commands, "save") },
  { id: "plugin-by-name", ask: "put OTT on the drums", want: "load_plugin t-drums pluginId ~ OTT",
    check: (r) => { const c = find(r.commands, "load_plugin"); return c?.args?.trackId === "t-drums" && /ott/i.test(String(c?.args?.pluginId ?? "")); } },
  { id: "multi-step", ask: "make a track called Lead and set the tempo to 100", want: "create_track(Lead) + set_tempo(100)",
    check: (r) => { const t = find(r.commands, "create_track"); return !!t && /lead/i.test(String(t.args?.name ?? "")) && n(find(r.commands, "set_tempo")?.args?.bpm) === 100; } },
  { id: "neural", ask: "add a guitar amp to the bass", want: "add_neural_insert on t-bass",
    check: (r) => find(r.commands, "add_neural_insert")?.args?.trackId === "t-bass" },
  { id: "loop-region", ask: "turn on looping", want: "set_transport with loop=true",
    check: (r) => find(r.commands, "set_transport")?.args?.loop === true },
  // ── restraint / anti-hallucination ──────────────────────────────────────
  { id: "clarify-vague", ask: "do the thing", want: "intent HUH, no commands",
    check: (r) => r.intent === "HUH" && r.commands.length === 0 },
  { id: "no-fake-id", ask: "delete track number 7", want: "does NOT remove a made-up track id",
    check: (r) => { const c = find(r.commands, "remove_track"); return !c || REAL_IDS.includes(String(c.args?.trackId)); } },
];

/** Any emitted command that isn't in the catalog / has bad arg types = a hallucination. */
export function replyHallucinates(commands: Cmd[]): boolean {
  return commands.some((c) => validateCommand(c.command, c.args ?? {}) !== null);
}

/** Score one case against a raw LLM reply string. */
export function scoreReply(c: EvalCase, content: string): { pass: boolean; hallucination: boolean; emitted: string[]; intent?: string } {
  const r = parseReply(content);
  const commands = (r.commands ?? []) as Cmd[];
  const hallucination = replyHallucinates(commands);
  const pass = !hallucination && c.check({ intent: r.intent, commands });
  return { pass, hallucination, emitted: commands.map((x) => x.command), intent: r.intent };
}
