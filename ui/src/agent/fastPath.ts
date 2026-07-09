// The deterministic, state-aware phrase matcher. Runs BEFORE the LLM: a confident,
// whole-utterance match to a known unambiguous phrase produces a FastAction executed
// locally (no API); anything ambiguous returns null → the LLM brain handles it.
// Adapts the owner's DAWN FSM/fuzzy logic (state-gated rules + token-set fuzzy match).
import { tokenSetScore } from "./fuzzy";

export type Mode = "idle" | "recording" | "reviewing";
export type FastAction =
  | { kind: "commands"; commands: { command: string; args?: Record<string, unknown> }[]; intent: string; say?: string }
  | { kind: "enterRecord"; bar?: number; intent: string; say?: string }
  | { kind: "stopRecord"; intent: string; say?: string }
  | { kind: "keepTake"; intent: string; say?: string }
  | { kind: "navTake"; delta: 1 | -1; intent: string; say?: string };
export type TrackLite = { id: string; name: string; mute?: boolean; solo?: boolean };
export type FastCtx = { mode: Mode; tempo: number; timeSigNum: number; tracks?: TrackLite[] };

const THRESHOLD = 0.78;
const FILLER = /\b(uh+|um+|like|okay|ok|please|alright|just|so|hey|moshi)\b/g;
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, sixteen: 16, twenty: 20, thirty: 30, thirtytwo: 32 };

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(FILLER, " ").replace(/\s+/g, " ").trim();
}

function extractBar(norm: string): number | undefined {
  const m = norm.match(/(?:bar|measure|at|from)\s+(?:bar\s+|measure\s+)?([a-z0-9]+)/);
  if (!m) return undefined;
  const raw = m[1];
  if (/^\d+$/.test(raw)) return Number(raw);
  return WORD_NUM[raw];
}

// A rule: aliases (matched fuzzily) + the modes it's valid in + a builder for the action.
type Rule = { aliases: string[]; modes: Mode[]; build: (norm: string, ctx: FastCtx) => FastAction };
const cmd = (command: string, args: Record<string, unknown>, intent: string, say?: string): FastAction =>
  ({ kind: "commands", commands: [{ command, args }], intent, say });

const RULES: Rule[] = [
  // ── record / take loop ──
  { aliases: ["put me in at", "let me go in at"], modes: ["idle", "reviewing"],
    build: (n) => ({ kind: "enterRecord", bar: extractBar(n), intent: "ACK_WORKING", say: "you're in" }) },
  { aliases: ["put me in", "come in", "lets go", "start recording", "record", "im ready", "punch in"], modes: ["idle", "reviewing"],
    build: (n) => ({ kind: "enterRecord", bar: extractBar(n), intent: "ACK_WORKING", say: "you're in" }) },
  { aliases: ["keep that take", "keep that", "keep it", "keep", "save that", "thats the one", "thats a keeper", "thats good", "yeah"], modes: ["reviewing"],
    build: () => ({ kind: "keepTake", intent: "DONE", say: "got it" }) },
  { aliases: ["do that again", "let me do that again", "try that again", "again", "one more", "another take", "nah", "no"], modes: ["reviewing"],
    build: () => ({ kind: "enterRecord", intent: "ACK_WORKING", say: "again" }) },
  { aliases: ["let me hear that again", "play that back", "run it back", "let me hear that", "playback"], modes: ["reviewing"],
    build: () => cmd("set_transport", { action: "to_start" }, "ACK_GOT_IT", "here") },
  { aliases: ["next take", "the next one", "let me hear the next one"], modes: ["reviewing"],
    build: () => ({ kind: "navTake", delta: 1, intent: "ACK_GOT_IT", say: "next" }) },
  { aliases: ["previous take", "go back a take", "the one before", "last take"], modes: ["reviewing"],
    build: () => ({ kind: "navTake", delta: -1, intent: "ACK_GOT_IT", say: "back" }) },
  // ── transport (global) ──
  { aliases: ["play", "play it", "play that"], modes: ["idle", "reviewing"],
    build: () => cmd("set_transport", { action: "toggle" }, "ACK_GOT_IT") },
  { aliases: ["stop", "thats enough", "cut", "hold on", "wait"], modes: ["idle", "recording", "reviewing"],
    build: (_, ctx) => (ctx.mode === "recording" ? { kind: "stopRecord", intent: "ACK_GOT_IT" } : cmd("set_transport", { action: "stop" }, "ACK_GOT_IT")) },
  { aliases: ["from the top", "take it from the top", "back to the start", "to the start"], modes: ["idle", "reviewing"],
    build: () => cmd("set_transport", { action: "to_start" }, "ACK_GOT_IT") },
  { aliases: ["loop it", "turn on looping", "loop this"], modes: ["idle", "reviewing"],
    build: () => cmd("set_transport", { action: "toggle", loop: true }, "ACK_GOT_IT") },
  // ── history / save (global) ──
  { aliases: ["undo", "undo that", "scratch that"], modes: ["idle", "reviewing"], build: () => cmd("undo", {}, "ACK_GOT_IT") },
  { aliases: ["redo", "redo that"], modes: ["idle", "reviewing"], build: () => cmd("redo", {}, "ACK_GOT_IT") },
  { aliases: ["save", "save it", "save the project"], modes: ["idle", "reviewing"], build: () => cmd("save", {}, "DONE", "saved") },
];

function parseTrackNames(s: string): string[] {
  return s
    .replace(/\b(tracks?|channels?)\b/g, " ")
    .split(/\s+and\s+|\s*,\s*|\s*&\s*|\s+plus\s+/)
    .map((x) => x.replace(/^the\s+/, "").trim())
    .filter(Boolean);
}

function matchTrackByName(name: string, tracks: TrackLite[]): TrackLite | null {
  const n = name.trim();
  if (!n) return null;
  let best: { t: TrackLite; s: number } | null = null;
  let tied = false;
  for (const t of tracks) {
    const tn = t.name.toLowerCase();
    const s = tn === n ? 1 : tn.includes(n) || n.includes(tn) ? 0.9 : tokenSetScore(n, tn);
    if (s < 0.8) continue;
    if (!best || s > best.s) {
      best = { t, s };
      tied = false;
      continue;
    }
    if (s === best.s) tied = true;
  }
  return best && !tied ? best.t : null;
}

function resolveAll(names: string[], tracks: TrackLite[]): TrackLite[] | null {
  const out = names.map((n) => matchTrackByName(n, tracks));
  return out.some((t) => !t) || out.length === 0 ? null : (out as TrackLite[]);
}

function matchTrackOp(norm: string, ctx: FastCtx): FastAction | null {
  const tracks = ctx.tracks;
  if (!tracks || tracks.length === 0 || ctx.mode === "recording") return null;

  let m = norm.match(/^(?:mute|kill|drop|cut)\s+(?:everything|all|it all|the rest|everything else)\s+(?:but|except|apart from|other than|besides)\s+(.+)$/);
  if (m) {
    const keep = resolveAll(parseTrackNames(m[1]), tracks);
    if (!keep) return null;
    const keepIds = new Set(keep.map((t) => t.id));
    const commands = tracks
      .filter((t) => !keepIds.has(t.id))
      .map((t) => ({ command: "set_track_mute", args: { trackId: t.id, mute: true } }));
    return commands.length ? { kind: "commands", commands, intent: "ACK_GOT_IT", say: "muted" } : null;
  }

  m = norm.match(/^(mute|unmute)\s+(?:everything|all|it all|all tracks)$/);
  if (m) {
    const mute = m[1] === "mute";
    return {
      kind: "commands",
      commands: tracks.map((t) => ({ command: "set_track_mute", args: { trackId: t.id, mute } })),
      intent: "ACK_GOT_IT",
      say: mute ? "muted" : "unmuted",
    };
  }

  m = norm.match(/^(?:solo|isolate)\s+(.+)$/);
  if (m) {
    const targets = resolveAll(parseTrackNames(m[1]), tracks);
    if (!targets) return null;
    const targetIds = new Set(targets.map((t) => t.id));
    const clearOthers = tracks
      .filter((t) => t.solo && !targetIds.has(t.id))
      .map((t) => ({ command: "set_track_solo", args: { trackId: t.id, solo: false } }));
    return {
      kind: "commands",
      commands: [
        ...clearOthers,
        ...targets.map((t) => ({ command: "set_track_solo", args: { trackId: t.id, solo: true } })),
      ],
      intent: "ACK_GOT_IT",
      say: "soloed",
    };
  }

  m = norm.match(/^(mute|unmute)\s+(.+)$/);
  if (m) {
    const targets = resolveAll(parseTrackNames(m[2]), tracks);
    if (!targets) return null;
    const mute = m[1] === "mute";
    return {
      kind: "commands",
      commands: targets.map((t) => ({ command: "set_track_mute", args: { trackId: t.id, mute } })),
      intent: "ACK_GOT_IT",
      say: mute ? "muted" : "unmuted",
    };
  }

  return null;
}

export function matchFastPath(text: string, ctx: FastCtx): FastAction | null {
  const norm = normalize(text);
  if (!norm) return null;
  const trackOp = matchTrackOp(norm, ctx);
  if (trackOp) return trackOp;
  const uTokens = norm.split(" ");
  let best: { score: number; len: number; rule: Rule } | null = null;
  for (const rule of RULES) {
    if (!rule.modes.includes(ctx.mode)) continue;
    for (const alias of rule.aliases) {
      const a = normalize(alias);
      const score = norm === a ? 1 : tokenSetScore(norm, a);
      if (score < THRESHOLD) continue;
      // token_set_ratio is subset-permissive (a bare "play" scores 1 inside "play the
      // drums and add reverb"). Guard: the utterance may carry at most a couple of tokens
      // beyond the matched alias (e.g. "stop the music", "put me in at bar 8"); a longer
      // tail means it's a real request → let the LLM handle it.
      const aTokens = new Set(a.split(" "));
      const leftover = uTokens.filter((t) => !aTokens.has(t)).length;
      if (leftover > 2) continue;
      if (!best || score > best.score || (score === best.score && a.length > best.len)) best = { score, len: a.length, rule };
    }
  }
  return best ? best.rule.build(norm, ctx) : null;
}
