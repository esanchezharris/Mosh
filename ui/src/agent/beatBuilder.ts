// ── Structured beat-build loop (Option A) ────────────────────────────────────
// The "agent loop that actually works." The earlier multi-turn audition (drive the
// Moshi persona with terse chat turns) hit a hard wall: a small/cloud model asked
// "add an 808 bassline" either DEFERS (intent HUH, 0 commands) or emits an empty-clip
// SKELETON (create_track + add_midi_clip, no notes) → a silent render. Two root
// causes: (1) the model juggles ids + the {command,args} JSON schema + musicality all
// at once, and (2) the Moshi persona prompt literally tells it to emote and to "set
// intent HUH and ask" — it rewards deferral.
//
// This module attacks the wall head-on with the four levers:
//   1. EXPLICIT STEP DECOMPOSITION — the harness owns the deterministic structure
//      (tempo, tracks, instruments, clips, ids). The model is never asked to plan a
//      build or invent ids; it only fills ONE bounded musical slot at a time (the note
//      pattern for kick, snare, hats, bass, melody …).
//   2. COMMAND VALIDATION + RETRY — each slot's reply is validated (JSON shape + a
//      per-slot content contract: pitch range, in-bounds starts, note count). On
//      failure the model is re-prompted with the exact rejection reason, up to N times.
//   3. FORCING NOTE CONTENT — a slot is only satisfied with ≥minNotes valid notes. If
//      the model still fails after retries, a deterministic, genre-appropriate fallback
//      pattern is applied so the render is NEVER silent — and `fallbackUsed` is recorded
//      so the measurement of "did the model actually contribute" stays honest.
//   4. STRUCTURED OUTPUT — a minimal music-only system prompt (NOT the emote-happy
//      persona) demands a bare JSON object; cloud sets response_format, and a balanced-
//      brace extractor strips any stray preamble/emote/`<think>` the model still adds.
//
// Pure + bridge-free (like brainCore): it drives an injected BeatSink (mock, or a
// run-script recorder) and an injected BrainFn, so it is unit-testable and reusable by
// the app and the offline audition harness alike.

import { validateCommand } from "./commands";
import type { AgentCommandCall } from "./executor";
import type { BeatPalette } from "./palette";
export type { AgentCommandCall } from "./executor";

// ── note / spec types ─────────────────────────────────────────────────────────

export type Note = { pitch: number; start: number; length: number; velocity: number };

/** One instrument voice the model fills (a note pattern). Drums of the same track
 *  share a single clip (kick/snare/hats are pitches in one MIDI clip). */
export type Slot = {
  id: string; // "kick" | "snare" | "hats" | "bass" | "melody" …
  label: string; // human label for the prompt
  role: "drum" | "melodic";
  // drum slots: pitch is FIXED to the GM pad (kick 36 …); the model only chooses
  // rhythm + velocity. melodic slots: the model chooses pitch within the range.
  fixedPitch?: number;
  pitchRange: [number, number];
  minNotes: number;
  promptHint: string; // genre/role guidance for the model
  fallback: (ctx: BeatContext) => Note[]; // deterministic non-silent pattern
};

export type TrackSpec = {
  name: string;
  kind: "drum" | "audio"; // "drum" → sampler+kit auto-loads; "audio" → 4OSC auto-loads
  gainDb?: number; // headroom/gain staging so the summed mix doesn't clip
  slots: Slot[]; // all write into this track's single MIDI clip
};

export type BeatSpec = {
  id: string;
  genre: string;
  tempo: number; // the deterministic fallback tempo
  tempoRange: [number, number];
  key: { tonic: string; mode: string };
  bars: number;
  tracks: TrackSpec[];
};

export type BeatContext = {
  spec: BeatSpec;
  tempo: number;
  beatsTotal: number; // bars * 4 (4/4)
};

// ── reporting ───────────────────────────────────────────────────────────────

export type SlotReport = {
  slot: string;
  track: string;
  notesRequested: number; // notes the model/fallback produced
  notesApplied: number; // add_note commands that succeeded
  modelContributed: boolean; // model produced ≥minNotes valid notes (no fallback)
  fallbackUsed: boolean;
  retries: number;
  rejects: string[]; // rejection reasons across attempts (honest audit trail)
};

export type BuildResult = {
  spec: BeatSpec;
  tempo: number;
  tempoFromModel: boolean;
  steps: SlotReport[];
  ok: boolean; // structure built AND every slot has ≥minNotes notes
  error?: string; // first structural failure, if any
  totalNotes: number;
  modelSlots: number; // slots the model satisfied
  totalSlots: number;
  modelNotePct: number; // modelSlots / totalSlots
};

// ── sink / brain interfaces (injected — keeps this module pure) ───────────────

export type ExecOutcome = { ok: boolean; id?: string; error?: string };

/** Executes a planned command and returns the engine-assigned id (for create_track
 *  and clip commands). The harness's sink also records a run-script line per call. */
export interface BeatSink {
  execute(call: AgentCommandCall): Promise<ExecOutcome>;
}

/** Calls the model. `json:true` asks the harness to request structured output
 *  (response_format) where the backend supports it. Returns the raw text. */
export type BrainFn = (
  messages: { role: string; content: string }[],
  opts: { json: boolean },
) => Promise<string>;

export type BuildOpts = {
  maxRetries?: number; // re-prompts per slot before fallback (default 2)
  refineTempo?: boolean; // ask the model to pick the BPM within range (default true)
  extraSystem?: string; // an evolvable global directive appended to the note system prompt (GEPA optimizes this)
  palette?: BeatPalette; // when present, put REAL sounds on every track (kit + melodic 808). Omitted → stock auto-load (back-compat).
  productionSeed?: number; // deterministic sound-pick seed (default 0)
  log?: (m: string) => void;
};

// ── production plan (real sounds per track) ───────────────────────────────────
// completeness is HARNESS-guaranteed (every triggered drum pad + the 808 get a real
// one-shot); which exact sound is chosen is a deterministic palette pick now (the
// taste/region-of-preference is learned later, #56). Drum-pad GM note → palette role.

const PAD_ROLE: Record<number, string> = { 36: "kick", 38: "snare", 40: "snare", 39: "clap", 42: "hat", 44: "hat", 46: "hat", 49: "hat" };

export type ProdPad = { note: number; path: string; role: string };
export type TrackProduction =
  | { kind: "drum"; pads: ProdPad[] }
  | { kind: "melodic808"; note: number; path: string; rootNote: number | null }
  | { kind: "none" };

const isBassTrack = (track: TrackSpec): boolean => track.slots.some((s) => s.id === "bass");

/** Decide the real sounds for a track from the palette (deterministic by seed). Drum →
 *  a real one-shot per TRIGGERED pad; bass → a real 808 played melodically; else none. */
export function planTrackProduction(track: TrackSpec, palette: BeatPalette, seed: number): TrackProduction {
  if (track.kind === "drum") {
    const pads: ProdPad[] = [];
    for (const slot of track.slots) {
      if (slot.role !== "drum" || slot.fixedPitch == null) continue;
      const role = PAD_ROLE[slot.fixedPitch];
      if (!role) continue;
      const item = palette.pick(role, seed);
      if (item) pads.push({ note: slot.fixedPitch, path: item.path, role });
    }
    return pads.length ? { kind: "drum", pads } : { kind: "none" };
  }
  if (isBassTrack(track)) {
    const item = palette.pick("808", seed);
    if (item) return { kind: "melodic808", note: item.rootNote ?? 36, path: item.path, rootNote: item.rootNote };
  }
  return { kind: "none" }; // melody/lead → 4OSC (the auto default); a real synth is a live-app load_plugin choice
}

/** Trim notes so none overlaps the next note-on — the engine's monophonic 808 must not
 *  ring over itself ("make sure it doesn't overlap with itself"). Deterministic. */
export function monophonicize(notes: Note[], gap = 0.02): Note[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    const maxLen = sorted[i + 1].start - sorted[i].start - gap;
    if (maxLen > 0 && sorted[i].length > maxLen) sorted[i] = { ...sorted[i], length: maxLen };
  }
  return sorted;
}

// ── structured-output system prompt (music only — NOT the emote persona) ──────

const NOTE_SYSTEM = [
  "You are an expert beat-making engine that writes MIDI note patterns.",
  "Reply with ONE JSON object and NOTHING ELSE — no prose, no emotes, no markdown fences, no explanation:",
  '{"notes":[{"pitch":<int 0-127>,"start":<number, beats>,"length":<number, beats>,"velocity":<int 1-127>}]}',
  "Timing is 4/4. `start` is the beat offset from 0 (0 = bar 1 beat 1; beat 4 of bar 2 is start 7).",
  "Make it musical and genre-appropriate. Do not return an empty notes array.",
].join("\n");

const TEMPO_SYSTEM = [
  "You are an expert music producer. Choose a tempo.",
  'Reply with ONE JSON object and NOTHING ELSE: {"bpm":<integer>}',
].join("\n");

// ── JSON extraction (robust to emote / <think> / fence preambles) ─────────────

/** Extract the first balanced {…} object so the JSON parses regardless of a
 *  `_chirp_` emote, a `<think>…</think>` block, or ```json fences around it. */
export function extractJsonObject(s: string): string {
  const str = String(s ?? "");
  const i = str.indexOf("{");
  if (i < 0) return str;
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < str.length; k++) {
    const c = str[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) return str.slice(i, k + 1); }
  }
  return str.slice(i);
}

function parseNotes(raw: string): Note[] | null {
  try {
    const o = JSON.parse(extractJsonObject(raw)) as { notes?: unknown };
    if (!Array.isArray(o.notes)) return null;
    return o.notes
      .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
      .map((n) => ({
        pitch: Number((n as Record<string, unknown>).pitch),
        start: Number((n as Record<string, unknown>).start),
        length: Number((n as Record<string, unknown>).length),
        velocity: Number((n as Record<string, unknown>).velocity),
      }));
  } catch {
    return null;
  }
}

// ── per-slot validation + the forcing contract ───────────────────────────────

export type SlotValidation = { notes: Note[]; reason?: string };

/** Validate + repair the model's notes against the slot contract. Drum slots force
 *  the GM pad pitch (the model only chooses rhythm/velocity). Out-of-range pitches
 *  are clamped (melodic) and out-of-bounds starts are dropped. Returns the kept notes
 *  and, when too few survive, a precise reason for the retry prompt. */
export function validateSlotNotes(slot: Slot, ctx: BeatContext, notes: Note[] | null): SlotValidation {
  if (notes === null) return { notes: [], reason: "reply was not the JSON object {\"notes\":[…]}" };
  const kept: Note[] = [];
  for (const n of notes) {
    if (!Number.isFinite(n.start) || n.start < 0 || n.start >= ctx.beatsTotal) continue; // out of the loop window
    const length = Number.isFinite(n.length) && n.length > 0 ? Math.min(n.length, ctx.beatsTotal) : (slot.role === "drum" ? 0.25 : 1);
    const velocity = Number.isFinite(n.velocity) ? Math.max(1, Math.min(127, Math.round(n.velocity))) : 100;
    let pitch: number;
    if (slot.role === "drum") {
      pitch = slot.fixedPitch ?? slot.pitchRange[0]; // a kick is always 36 — never trust the model's drum pitch
    } else {
      if (!Number.isFinite(n.pitch)) continue;
      pitch = Math.max(slot.pitchRange[0], Math.min(slot.pitchRange[1], Math.round(n.pitch)));
    }
    kept.push({ pitch, start: n.start, length, velocity });
  }
  if (kept.length < slot.minNotes) {
    const reason = kept.length === 0
      ? `0 valid notes (need ≥${slot.minNotes}; every start must be a number in [0, ${ctx.beatsTotal}))`
      : `only ${kept.length} valid notes (need ≥${slot.minNotes}; check starts are in [0, ${ctx.beatsTotal}))`;
    return { notes: kept, reason };
  }
  return { notes: kept };
}

// ── prompts ───────────────────────────────────────────────────────────────────

function slotUserPrompt(slot: Slot, ctx: BeatContext): string {
  const { spec, tempo, beatsTotal } = ctx;
  const pitchLine = slot.role === "drum"
    ? `This is a DRUM voice on MIDI pad ${slot.fixedPitch}; pitch is fixed — you choose the RHYTHM (start beats) and velocity.`
    : `This is a MELODIC voice; choose pitches in MIDI ${slot.pitchRange[0]}–${slot.pitchRange[1]} (key ${spec.key.tonic} ${spec.key.mode}).`;
  return [
    `Write the ${slot.label} for a ${spec.genre} beat.`,
    `Tempo ${tempo} BPM, ${spec.bars} bars = ${beatsTotal} beats total, 4/4.`,
    pitchLine,
    slot.promptHint,
    `Requirements: at least ${slot.minNotes} notes; every "start" a number in [0, ${beatsTotal}); "length" and "velocity" set per note.`,
    `Return ONLY the JSON object {"notes":[…]}.`,
  ].join("\n");
}

// ── the build loop ─────────────────────────────────────────────────────────────

async function chooseTempo(spec: BeatSpec, brain: BrainFn, maxRetries: number): Promise<{ tempo: number; fromModel: boolean }> {
  const [lo, hi] = spec.tempoRange;
  const user = `Choose a tempo in BPM for a ${spec.genre} beat. It must be an integer between ${lo} and ${hi}. Reply ONLY {"bpm":<integer>}.`;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let raw = "";
    try { raw = await brain([{ role: "system", content: TEMPO_SYSTEM }, { role: "user", content: user }], { json: true }); } catch { raw = ""; }
    try {
      const bpm = Number((JSON.parse(extractJsonObject(raw)) as { bpm?: unknown }).bpm);
      if (Number.isFinite(bpm) && bpm >= lo && bpm <= hi) return { tempo: Math.round(bpm), fromModel: true };
    } catch { /* retry */ }
  }
  return { tempo: spec.tempo, fromModel: false };
}

/** Drive one slot: prompt → parse → validate → retry → fallback. Returns the notes to
 *  apply plus an honest report of how they were obtained. */
async function fillSlot(slot: Slot, ctx: BeatContext, brain: BrainFn, maxRetries: number, extraSystem = ""): Promise<{ notes: Note[]; report: Omit<SlotReport, "track" | "notesApplied"> }> {
  const rejects: string[] = [];
  let retries = 0;
  const baseUser = slotUserPrompt(slot, ctx);
  const system = extraSystem ? `${NOTE_SYSTEM}\n${extraSystem}` : NOTE_SYSTEM;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const messages = [{ role: "system", content: system }, { role: "user", content: baseUser }];
    if (attempt > 0) {
      // corrective re-prompt: tell the model exactly why the last reply was rejected
      messages.push({ role: "assistant", content: "(rejected)" });
      messages.push({
        role: "user",
        content: `Your previous reply was rejected: ${rejects[rejects.length - 1]}. Return ONLY {"notes":[…]} with at least ${slot.minNotes} valid notes, every "start" a number in [0, ${ctx.beatsTotal}).`,
      });
    }
    let raw = "";
    try { raw = await brain(messages, { json: true }); } catch (e) { raw = ""; rejects.push(`brain error: ${(e as Error).message}`); retries = attempt; continue; }
    const v = validateSlotNotes(slot, ctx, parseNotes(raw));
    if (!v.reason) {
      return { notes: v.notes, report: { slot: slot.id, notesRequested: v.notes.length, modelContributed: true, fallbackUsed: false, retries: attempt, rejects } };
    }
    rejects.push(v.reason);
    retries = attempt;
  }
  // forcing: never leave the slot silent — deterministic genre fallback
  const fb = slot.fallback(ctx);
  return { notes: fb, report: { slot: slot.id, notesRequested: fb.length, modelContributed: false, fallbackUsed: true, retries, rejects } };
}

function clipLengthSeconds(ctx: BeatContext): number {
  return (ctx.beatsTotal * 60) / ctx.tempo;
}

/** Build a complete, audible beat by driving `brain` through the decomposed pipeline,
 *  issuing validated commands through `sink`. Structure is deterministic; only the
 *  musical content comes from the model (with a forced fallback). */
export async function buildBeat(spec: BeatSpec, brain: BrainFn, sink: BeatSink, opts: BuildOpts = {}): Promise<BuildResult> {
  const maxRetries = opts.maxRetries ?? 2;
  const log = opts.log ?? (() => {});
  const beatsTotal = spec.bars * 4;

  // 1. tempo — the model's first musical decision (validated; fallback = spec.tempo)
  const { tempo, fromModel: tempoFromModel } = opts.refineTempo === false
    ? { tempo: spec.tempo, fromModel: false }
    : await chooseTempo(spec, brain, maxRetries);
  const ctx: BeatContext = { spec, tempo, beatsTotal };
  log(`tempo ${tempo} BPM (${tempoFromModel ? "model" : "default"})`);

  const issue = async (call: AgentCommandCall): Promise<ExecOutcome> => {
    const err = validateCommand(call.command, call.args ?? {});
    if (err) return { ok: false, error: err }; // belt-and-suspenders; harness calls are well-formed
    return sink.execute(call);
  };

  await issue({ command: "set_tempo", args: { bpm: tempo } });
  await issue({ command: "set_key", args: { tonic: spec.key.tonic, mode: spec.key.mode } });

  const steps: SlotReport[] = [];
  let structuralError: string | undefined;

  const prodSeed = opts.productionSeed ?? 0;

  for (const track of spec.tracks) {
    // 2. deterministic structure: track (instrument auto-loads) + one MIDI clip
    const tRes = await issue({ command: "create_track", args: { name: track.name, type: track.kind } });
    if (!tRes.ok || !tRes.id) { structuralError = `create_track "${track.name}" failed: ${tRes.error ?? "no id"}`; break; }
    const trackId = tRes.id;
    if (track.gainDb != null) await issue({ command: "set_track_volume", args: { trackId, db: track.gainDb } });

    // 2b. PRODUCTION — put real sounds on the track. The 808 sampler must be assigned
    // BEFORE add_midi_clip so the clip's default-instrument auto-load is a no-op (an
    // instrument already present) — else 4OSC would double the 808.
    const prod: TrackProduction = opts.palette ? planTrackProduction(track, opts.palette, prodSeed) : { kind: "none" };
    if (prod.kind === "drum") {
      for (const p of prod.pads) await issue({ command: "assign_sample", args: { trackId, note: p.note, file: p.path, name: p.role } });
    } else if (prod.kind === "melodic808") {
      await issue({ command: "assign_sample", args: { trackId, note: prod.note, file: prod.path, name: "808", mode: "melodic" } });
    }

    const cRes = await issue({ command: "add_midi_clip", args: { trackId, start: 0, length: clipLengthSeconds(ctx) } });
    if (!cRes.ok || !cRes.id) { structuralError = `add_midi_clip on "${track.name}" failed: ${cRes.error ?? "no id"}`; break; }
    const clipId = cRes.id;

    // 3. model fills each slot's note pattern (validated/retried/forced) → add_note
    for (const slot of track.slots) {
      const { notes, report } = await fillSlot(slot, ctx, brain, maxRetries, opts.extraSystem ?? "");
      // a melodic 808 is monophonic — trim so notes never overlap themselves
      const toApply = prod.kind === "melodic808" ? monophonicize(notes) : notes;
      let applied = 0;
      for (const n of toApply) {
        const r = await issue({ command: "add_note", args: { clipId, pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity } });
        if (r.ok) applied++;
      }
      log(`  ${track.name}/${slot.id}: ${applied} notes ${report.fallbackUsed ? "(FALLBACK)" : `(model, ${report.retries} retr)`}${prod.kind !== "none" ? ` [${prod.kind === "drum" ? `${prod.pads.length} real pads` : "real 808"}]` : ""}`);
      steps.push({ ...report, track: track.name, notesApplied: applied });
    }
  }

  const totalNotes = steps.reduce((a, s) => a + s.notesApplied, 0);
  const modelSlots = steps.filter((s) => s.modelContributed).length;
  const totalSlots = steps.length;
  const everySlotFilled = steps.length > 0 && steps.every((s) => s.notesApplied >= 1);
  return {
    spec,
    tempo,
    tempoFromModel,
    steps,
    ok: !structuralError && everySlotFilled,
    error: structuralError,
    totalNotes,
    modelSlots,
    totalSlots,
    modelNotePct: totalSlots ? modelSlots / totalSlots : 0,
  };
}

// ── mock-free recipe build (for parallel verification / GEPA eval) ─────────────
// buildBeat drives the global bridge.mock (singleton) for real ids → it is NOT safe to
// run many concurrently. The verifier only needs the NOTE CONTENT, so buildRecipe drives
// the same slot-filling (validate/retry/force) but assembles a plain Recipe directly — no
// sink, no mock, no shared state → safe to fan out. Roles map straight to the verifier's.

export type RecipeRole = "drums" | "bass" | "melody";
export type BuiltRecipeTrack = { name: string; role: RecipeRole; notes: Note[] };
export type BuiltRecipe = {
  tempo: number; bars: number; key: { tonic: string; mode: string };
  tracks: BuiltRecipeTrack[]; modelSlots: number; totalSlots: number;
};

export async function buildRecipe(spec: BeatSpec, brain: BrainFn, opts: BuildOpts = {}): Promise<BuiltRecipe> {
  const maxRetries = opts.maxRetries ?? 1;
  const beatsTotal = spec.bars * 4;
  const tempo = opts.refineTempo === false ? spec.tempo : (await chooseTempo(spec, brain, maxRetries)).tempo;
  const ctx: BeatContext = { spec, tempo, beatsTotal };
  const tracks: BuiltRecipeTrack[] = [];
  let modelSlots = 0, totalSlots = 0;
  for (const t of spec.tracks) {
    const role: RecipeRole = t.kind === "drum" ? "drums" : t.slots[0]?.id === "bass" ? "bass" : "melody";
    const notes: Note[] = [];
    for (const slot of t.slots) {
      const { notes: ns, report } = await fillSlot(slot, ctx, brain, maxRetries, opts.extraSystem ?? "");
      notes.push(...ns);
      totalSlots++;
      if (report.modelContributed) modelSlots++;
    }
    tracks.push({ name: t.name, role, notes });
  }
  return { tempo, bars: spec.bars, key: spec.key, tracks, modelSlots, totalSlots };
}
