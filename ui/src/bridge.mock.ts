// ── Browser dev-mock of the MoshOps contract ─────────────────────────────────
// An in-memory backend that implements the SAME execute_command + snapshot +
// events seam the C++ MoshOps exposes (docs/02_MOSHOPS_CONTRACT.md), so the React
// UI runs fully interactive in a plain browser (Vite dev) with no JUCE WebView.
//
// This exists ONLY to make the UI iterable with real DOM/CSS introspection — it
// is NOT the engine and ships nowhere: bridge.ts wires it in solely under
// import.meta.env.DEV when the real native backend is absent. A production
// `vite build` (the bundle staged into Mosh.app) strips it entirely.
//
// Fidelity rule: the mock speaks the contract, not the engine. It returns the
// same { ok, command, data } envelopes, emits snapshot_invalidated on structural
// change and 30 Hz transport while playing, and keeps an undo/redo history — so
// behaviour the UI relies on is exercised, while audio/Tracktion concepts never
// appear (the swappable seam holds on the web side too).

import type { Snapshot, Clip, Track, Transport, CommandResult, RenderLayer, TrainingState, MidiNote, PluginParam, MoshFxReadout, LyricSheet, LyricLine } from "./types";
import { syllablesForWord, countSyllables } from "./lyrics/flowMeter";
import { parseDrumPattern } from "./ui/drumPatternUtil";
import { stepBeats } from "./ui/drumGrid";

export const MOCK_ENABLED: boolean =
  typeof import.meta !== "undefined" &&
  Boolean(import.meta.env?.DEV || import.meta.env?.VITE_MOSH_E2E_MOCK === "1");

// ── seed session ─────────────────────────────────────────────────────────────

const SR = 48000;
let clipSeq = 100;
let trackSeq = 10;
const nextClipId = () => String(++clipSeq);
const nextTrackId = () => String(++trackSeq);
let sectionSeq = 3; // seed uses sec-1..3
const nextSectionId = () => "sec-" + ++sectionSeq;
let annotationSeq = 1; // seed uses ann-1
const nextAnnotationId = () => "ann-" + ++annotationSeq;

function waveClip(name: string, start: number, length: number): Clip {
  return {
    id: nextClipId(),
    name,
    type: "wave",
    start,
    length,
    offset: 0,
    sourceFile: `/mock/${name}.wav`,
    sourceLength: length,
    hasRenderLayer: false,
  };
}

function midiClip(name: string, start: number, length: number, notes: MidiNote[]): Clip {
  return { id: nextClipId(), name, type: "midi", start, length, offset: 0, hasRenderLayer: false, notes };
}

// A recognizable 4/4 rock pattern in GM drum pitches (kick 36 / snare 38 / closed-hat 42)
// so the lane renders as a real drum step-grid (isDrumClip → ClipDrumGrid). start/length
// are in BEATS within the clip (the renderers convert beats→seconds via the tempo map).
function drumPattern(bars: number): MidiNote[] {
  const notes: MidiNote[] = [];
  let i = 0;
  for (let bar = 0; bar < bars; bar++) {
    const b = bar * 4;
    notes.push({ i: i++, pitch: 36, start: b, length: 0.25, velocity: 112 });       // kick — beat 1
    notes.push({ i: i++, pitch: 36, start: b + 2, length: 0.25, velocity: 96 });     // kick — beat 3
    notes.push({ i: i++, pitch: 38, start: b + 1, length: 0.25, velocity: 104 });    // snare — backbeat
    notes.push({ i: i++, pitch: 38, start: b + 3, length: 0.25, velocity: 104 });    // snare — backbeat
    for (let h = 0; h < 8; h++) notes.push({ i: i++, pitch: 42, start: b + h * 0.5, length: 0.2, velocity: 64 }); // hats — 8ths
  }
  return notes;
}

// A simple melodic bass line. Pitches stay BELOW the GM drum range (36–49) so isDrumClip
// is false → the lane renders as MIDI note blocks (ClipMidi), not a drum grid.
function bassLine(bars: number): MidiNote[] {
  const roots = [28, 28, 33, 31]; // E1 · E1 · A1 · G1 (A-minor feel), all < 36
  const notes: MidiNote[] = [];
  let i = 0;
  for (let bar = 0; bar < bars; bar++) {
    const b = bar * 4;
    const p = roots[bar % roots.length];
    notes.push({ i: i++, pitch: p, start: b, length: 1.5, velocity: 102 });
    notes.push({ i: i++, pitch: p, start: b + 2, length: 1, velocity: 90 });
    notes.push({ i: i++, pitch: p + 2, start: b + 3, length: 0.5, velocity: 80 }); // passing tone (stays < 36, off the drum lanes)
  }
  return notes;
}

function seedSnapshot(): Snapshot {
  // Demo-accurate typed seed (dev/preview only): Drums = a drum step-grid (MIDI on a
  // drum track), Bass = MIDI note blocks, Keys = an audio waveform. 8s clips = 16 beats
  // = 4 bars at 120 BPM. Keep exactly 3 tracks (smoke asserts 3).
  const tracks: Track[] = [
    {
      id: nextTrackId(), index: 0, name: "Drums", type: "drum",
      volumeDb: 0, pan: 0, mute: false, solo: false, isInstrument: true,
      clips: [midiClip("loop", 0, 8, drumPattern(4))],
      plugins: [],
    },
    {
      id: nextTrackId(), index: 1, name: "Bass", type: "audio",
      volumeDb: -3, pan: 0, mute: false, solo: false, isInstrument: true,
      clips: [midiClip("sub", 0, 8, bassLine(4))],
      plugins: [],
    },
    {
      id: nextTrackId(), index: 2, name: "Keys", type: "audio",
      volumeDb: -6, pan: 0.2, mute: false, solo: false,
      clips: [waveClip("chords", 2, 6)],
      plugins: [],
    },
  ];
  return {
    schemaVersion: 1,
    session: {
      sampleRate: SR, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
      raveAvailable: true,   // Route C.2 — exercise the "+ RAVE" affordance in dev/e2e
      singVoiceEnrolled: false,  // FMS Phase-3 — dev/e2e exercise the not-enrolled copy
      metronome: false, countInBars: 0, length: 16, editFile: "/mock/session.mosh",
      audioEnabled: true, bitDepth: 24, bufferSize: 512,
      availableCores: 8, audioThreads: 8, audioThreadsAuto: true,
      key: { tonic: "A", mode: "minor" },
    },
    tracks,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
    buses: [],
    sections: [
      { id: "sec-1", name: "Intro", startBeat: 0, endBeat: 8, color: "#9fe1cb" },
      { id: "sec-2", name: "Verse", startBeat: 8, endBeat: 24, color: "#b5d4f4" },
      { id: "sec-3", name: "Hook", startBeat: 24, endBeat: 40, color: "#f4c0d1" },
    ],
    annotations: [
      { id: "ann-1", text: "tighten this transition", beat: 24, color: "#ffd166", author: "you" },
    ],
  };
}

// A blank edit — what the native new_project (createEmptyEdit) yields: valid session
// scaffolding, no tracks, transport parked at zero. Reuses seedSnapshot for the
// session shape so the two stay in lockstep.
function emptySession(): Snapshot {
  const s = seedSnapshot();
  s.tracks = [];
  s.buses = [];
  s.sections = [];
  s.annotations = [];
  s.transport = { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 };
  return s;
}

let snapshot: Snapshot = seedSnapshot();
let mockCorpusLines = 0; // §7 — simulates the cross-song style corpus growing on accept

// G3 — mock audio routing. The current device selection (so set_audio_device shows
// up in the next list_audio_devices) and the enumerated wave inputs (so the
// per-track input picker has real choices and set_track_input can stick).
const mockAudioSel = { type: "CoreAudio", outputDevice: "MacBook Pro Speakers", inputDevice: "MacBook Pro Microphone" };
const MOCK_WAVE_INPUTS = [
  { deviceID: "in-1-2", name: "Input 1-2", enabled: true, isStereoPair: true },
  { deviceID: "in-3-4", name: "Input 3-4", enabled: true, isStereoPair: true },
  { deviceID: "in-5", name: "Input 5", enabled: false, isStereoPair: false },
];
// CTL-001 — mock MIDI inputs so the v2 inspector's per-instrument MIDI-input picker
// has real choices and set_track_input can route one (list_midi_inputs enumeration).
const MOCK_MIDI_INPUTS = [
  { deviceID: "midi-akai", name: "Akai MPK Mini", alias: "Akai MPK Mini", enabled: true, monitor: "automatic" as const },
  { deviceID: "midi-iac", name: "IAC Driver Bus 1", alias: "IAC Driver Bus 1", enabled: true, monitor: "automatic" as const },
  { deviceID: "midi-launchkey", name: "Launchkey 49", alias: "Launchkey 49", enabled: false, monitor: "off" as const },
];
// RTG-002 — hardware output destinations (so the per-track output picker has real
// device choices and set_track_output's deviceID form can stick in dev/e2e).
const MOCK_OUTPUT_DEVICES = [
  { deviceID: "out-1-2", name: "MacBook Pro Speakers", enabled: true },
  { deviceID: "out-3-4", name: "External Headphones", enabled: true },
];
const clone = (s: Snapshot): Snapshot => JSON.parse(JSON.stringify(s)) as Snapshot;
function scheduleMock(callback: () => void, delayMs: number) {
  globalThis.setTimeout(callback, delayMs);
}
const history: Snapshot[] = [];
const future: Snapshot[] = [];
// Agent batch grouping (mirrors the backend batch_begin/batch_end): while a batch
// is open, per-command pushUndo() is suppressed so the whole batch is ONE undo step.
let inBatch = false;

// ── event bus (mirrors window.__JUCE__.backend on the real side) ─────────────

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

// Mock command log (drives the CommandLog panel). Read-only commands don't log.
const cmdLog: { command: string; ok: boolean; undoable: boolean; ts: number }[] = [];
const READONLY = new Set(["get_snapshot", "get_clip_peaks", "file_peaks", "audition_file", "stop_audition", "get_command_log", "list_plugins", "list_builtins", "list_colors", "list_loras", "list_rave_models", "list_audio_devices", "list_wave_inputs", "list_midi_inputs", "list_track_outputs", "list_takes", "list_training_sources", "training_job_status", "list_lora_adapters"]);
const NON_UNDOABLE = new Set(["set_transport", "arm_track", "set_input_monitor", "undo", "redo", "save", "reload", "new_project", "render_layer", "reset_render_layer", "open_plugin_editor", "set_plugin_param", "export_audio", "mark_take", "import_training_source", "approve_training_source", "build_training_corpus", "submit_training_job", "cancel_training_job", "import_lora_adapter", "activate_lora_adapter", "get_rhymes",
  "complete_lyrics", "fill_lyric_gap", "suggest_next_line", "regenerate_lyric",
  "cancel_lyric_job", "reject_lyric_proposal", "analyze_lyrics", "get_lyric_corpus_stats"]);  // accept_lyric_proposal IS undoable

// AL-017 — fail-closed default. A command the mock does NOT explicitly case must not
// silently report success: for a MUTATING command that means the dev/e2e UI looks like
// it worked while nothing changed, hiding real UI-test gaps (paste_clip is the canonical
// example). The `default` case therefore ERRORS on any unmodeled command, EXCEPT the ones
// below — intentional native-only / read-only passthroughs the dev UI degrades around
// gracefully (these mirror the non-mutating entries of bridge.mock.test.ts's ALLOWLIST;
// give any of them a real case when dev-mode fidelity matters).
const DEFAULT_OK = new Set([
  "import_clip_data",  // bytes-over-bridge is native-only; dev imports via import_clip
  "recover_session",   // A3 crash recovery — native-only (no dev-mock crash journal)
  "discard_recovery",  // "
]);

// LYR-001 — a tiny deterministic rhyme map so the rhyme tool returns something in
// browser dev / e2e (the real path is the phonology service). Suffix fallback keeps
// it non-empty for unknown words.
const MOCK_RHYMES: Record<string, string[]> = {
  flame: ["name", "blame", "game", "frame", "same", "claim", "aim", "tame"],
  cat: ["hat", "bat", "rat", "sat", "flat", "mat", "that", "chat"],
  light: ["night", "sight", "fight", "right", "tight", "bright", "might"],
  back: ["track", "rap", "attack", "stack", "black", "crack", "rack"],
  flow: ["go", "low", "show", "know", "glow", "slow", "though"],
};
function mockRhymes(word: string, maxN: number, syllables: number) {
  const base = MOCK_RHYMES[word.toLowerCase()] ?? [`${word}er`, `${word}in`, `${word}o`];
  return base
    .map((w) => ({ word: w, syllables: syllablesForWord(w), grade: "perfect" as const }))
    .filter((c) => syllables <= 0 || c.syllables === syllables)
    .slice(0, maxN > 0 ? maxN : 50);
}

// L2 — deterministic mock generation for browser dev / e2e (the real loop is the
// service). Builds plausible, constraint-flavoured proposals; the rhyme group's anchor
// (an earlier line's end word) drives the candidate end words.
const FILLER = ["over", "alone", "again", "inside", "tonight", "rising"];
const isGap = (t: string) => /^_{2,}$/.test(t);
// The group's rhyme anchor = the first group line's FIXED end word (final text last
// word, or the seed's last token when it's a word, not a gap).
function mockGroupAnchor(sheet: LyricSheet, group: string): string {
  for (const l of sheet.lines) {
    if (l.rhymeGroup !== group) continue;
    const txt = (l.text || "").trim();
    if (txt) return (txt.split(/\s+/).pop() ?? "").replace(/[^A-Za-z']/g, "");
    const toks = (l.seedText || "").split(/\s+/).filter(Boolean);
    if (toks.length && !isGap(toks[toks.length - 1])) return toks[toks.length - 1].replace(/[^A-Za-z']/g, "");
  }
  return "";
}
// Mirror the real assembler: keep the producer's words, fill interior gaps with
// filler, and only APPEND a rhyme end word when the line ends in a gap (else keep
// the fixed end).
function mockProposals(line: LyricLine, sheet: LyricSheet) {
  const anchor = line.rhymeGroup ? mockGroupAnchor(sheet, line.rhymeGroup) : "";
  const ends = (anchor && MOCK_RHYMES[anchor.toLowerCase()]) || ["flow", "time", "grind", "light"];
  const toks = (line.seedText || "").split(/\s+/).filter(Boolean);
  const ownEnd = toks.length === 0 || isGap(toks[toks.length - 1]);
  const out = [];
  for (let v = 0; v < 3; v++) {
    const words: string[] = [];
    toks.forEach((tk, i) => {
      if (isGap(tk)) { if (i !== toks.length - 1) words.push(FILLER[(v + i) % FILLER.length]); }
      else words.push(tk);
    });
    const end = ownEnd ? ends[(v + (line.regen ?? 0)) % ends.length] : words[words.length - 1] ?? "";
    if (ownEnd) words.push(end);
    const text = words.join(" ").replace(/\s+/g, " ").trim();
    const rhymeOk = ownEnd ? !!anchor : true;
    out.push({ text, endWord: end, syllables: countSyllables(text), passes: true,
               syllableOk: true, rhymeOk, grade: ownEnd ? (anchor ? "slant" : "free") : "anchor", score: 1 - v * 0.1 });
  }
  return out;
}
function mockFillable(l: LyricLine): boolean {
  return !l.locked && (!l.text.trim() || /_{2,}/.test(l.seedText));
}
// L1 — deterministic mock phonology analysis (the real path is the service). Mirrors the
// shape of core.analyze: per-word slots, a per-line stress contour, the rhyme grade vs the
// group anchor. Stress alternates (X x X …) — a plausible stand-in for the precise contour.
function mockRhymeGrade(end: string, anchor: string): string {
  if (!anchor || !end) return "free";
  if (end.toLowerCase() === anchor.toLowerCase()) return "anchor";
  const a = end.toLowerCase().replace(/[^a-z]/g, "");
  const b = anchor.toLowerCase().replace(/[^a-z]/g, "");
  if (a.slice(-2) === b.slice(-2)) return "perfect";
  if (a.slice(-1) === b.slice(-1)) return "slant";
  return "none";
}
function mockAnalysis(line: LyricLine, sheet: LyricSheet) {
  const txt = (line.text || "").trim();
  const seed = line.seedText || "";
  const hasGap = /_{2,}/.test(seed);
  const analyzed = txt ? "text" : seed.trim() ? "seed" : "empty";
  const content = txt || (seed.split(/\s+/).filter((t) => t && !isGap(t)).join(" "));
  const wordToks = content.split(/\s+/).filter(Boolean);
  const words = wordToks.map((w) => {
    const n = syllablesForWord(w);
    return { w, syllables: n, stress: Array.from({ length: n }, (_, i) => (i === 0 ? "X" : "x")).join(""), inDict: true };
  });
  const syllables = words.reduce((s, x) => s + x.syllables, 0);
  const target = line.syllableTarget > 0 ? line.syllableTarget : (sheet.grid === "1/4" ? 4 : sheet.grid === "1/8" ? 8 : 16);
  const tol = line.syllableTol || 1;
  const endWord = wordToks.length ? wordToks[wordToks.length - 1].replace(/[^A-Za-z']/g, "") : "";
  const anchor = line.rhymeGroup ? mockGroupAnchor(sheet, line.rhymeGroup) : "";
  const isAnchor = !!anchor && !!endWord && endWord.toLowerCase() === anchor.toLowerCase();
  const grade = isAnchor ? "anchor" : mockRhymeGrade(endWord, anchor);
  const rhymeOk = isAnchor || !anchor || !endWord || grade === "perfect" || grade === "slant";
  return {
    syllables, target, tol, syllableOk: Math.abs(syllables - target) <= tol, endWord,
    rhymeGroup: line.rhymeGroup || "", rhymeAnchor: anchor, rhymeGrade: grade, rhymeOk,
    stress: words.map((x) => x.stress).join(""), words, hasGap, analyzed,
    complete: analyzed === "text" && !hasGap, endInDict: !!endWord,
  };
}
function emit(type: string, payload?: unknown) {
  const ls = listeners.get("mosh_event");
  if (ls) for (const fn of ls) fn({ type, payload });
}
export function mockOnEvent(eventId: string, fn: Listener): () => void {
  let set = listeners.get(eventId);
  if (!set) { set = new Set(); listeners.set(eventId, set); }
  set.add(fn);
  return () => set?.delete(fn);
}

/** TEST-ONLY: publish a synthetic event on the mock's event bus. For events the dev
 * mock never emits itself by design (e.g. FIT-003's live plugin-scan running-count
 * sample — there is no dev-mock AU sweep to sample), this is how a vitest exercises
 * store.ts's real onEvent("mosh_event", ...) reducer instead of duplicating its logic. */
export function __mockEmitForTests(type: string, payload?: unknown): void {
  emit(type, payload);
}
const invalidate = () => emit("snapshot_invalidated");

// ── transport simulation (the 30 Hz decimated playhead feed) ─────────────────

let playTimer: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;
function startPlayback() {
  if (playTimer) return;
  lastTick = Date.now();
  playTimer = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    const t = snapshot.transport;
    let pos = t.position + dt;
    if (t.looping && t.loopEnd > t.loopStart && pos >= t.loopEnd) pos = t.loopStart;
    snapshot.transport = { ...t, position: pos };
    emit("transport", snapshot.transport);

    // Fake master spectrum (8 bands, low→high) so Moshi reacts in browser dev where
    // there's no real audio. Animated off the playhead; a sharp ~2Hz flux pulse stands
    // in for onsets, low end tilted louder like real music.
    const N = 8;
    const bands = Array.from({ length: N }, (_, i) => {
      const base = 0.5 + 0.5 * Math.sin(pos * (1.5 + i * 0.45) + i * 1.7);
      const tilt = 1 - i / (N * 1.5);
      return Math.max(0, Math.min(1, base * tilt * 0.92));
    });
    const level = bands.reduce((a, b) => a + b, 0) / N;
    const flux = Math.max(0, Math.sin(pos * Math.PI * 4)) ** 6;
    emit("spectrum", { bands, level, flux });

    // Fake per-track + master peak levels (dBFS) so the meters move in browser dev,
    // where there's no real audio. Wobbles per track off the playhead; muted tracks
    // read the floor. Shape matches the native `levels` event the store hydrates.
    const toDb = (g: number) => (g <= 0.001 ? -100 : -60 + Math.max(0, Math.min(1, g)) * 60);
    const tracks = snapshot.tracks
      .filter((t) => !t.isGroup)
      .map((t, i) => {
        const g = t.mute ? 0 : level * (0.6 + 0.4 * Math.abs(Math.sin(pos * 2.3 + i)));
        const db = toDb(g);
        return { id: t.id, l: db, r: toDb(g * 0.94) };
      });
    emit("levels", { tracks, master: { l: toDb(level), r: toDb(level * 0.96) } });
  }, 1000 / 30);
}
function stopPlayback() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  emit("spectrum", { bands: Array(8).fill(0), level: 0, flux: 0 }); // calm on stop
  // Drop the meters to the floor when the transport stops.
  const tracks = snapshot.tracks.filter((t) => !t.isGroup).map((t) => ({ id: t.id, l: -100, r: -100 }));
  emit("levels", { tracks, master: { l: -100, r: -100 } });
}

// ── helpers ──────────────────────────────────────────────────────────────────

const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const completeLyricText = (text: string): boolean => {
  const t = text.trim();
  return Boolean(t && !t.includes("___") && /[A-Za-z0-9]/.test(t));
};
const refreshSingable = (line: LyricLine): void => {
  line.asserted = line.status === "asserted" && completeLyricText(line.text);
  line.singable = Boolean(line.hasScore && line.asserted);
};
function findClip(clipId: string): { track: Track; clip: Clip } | null {
  for (const track of snapshot.tracks)
    for (const clip of track.clips) if (clip.id === clipId) return { track, clip };
  return null;
}
function findTrack(trackId: string): Track | null {
  return snapshot.tracks.find((t) => t.id === trackId) ?? null;
}
// DRM-001 — mirror the native default-instrument policy: a track that needs an
// instrument gets the sane default (drum → sampler, melodic → 4OSC) unless it
// already hosts one. Keeps UI tests honest about the auto-load behaviour.
function ensureInstrument(t: Track, drum: boolean): void {
  t.plugins = t.plugins ?? [];
  if (!t.plugins.some((p) => p.isInstrument)) {
    const b = drum ? { type: "sampler", name: "Sampler" } : { type: "4osc", name: "4OSC Synth" };
    t.plugins.unshift({ index: 0, name: b.name, type: b.type, enabled: true, external: false, builtin: true, category: "Instrument", isInstrument: true, params: [] });
    t.plugins.forEach((p, i) => (p.index = i));
  }
  t.isInstrument = t.plugins.some((p) => p.isInstrument);
}
function pushUndo() { if (inBatch) return; history.push(clone(snapshot)); future.length = 0; if (history.length > 100) history.shift(); }

// RTG-002 — does `track`'s output chain (transitively) already feed into targetId?
// Mirrors the native TrackOutput::feedsInto cycle guard so set_track_output can
// reject a routing that would loop. Walks route-into-track hops with a seen guard.
function outputFeedsInto(track: Track, targetId: string): boolean {
  const seen = new Set<string>();
  let cur: Track | undefined = track;
  while (cur) {
    const out = cur.output;
    if (!out || !out.isTrack || !out.destId) return false;
    if (out.destId === targetId) return true;
    if (seen.has(cur.id)) return false;
    seen.add(cur.id);
    const nextId: string = out.destId;
    cur = snapshot.tracks.find((tr) => tr.id === nextId);
  }
  return false;
}

const ok = (command: string, data?: unknown): CommandResult => ({ ok: true, command, data });
const err = (command: string, error: string): CommandResult => ({ ok: false, command, error });

// Minimal mirror of the Python prompt compiler (service/compiler/core.py) so the e2e +
// vitest exercise the real UI without the native backend. Deterministic, generative-only:
// classify reimagine | transform | unsupported and emit a validated envelope.
function mockCompile(instruction: string): { mode: string; envelope?: Record<string, unknown>; say?: string; subtype?: string; tool?: string | null; reasoning: string } {
  const low = instruction.toLowerCase().trim();
  // Corrective sub-types → the existing tool that fixes it (mirrors _CORRECTIVE_SUBTYPES).
  const correctiveSubtypes: Array<[string[], string, string, string]> = [
    [["in tune", "out of tune", "off-key", "off key", "off-pitch", "pitchy", "tune it", "tune the", "tune my", "retune", "autotune", "auto-tune", "pitch correct", "fix the tuning", "fix the pitch", "intonation"], "pitch", "moshAutoTune", "That's a tuning issue — AutoTune corrects the pitch in place; it doesn't re-perform the take."],
    [["tighten", "on the beat", "off the beat", "off-beat", "quantize", "fix the timing", "fix timing", "loose timing", "sloppy timing", "lock it to the grid"], "timing", "quantize_notes", "That's a timing issue — quantize snaps the notes to the grid (MIDI clips); it doesn't re-perform the take."],
    [["too muddy", "muddy", "too harsh", "harsh", "boomy", "boxy", "too thin", "tinny", "fix the tone", "honky"], "tone", "eq", "That's a tone issue — an EQ shapes it without re-performing the take."],
    [["too quiet", "too loud", "uneven", "inconsistent level", "levels are", "level it", "even it out", "compress the", "fix the dynamics", "dynamics are"], "dynamics", "moshOTT", "Uneven levels — OTT evens them out without re-performing."],
  ];
  for (const [trig, subtype, tool, say] of correctiveSubtypes) {
    if (trig.some((t) => low.includes(t))) return { mode: "corrective", subtype, tool, say, reasoning: `corrective:${subtype}` };
  }
  const noise = ["clean up the recording", "de-noise", "denoise", "remove the noise", "remove noise", "too noisy", "hiss", "background hum", "crackle"];
  if (noise.some((k) => low.includes(k))) return { mode: "unsupported", say: "I can't clean up noise/hiss in a recording yet — that needs a restoration tool.", reasoning: "classified noise" };
  const vocal = ["vocal", "vocals", "sing ", "singing", "sung", "singer", "add lyrics"];
  if (vocal.some((k) => low.includes(k))) return { mode: "unsupported", say: "I only generate instrumental textures — I can't create or fix vocals.", reasoning: "classified vocal" };
  const genericFix = ["fix ", "fix the", "fix my", "fix it", "fix this", "repair", "correct the", "clean up"];
  if (genericFix.some((k) => low.includes(k))) return { mode: "corrective", subtype: "ambiguous", tool: null, say: "I can correct the TUNING (AutoTune), TIMING (quantize), TONE (EQ) or LEVELS (OTT) — which one? Or describe the sound you want and I'll re-imagine it.", reasoning: "corrective:ambiguous" };
  const instruments = ["electric guitar", "guitar", "piano", "violin", "cello", "strings", "synth pad", "synth", "flute", "choir", "brass", "organ", "bells", "harp"];
  const cues = ["into a ", "into an ", "as a ", "as an ", "turn it into ", "make it a ", "sound like a ", "sounds like a "];
  const instr = instruments.find((i) => new RegExp(`\\b${i}\\b`).test(low));
  if (instr && cues.some((c) => low.includes(c))) {
    return { mode: "transform", reasoning: `transform → ${instr}`, envelope: { mode: "transform", target: instr, strength: 65, seed: 1, prompt: "", colors: [], lab: false } };
  }
  const descriptors: Array<[string[], string, number]> = [
    [["brighter", "brighten", "shiny", "crisp"], "brightness", 76],
    [["darker", "dark", "moody", "muffled"], "brightness", 24],
    [["gritty", "grit", "dirty", "lo-fi", "lofi", "raw", "crunch"], "grit", 72],
    [["distort", "fuzz", "overdriv"], "distortion", 70],
    [["epic", "cinematic", "huge", "dramatic"], "epic", 70],
    [["futuristic", "synthetic", "digital", "robotic"], "futuristic", 70],
    [["tense", "eerie", "ominous"], "tension", 70],
    [["airy", "air", "spacious", "ethereal", "ambient"], "air", 70],
  ];
  const colors: Array<{ name: string; value: number }> = [];
  for (const [trig, name, value] of descriptors) {
    if (colors.length >= 3) break;
    if (colors.some((c) => c.name === name)) continue;
    if (trig.some((t) => low.includes(t))) colors.push({ name, value });
  }
  const prompt = (colors.map((c) => c.name).join(", ") + (instr ? ` ${instr}` : "")) || low;
  return { mode: "reimagine", reasoning: `re-imagine: ${colors.map((c) => c.name).join(", ") || "(none)"}`, envelope: { mode: "reimagine", prompt, nl: 0.4, colors, lab: false, seed: 1 } };
}

function trainingState(): TrainingState {
  if (!snapshot.training) {
    snapshot.training = {
      registryPath: "/mock/training/rights_registry.json",
      statePath: "/mock/training/training_state.json",
      activeAdapterId: "",
      activeAdapterPath: "",
      activeCorpusHash: "",
      sources: [],
      adapters: [],
      jobs: [],
    };
  }
  return snapshot.training as TrainingState;
}

// ── plugin / generative catalog (dev-mock only) ─────────────────────
const BUILTINS = [
  { type: "4osc", name: "4OSC", category: "Instruments", isInstrument: true, builtin: true as const },
  { type: "reverb", name: "Reverb", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "delay", name: "Delay", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "eq", name: "4-Band EQ", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "moshAutoTune", name: "Mosh AutoTune", category: "Mosh FX", isInstrument: false, builtin: true as const },
  { type: "moshOTT", name: "Mosh OTT", category: "Mosh FX", isInstrument: false, builtin: true as const },
  { type: "moshXFeedback", name: "Mosh X-FDBK", category: "Mosh FX", isInstrument: false, builtin: true as const },
];
const VST3S = [
  { id: "vital", name: "Vital", format: "VST3", manufacturer: "Vital Audio", isInstrument: true },
  { id: "ott", name: "OTT", format: "VST3", manufacturer: "Xfer", isInstrument: false },
];
const COLORS = [
  { name: "grit", astd_max: 0.55, peak_layer: 2, more_sign: 1, verdict: "STRONG", no_stack_with: [] as string[] },
  { name: "brightness", astd_max: 0.5, peak_layer: 3, more_sign: 1, verdict: "STRONG", no_stack_with: ["air"] },
  { name: "air", astd_max: 0.08, peak_layer: 1, more_sign: 1, verdict: "WEAK", no_stack_with: ["brightness"] },
  { name: "sustain", astd_max: 0.4, peak_layer: 17, more_sign: 1, verdict: "REAL", no_stack_with: ["sustain_swell"], group: "sustain", mode: "Gentle" },
  { name: "sustain_swell", astd_max: 0.4, peak_layer: 8, more_sign: 1, verdict: "REAL", no_stack_with: ["sustain"], group: "sustain", mode: "Swell" },
];
const LORAS = [
  { name: "ken-sa3", displayName: "Ken (xperiment)", trigger: "kxc", hint: "rage trap instrumental", valid: true, sha12: "aaaaaaaaaaaa" },
  { name: "bro-sa3", displayName: "Brother (BWPOM era)", trigger: "brozr", hint: "melodic pop instrumental", valid: true, sha12: "bbbbbbbbbbbb" },
  { name: "mic-sa3", displayName: "Microphones", trigger: "micz", hint: "lo-fi indie texture", valid: true, sha12: "cccccccccccc" },
  { name: "broken", displayName: "broken", trigger: "", hint: "", valid: false, reason: "unreadable safetensors", sha12: "" },
];

const reindex = (t: Track) => t.plugins!.forEach((p, i) => (p.index = i));
const reindexNotes = (c: Clip) => c.notes!.forEach((n, i) => (n.i = i));
function findPlugin(trackId: string, index: number): { track: Track; idx: number } | null {
  const t = findTrack(trackId);
  if (!t || !t.plugins || index < 0 || index >= t.plugins.length) return null;
  return { track: t, idx: index };
}
function mkParams(n: number) {
  return Array.from({ length: n }, (_, i) => ({ index: i, name: ["Drive", "Tone", "Mix", "Decay", "Size", "Rate", "Depth", "Gain"][i] ?? `P${i}`, value: 0.5 }));
}
function params(names: string[], values: number[]): PluginParam[] {
  return names.map((name, index) => ({ index, name, value: values[index] ?? 0.5 }));
}
function mkBuiltinParams(type: string, isInstrument: boolean): PluginParam[] {
  if (isInstrument) return [];
  if (type === "moshAutoTune") return params(["Root", "Scale", "Retune", "Amount", "Range", "Mix", "Output"], [0, 0, 0.32, 0.35, 0.33, 1, 0.75]);
  if (type === "moshOTT") return params(["Amount", "Time", "Low Gain", "Mid Gain", "High Gain", "Mix", "Output"], [0.12, 0.24, 0.5, 0.5, 0.5, 1, 0.71]);
  if (type === "moshXFeedback") return params(["Sensitivity", "Max Cuts", "Max Depth", "Release", "Auto Suppress", "Mix", "Output"], [0.62, 0.5, 0.55, 0.38, 1, 0.8, 0.5]);
  return mkParams(4);
}
function mkMoshFx(type: string): MoshFxReadout | undefined {
  if (type === "moshAutoTune") return { kind: "autotune", inputHz: 449.0, targetHz: 440.0, correctionCents: -34.4, confidence: 0.91 };
  if (type === "moshOTT") return { kind: "ott", amount: 0.12, timeMs: 120.0 };
  if (type !== "moshXFeedback") return undefined;
  return {
    kind: "feedback",
    candidates: [
      { frequencyHz: 1260, score: 0.82, depthDb: 5.5 },
      { frequencyHz: 2510, score: 0.74, depthDb: 4.2 },
      { frequencyHz: 3875, score: 0.61, depthDb: 3.4 },
    ],
    activeCuts: [],
  };
}

// ── command dispatch ─────────────────────────────────────────────────────────

function dispatch(command: string, args: Record<string, unknown>): CommandResult {
  switch (command) {
    case "set_transport": {
      const t = snapshot.transport;
      const action = str(args.action);
      if (action === "toggle") {
        const playing = !t.playing;
        snapshot.transport = { ...t, playing };
        playing ? startPlayback() : stopPlayback();
        emit("transport", snapshot.transport);
        return ok(command, { playing });
      }
      if (action === "stop") {
        stopPlayback();
        snapshot.transport = { ...t, playing: false, recording: false, position: num(args.position, 0) };
        emit("transport", snapshot.transport);
        return ok(command);
      }
      if (action === "to_end") {
        snapshot.transport = { ...t, position: snapshot.session.length ?? 16 };
        emit("transport", snapshot.transport);
        return ok(command);
      }
      if (action === "to_start") {
        snapshot.transport = { ...t, position: 0 };
        emit("transport", snapshot.transport);
        return ok(command);
      }
      if (action === "record") {
        snapshot.transport = { ...t, recording: !t.recording, playing: true };
        startPlayback();
        emit("transport", snapshot.transport);
        return ok(command);
      }
      // direct field sets: position / loop
      const next: Transport = { ...t };
      if ("position" in args) next.position = Math.max(0, num(args.position));
      if ("loop" in args) { next.looping = Boolean(args.loop); next.loopStart = num(args.loopStart, t.loopStart); next.loopEnd = num(args.loopEnd, t.loopEnd); }
      snapshot.transport = next;
      emit("transport", snapshot.transport);
      return ok(command);
    }

    case "create_track": {
      pushUndo();
      // DRM-001 — type:"drum" auto-loads the sampler + kit (modelled here so UI tests
      // see an instrument-bearing drum track, mirroring the native default policy).
      const type = str(args.type, "audio") === "drum" ? "drum" : "audio";
      const t: Track = {
        id: nextTrackId(), index: snapshot.tracks.length, name: str(args.name, "Audio"),
        type, volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
      };
      if (type === "drum") ensureInstrument(t, true);
      snapshot.tracks.push(t);
      invalidate();
      return ok(command, { trackId: t.id, type, isInstrument: !!t.isInstrument });
    }
    case "create_group_track": {
      // MIX-008 — wrap the given tracks in a submix (group) track. Dispatched by the
      // configurable keymap's GROUP action (Mod+G). Minimal mock: append a group track
      // and reparent the members so the UI shows the submix.
      const ids = (Array.isArray(args.trackIds) ? (args.trackIds as unknown[]) : []).map(String);
      if (ids.length === 0) return err(command, "no trackIds");
      pushUndo();
      const g: Track = {
        id: nextTrackId(), index: snapshot.tracks.length, name: "Group",
        type: "group", isGroup: true, volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
      };
      snapshot.tracks.push(g);
      for (const t of snapshot.tracks) if (ids.includes(t.id)) t.parentId = g.id;
      invalidate();
      return ok(command, { trackId: g.id });
    }
    case "set_track_type": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      const type = str(args.type, "audio") === "drum" ? "drum" : "audio";
      pushUndo();
      t.type = type;
      if (type === "drum") ensureInstrument(t, true);
      invalidate();
      return ok(command, { trackId: t.id, type, isInstrument: !!t.isInstrument });
    }
    case "load_drum_kit": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      pushUndo();
      ensureInstrument(t, true);
      invalidate();
      return ok(command, { trackId: t.id, pads: 8 });
    }
    case "assign_sample": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      // Mirror the native guard: a sample is required (native also checks the file
      // exists on disk, which the mock can't, so it only enforces a non-empty path).
      const file = str(args.file);
      if (!file) return err(command, "file not found: " + file);
      pushUndo();
      ensureInstrument(t, true);
      invalidate();
      return ok(command, { trackId: t.id, note: num(args.note, 60), name: str(args.name, "Sample"), file });
    }
    case "set_drum_lane": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      const note = num(args.note, -1);
      if (note < 0) return err(command, "note (0-127) required");
      const toggle = (arr: number[] | undefined, on: boolean): number[] => {
        const set = new Set(arr ?? []);
        if (on) set.add(note); else set.delete(note);
        return [...set].sort((a, b) => a - b);
      };
      pushUndo();
      if ("mute" in args) t.drumMutedPitches = toggle(t.drumMutedPitches, Boolean(args.mute));
      if ("solo" in args) t.drumSoloPitches = toggle(t.drumSoloPitches, Boolean(args.solo));
      invalidate();
      return ok(command, { trackId: t.id, note, muted: (t.drumMutedPitches ?? []).includes(note), solo: (t.drumSoloPitches ?? []).includes(note) });
    }
    case "rename_track": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      pushUndo(); t.name = str(args.name, t.name); invalidate(); return ok(command);
    }
    case "remove_track": {
      const idx = snapshot.tracks.findIndex((t) => t.id === str(args.trackId));
      if (idx < 0) return err(command, "track not found");
      pushUndo(); snapshot.tracks.splice(idx, 1);
      snapshot.tracks.forEach((t, i) => (t.index = i));
      invalidate(); return ok(command);
    }
    case "set_track_volume": { const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found"); pushUndo(); t.volumeDb = num(args.db); invalidate(); return ok(command); }
    case "set_track_pan":    { const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found"); pushUndo(); t.pan = num(args.pan); invalidate(); return ok(command); }
    case "set_track_mute":   { const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found"); pushUndo(); t.mute = Boolean(args.mute); invalidate(); return ok(command); }
    case "set_track_solo":   { const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found"); pushUndo(); t.solo = Boolean(args.solo); invalidate(); return ok(command); }

    // ── sends / returns / aux buses (Wave 8) ─────────────────────────────────
    // A "bus" is an integer; the return is an instrument-free audio track carrying
    // an aux-return (isReturn/returnBus). Sends are post-fader entries on a track's
    // sends[], routed purely by matching bus number. Mirrors MoshOps cmdCreateBus/…
    case "create_bus": {
      pushUndo();
      const used = new Set((snapshot.buses ?? []).map((b) => b.bus));
      let bus = 0; while (used.has(bus)) bus++;
      const name = str(args.name) || `Bus ${bus + 1}`;
      const rt: Track = {
        id: nextTrackId(), index: snapshot.tracks.length, name, type: "audio",
        volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
        isReturn: true, returnBus: bus,
      };
      snapshot.tracks.push(rt);
      (snapshot.buses ??= []).push({ bus, name, trackId: rt.id });
      invalidate();
      return ok(command, { busNumber: bus, trackId: rt.id, name });
    }
    case "add_send": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "no track");
      const bus = num(args.bus, -1);
      if (!(snapshot.buses ?? []).some((b) => b.bus === bus)) return err(command, "no such bus");
      if ((t.sends ?? []).some((s) => s.bus === bus)) return err(command, "send already exists");
      pushUndo();
      (t.sends ??= []).push({ bus, db: Math.max(-60, Math.min(6, num(args.db, 0))), mute: false });
      invalidate();
      return ok(command, { bus });
    }
    case "set_send_level": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "no track");
      const s = (t.sends ?? []).find((x) => x.bus === num(args.bus, -1));
      if (!s) return err(command, "no send to that bus");
      pushUndo();
      s.db = Math.max(-100, Math.min(6, num(args.db, 0)));
      invalidate();
      return ok(command);
    }
    case "remove_send": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "no track");
      const i = (t.sends ?? []).findIndex((x) => x.bus === num(args.bus, -1));
      if (i < 0) return err(command, "no send to that bus");
      pushUndo();
      t.sends!.splice(i, 1);
      invalidate();
      return ok(command);
    }

    case "create_section": {
      pushUndo();
      const start = num(args.startBeat, 0);
      const sec = { id: nextSectionId(), name: str(args.name, "Section"), startBeat: start, endBeat: num(args.endBeat, start + 16), color: str(args.color) || undefined };
      (snapshot.sections ??= []).push(sec);
      invalidate(); return ok(command, { sectionId: sec.id });
    }
    case "rename_section": {
      const sec = (snapshot.sections ?? []).find((x) => x.id === str(args.sectionId));
      if (!sec) return err(command, "section not found");
      pushUndo(); sec.name = str(args.name, sec.name); invalidate(); return ok(command);
    }
    case "move_section": {
      const sec = (snapshot.sections ?? []).find((x) => x.id === str(args.sectionId));
      if (!sec) return err(command, "section not found");
      pushUndo(); sec.startBeat = num(args.startBeat, sec.startBeat); sec.endBeat = num(args.endBeat, sec.endBeat); invalidate(); return ok(command);
    }
    case "remove_section": {
      const list = snapshot.sections ?? [];
      const idx = list.findIndex((x) => x.id === str(args.sectionId));
      if (idx < 0) return err(command, "section not found");
      pushUndo(); list.splice(idx, 1); invalidate(); return ok(command);
    }

    // ── LYR-001 — lyric sheet (per-track) ────────────────────────────────────
    case "create_lyric_sheet": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      if (t.lyricSheet) return err(command, "track already has a lyric sheet");
      pushUndo();
      const sheet: LyricSheet = {
        id: `ls-${t.id}`,
        grid: str(args.grid, "1/16"),
        language: str(args.language, "en"),
        topic: str(args.topic, ""),
        mood: str(args.mood, ""),
        explicit: str(args.explicit, "allow"),
        rhymeStrictness: "slant",
        styleBias: false,
        specVersion: 1,
        lines: [],
      };
      t.lyricSheet = sheet;
      invalidate();
      return ok(command, { sheetId: sheet.id, trackId: t.id });
    }
    case "remove_lyric_sheet": {
      const t = findTrack(str(args.trackId));
      if (!t?.lyricSheet) return err(command, "track has no lyric sheet");
      pushUndo(); delete t.lyricSheet; invalidate(); return ok(command);
    }
    case "set_lyric_constraint": {
      const t = findTrack(str(args.trackId));
      if (!t?.lyricSheet) return err(command, "track has no lyric sheet");
      pushUndo();
      const s = t.lyricSheet;
      if (args.grid != null) s.grid = str(args.grid, s.grid);
      if (args.topic != null) s.topic = str(args.topic, s.topic);
      if (args.mood != null) s.mood = str(args.mood, s.mood);
      if (args.explicit != null) s.explicit = str(args.explicit, s.explicit);
      if (args.rhymeStrictness != null) s.rhymeStrictness = str(args.rhymeStrictness, s.rhymeStrictness);
      if (args.styleBias != null) s.styleBias = !!args.styleBias;
      invalidate(); return ok(command);
    }
    case "set_lyric_line": {
      const t = findTrack(str(args.trackId));
      if (!t?.lyricSheet) return err(command, "track has no lyric sheet");
      const idx = num(args.lineIndex, -1);
      if (idx < 0) return err(command, "lineIndex required");
      const lines = t.lyricSheet.lines;
      if (idx > lines.length) return err(command, "lineIndex out of range");
      pushUndo();
      let line = lines.find((l) => l.index === idx);
      if (!line) {
        line = { index: idx, role: str(args.role, "verse"), seedText: "", text: "", syllableTarget: 0, syllableTol: 1, stress: "", rhymeGroup: "", rhymeStrictness: "", locked: false, sectionId: "", status: "empty" };
        lines.push(line);
      }
      // Native parity: an edit that changes the effective lyric of a verbatim "sung"
      // line demotes it to "edited"; a seed edit on a finalized line mirrors into text.
      if (args.text != null && line.origin === "sung" && str(args.text, line.text) !== line.text)
        line.origin = "edited";
      if (args.seedText != null && line.text.trim() && str(args.seedText, "") !== line.text) {
        if (line.origin === "sung") line.origin = "edited";
        line.text = str(args.seedText, line.text);
      }
      if (args.text != null) line.text = str(args.text, line.text);
      if (args.role != null) line.role = str(args.role, line.role);
      if (args.seedText != null) line.seedText = str(args.seedText, line.seedText);
      if (args.syllableTarget != null) line.syllableTarget = num(args.syllableTarget, line.syllableTarget);
      if (args.syllableTol != null) line.syllableTol = num(args.syllableTol, line.syllableTol);
      if (args.stress != null) line.stress = str(args.stress, line.stress);
      if (args.rhymeGroup != null) line.rhymeGroup = str(args.rhymeGroup, line.rhymeGroup);
      if (args.rhymeStrictness != null) line.rhymeStrictness = str(args.rhymeStrictness, line.rhymeStrictness);
      if (args.locked != null) line.locked = Boolean(args.locked);
      if (args.sectionId != null) line.sectionId = str(args.sectionId, line.sectionId);
      // Content present → no longer "empty"; but a Phase-2 `skeleton` line keeps its status
      // while the producer edits the grid (the +/- syllable stepper) — confirm_skeleton flips it.
      if ((args.text != null || args.seedText != null) && line.status !== "skeleton" && (line.text || line.seedText)) line.status = "seed";
      refreshSingable(line);
      invalidate(); return ok(command, { lineIndex: idx });
    }
    case "remove_lyric_line": {
      const t = findTrack(str(args.trackId));
      if (!t?.lyricSheet) return err(command, "track has no lyric sheet");
      const idx = num(args.lineIndex, -1);
      const at = t.lyricSheet.lines.findIndex((l) => l.index === idx);
      if (at < 0) return err(command, "no line at index " + idx);
      pushUndo();
      t.lyricSheet.lines.splice(at, 1);
      t.lyricSheet.lines.forEach((l, i) => (l.index = i)); // keep dense
      invalidate(); return ok(command);
    }
    case "get_rhymes": {
      const word = str(args.word).trim();
      if (!word) return err(command, "word required");
      let strictness = str(args.strictness, "slant");
      if (!["perfect", "slant", "free"].includes(strictness)) strictness = "slant";
      const candidates = mockRhymes(word, num(args.maxN, 50), num(args.syllables, 0));
      return ok(command, { ok: true, word, strictness, inDict: word.toLowerCase() in MOCK_RHYMES, candidates });
    }
    case "complete_lyrics":
    case "fill_lyric_gap":
    case "suggest_next_line":
    case "regenerate_lyric": {
      const t = findTrack(str(args.trackId));
      if (!t?.lyricSheet) return err(command, "track has no lyric sheet");
      const sheet = t.lyricSheet;
      let targets: LyricLine[];
      if (command === "complete_lyrics") targets = sheet.lines.filter(mockFillable);
      else if (command === "suggest_next_line") targets = sheet.lines.filter((l) => l.index === num(args.afterIndex, -1) + 1 && mockFillable(l));
      else { // fill_lyric_gap / regenerate_lyric
        const l = sheet.lines.find((x) => x.index === num(args.lineIndex, -1));
        if (command === "regenerate_lyric" && l) l.regen = (l.regen ?? 0) + 1;
        targets = l && mockFillable(l) ? [l] : [];
      }
      const lines = targets.map((l) => {
        l.proposals = mockProposals(l, sheet);
        l.status = "proposed";
        return { index: l.index, proposals: l.proposals };
      });
      invalidate();
      return ok(command, { status: "proposed", lineCount: lines.length, lines });
    }
    case "cancel_lyric_job": {
      const t = findTrack(str(args.trackId));
      if (t?.lyricSheet) t.lyricSheet.lines.forEach((l) => { if (l.status === "generating") l.status = l.text || l.seedText ? "seed" : "empty"; });
      invalidate();
      return ok(command);
    }
    case "accept_lyric_proposal": {
      const t = findTrack(str(args.trackId));
      const l = t?.lyricSheet?.lines.find((x) => x.index === num(args.lineIndex, -1));
      const pi = num(args.proposalIndex, 0);
      if (!l) return err(command, "no line at index");
      const p = l.proposals?.[pi];
      if (!p) return err(command, "no proposal at that index");
      pushUndo();
      l.text = p.text;
      l.status = "asserted";
      // Native parity (approximation — the mock has no heard blob): a line whose take
      // anchors fed the proposal lands "mixed", otherwise "generated".
      l.origin = l.origin === "partial" ? "mixed" : "generated";
      delete l.proposals;
      refreshSingable(l);
      mockCorpusLines += 1; // §7 — auto-accumulate the accepted line into the voice corpus
      invalidate();
      return ok(command, { text: p.text });
    }
    case "assert_lyric_line": {
      const t = findTrack(str(args.trackId));
      const l = t?.lyricSheet?.lines.find((x) => x.index === num(args.lineIndex, -1));
      if (!l) return err(command, "no line at index");
      const text = args.text != null ? str(args.text) : l.text;
      if (!completeLyricText(text)) return err(command, "line needs complete words before it can be asserted");
      pushUndo();
      l.text = text.trim();
      l.status = "asserted";
      delete l.proposals;
      refreshSingable(l);
      invalidate();
      return ok(command, { text: l.text });
    }
    case "get_lyric_corpus_stats":
      return ok(command, { lines: mockCorpusLines });
    case "reject_lyric_proposal": {
      const t = findTrack(str(args.trackId));
      const l = t?.lyricSheet?.lines.find((x) => x.index === num(args.lineIndex, -1));
      if (!l) return err(command, "no line at index");
      delete l.proposals;
      l.status = l.text || l.seedText ? "seed" : "empty";
      invalidate();
      return ok(command);
    }
    case "analyze_lyrics": {
      const t = findTrack(str(args.trackId));
      if (!t?.lyricSheet) return err(command, "track has no lyric sheet");
      const sheet = t.lyricSheet;
      sheet.lines.forEach((l) => { l.analysis = mockAnalysis(l, sheet); });
      invalidate();
      return ok(command, { status: "analyzed", lineCount: sheet.lines.length });
    }

    case "create_annotation": {
      pushUndo();
      const ann = { id: str(args.annotationId) || nextAnnotationId(), text: str(args.text, ""), beat: num(args.beat, 0), color: str(args.color) || undefined, author: args.author != null ? str(args.author) : undefined };
      (snapshot.annotations ??= []).push(ann);
      invalidate(); return ok(command, { annotationId: ann.id });
    }
    case "edit_annotation": {
      const ann = (snapshot.annotations ?? []).find((x) => x.id === str(args.annotationId));
      if (!ann) return err(command, "annotation not found");
      pushUndo();
      if (args.text != null) ann.text = str(args.text, ann.text);
      if (args.color != null) ann.color = str(args.color) || undefined;
      invalidate(); return ok(command);
    }
    case "move_annotation": {
      const ann = (snapshot.annotations ?? []).find((x) => x.id === str(args.annotationId));
      if (!ann) return err(command, "annotation not found");
      pushUndo(); ann.beat = num(args.beat, ann.beat); invalidate(); return ok(command);
    }
    case "remove_annotation": {
      const list = snapshot.annotations ?? [];
      const idx = list.findIndex((x) => x.id === str(args.annotationId));
      if (idx < 0) return err(command, "annotation not found");
      pushUndo(); list.splice(idx, 1); invalidate(); return ok(command);
    }

    case "add_test_tone_clip": {
      const t = findTrack(str(args.trackId)) ?? snapshot.tracks[0];
      if (!t) return err(command, "no track");
      pushUndo();
      const c = waveClip("tone", num(args.start, snapshot.transport.position), num(args.seconds, 2));
      t.clips.push(c); invalidate(); return ok(command, { clipId: c.id });
    }
    case "import_clip": {
      const t = findTrack(str(args.trackId)) ?? snapshot.tracks[0];
      if (!t) return err(command, "no track");
      pushUndo();
      const name = str(args.name) || (str(args.file).split("/").pop() ?? "clip");
      // Honor startSeconds (the real cmdImportClip contract); fall back to `start`.
      // The real engine imports the whole file at its own duration and models no
      // trim, so use a fixed placeholder length here rather than an args.length the
      // engine would ignore (matching cmdImportClip, not faking a trimmed clip).
      const c = waveClip(name.replace(/\.[^.]+$/, ""), num(args.startSeconds, num(args.start, 0)), 4);
      t.clips.push(c); invalidate(); return ok(command, { clipId: c.id });
    }
    case "move_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo(); f.clip.start = Math.max(0, num(args.start, f.clip.start));
      if ("trackId" in args) { // move across tracks
        const dest = findTrack(str(args.trackId));
        if (dest && dest !== f.track) { f.track.clips = f.track.clips.filter((c) => c.id !== f.clip.id); dest.clips.push(f.clip); }
      }
      invalidate(); return ok(command);
    }
    case "trim_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo();
      if ("start" in args) f.clip.start = Math.max(0, num(args.start, f.clip.start));
      if ("length" in args) f.clip.length = Math.max(0.05, num(args.length, f.clip.length));
      if ("offset" in args) f.clip.offset = Math.max(0, num(args.offset, f.clip.offset));
      invalidate(); return ok(command);
    }
    case "split_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      // P1 split normalization (native parity): absolute wins when strictly inside;
      // else a clip-relative resolution (start + t) is accepted; edges/outside error.
      const tReq = num(args.time);
      const s0 = f.clip.start, s1 = f.clip.start + f.clip.length, EPS = 1e-6;
      const insideClip = (x: number) => x > s0 + EPS && x < s1 - EPS;
      let t = tReq;
      if (!insideClip(t)) {
        const rel = s0 + tReq;
        if (insideClip(rel)) t = rel;
        else return err(command, `split point outside clip: time ${tReq} (relative candidate ${rel}) not strictly inside [${s0}, ${s1}]`);
      }
      pushUndo();
      const right = waveClip(f.clip.name, t, f.clip.start + f.clip.length - t);
      right.offset = f.clip.offset + (t - f.clip.start);
      f.clip.length = t - f.clip.start;
      f.track.clips.push(right);
      invalidate(); return ok(command, { clipId: right.id });
    }
    case "remove_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo(); f.track.clips = f.track.clips.filter((c) => c.id !== f.clip.id); invalidate(); return ok(command);
    }
    case "duplicate_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo();
      const dup = waveClip(f.clip.name, f.clip.start + f.clip.length, f.clip.length);
      f.track.clips.push(dup); invalidate(); return ok(command, { clipId: dup.id });
    }
    case "rename_clip": { const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found"); pushUndo(); f.clip.name = str(args.name, f.clip.name); invalidate(); return ok(command); }
    case "set_clip_mute": { const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found"); pushUndo(); f.clip.mute = Boolean(args.mute); invalidate(); return ok(command); }
    case "set_clip_gain": { const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found"); pushUndo(); f.clip.gainDb = num(args.gainDb); invalidate(); return ok(command); }

    // Audio warp (auto-tempo): the clip follows the tempo map + time-stretches (SoundTouch).
    // Wave clips only; `autoTempo` is required (mirrors cmdSetClipWarp). Enabling with no
    // mode defaults to SoundTouch (Better). `stretchMode` is carried on the clip ONLY while
    // warp is on, matching the native snapshot serialiser. Undoable.
    case "set_clip_warp": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      if (f.clip.type !== "wave") return err(command, "not an audio clip");
      if (!("autoTempo" in args)) return err(command, "missing 'autoTempo'");
      pushUndo();
      const on = Boolean(args.autoTempo);
      f.clip.autoTempo = on;
      if (on) {
        f.clip.stretchMode = str(args.mode, f.clip.stretchMode ?? "SoundTouch (Better)");
        // sourceBpm: explicit → detected (stub) → prior → map tempo. Mirrors the native
        // serialiser carrying sourceBpm while warp is on (detect is a no-op offline stub).
        const detected = args.detect && !("sourceBpm" in args) ? 120 : undefined;
        f.clip.sourceBpm = "sourceBpm" in args ? num(args.sourceBpm) : (detected ?? f.clip.sourceBpm ?? snapshot.session.tempo);
      } else { delete f.clip.stretchMode; delete f.clip.sourceBpm; }
      invalidate();
      return ok(command, { clipId: f.clip.id, autoTempo: on, stretchMode: f.clip.stretchMode });
    }
    // Stretch a wave clip to a target warped length (seconds) or bar count by deriving
    // sourceBpm + enabling auto-tempo. Powers drag-to-stretch + Fit/×2 helpers. Undoable.
    case "stretch_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      if (f.clip.type !== "wave") return err(command, "not an audio clip");
      if (!("length" in args) && !("bars" in args)) return err(command, "missing 'length' or 'bars'");
      const sourceLen = num(f.clip.sourceLength, f.clip.length) || f.clip.length || 1;
      const projectBpm = snapshot.session.tempo || 120;
      pushUndo();
      let target: number;
      if ("bars" in args) {
        const bars = num(args.bars, 0);
        if (bars <= 0) return err(command, "'bars' must be > 0");
        target = (bars * (snapshot.session.timeSigNumerator ?? 4) * 60) / projectBpm;
      } else {
        target = num(args.length, f.clip.length);
        if (target <= 0) return err(command, "'length' must be > 0");
      }
      const sourceBpm = Math.max(20, Math.min(999, (projectBpm * target) / sourceLen));
      f.clip.autoTempo = true;
      f.clip.stretchMode = f.clip.stretchMode ?? "SoundTouch (Better)";
      f.clip.sourceBpm = sourceBpm;
      f.clip.length = (sourceLen * sourceBpm) / projectBpm; // == target (unless clamped)
      invalidate();
      return ok(command, { clipId: f.clip.id, sourceBpm, length: f.clip.length });
    }
    // Read-only BPM estimate. No real audio in the dev mock → deterministic stub.
    case "detect_clip_bpm": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "no wave clip: " + str(args.clipId));
      if (f.clip.type !== "wave") return err(command, "no wave clip: " + str(args.clipId));
      return ok(command, { clipId: f.clip.id, bpm: num(f.clip.sourceBpm, 120) || 120, confidence: 0.8 });
    }

    // ── recording transport + take lanes (comp tree) ─────────────────────────
    // No audio I/O in the browser dev mock, so "recording" is simulated against
    // session state: arming flags the track; stop_recording lands a take on each
    // armed track. Repeat recordings stack onto the same clip's native take tree
    // (the UI shows lanes once a clip has ≥2 takes); set_current_take / keep_take
    // act on that tree. arm/monitor mirror the backend's transport-config nature
    // (non-undoable); landing/comping a take IS a document edit (undoable).
    case "arm_track": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      t.armed = Boolean(args.armed); invalidate(); return ok(command, { armed: t.armed });
    }
    case "set_input_monitor": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      const mode = str(args.mode, "automatic");
      t.monitor = mode === "off" || mode === "on" ? mode : "automatic";
      invalidate(); return ok(command, { monitor: t.monitor });
    }
    case "stop_recording": {
      stopPlayback();
      snapshot.transport = { ...snapshot.transport, playing: false, recording: false };
      emit("transport", snapshot.transport);
      if (Boolean(args.discardRecordings)) { invalidate(); return ok(command, { clips: [] }); }
      pushUndo(); // bracket only the actual take landing (the undoable document edit)
      const armed = snapshot.tracks.filter((t) => t.armed);
      const targets = armed.length ? armed : snapshot.tracks[0] ? [snapshot.tracks[0]] : [];
      const landed: { id: string }[] = [];
      for (const t of targets) {
        // Stack onto an existing take-bearing clip if present, else start one.
        const existing = t.clips.find((c) => c.takes && c.takes.length > 0);
        if (existing && existing.takes) {
          const idx = existing.takes.length;
          existing.takes.forEach((tk) => (tk.isCurrent = false));
          existing.takes.push({ index: idx, description: `Take ${idx + 1}`, isCurrent: true });
          existing.numTakes = existing.takes.length;
          existing.currentTakeIndex = idx;
          landed.push({ id: existing.id });
        } else {
          const c = waveClip("take", Math.max(0, snapshot.transport.position - 2), 2);
          c.takes = [{ index: 0, description: "Take 1", isCurrent: true }];
          c.numTakes = 1; c.currentTakeIndex = 0;
          t.clips.push(c);
          landed.push({ id: c.id });
        }
      }
      invalidate(); return ok(command, { clips: landed });
    }
    case "list_takes": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      const takes = f.clip.takes ?? [];
      return ok(command, { takes, numTakes: f.clip.numTakes ?? takes.length, currentTakeIndex: f.clip.currentTakeIndex ?? 0 });
    }
    case "set_current_take": {
      const f = findClip(str(args.clipId)); if (!f?.clip.takes) return err(command, "clip has no takes");
      const idx = num(args.takeIndex);
      if (idx < 0 || idx >= f.clip.takes.length) return err(command, "take index out of range");
      pushUndo();
      f.clip.takes.forEach((tk) => (tk.isCurrent = tk.index === idx));
      f.clip.currentTakeIndex = idx;
      invalidate(); return ok(command);
    }
    case "keep_take": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      if (!f.clip.takes || f.clip.takes.length === 0) return err(command, "clip has no takes");
      pushUndo();
      const cur = f.clip.currentTakeIndex ?? f.clip.takes.findIndex((tk) => tk.isCurrent);
      const kept = f.clip.takes[cur >= 0 ? cur : 0] ?? f.clip.takes[0];
      if (kept?.description) f.clip.name = kept.description; // flatten the comp to the kept take
      delete f.clip.takes; delete f.clip.numTakes; delete f.clip.currentTakeIndex;
      invalidate(); return ok(command);
    }
    case "mark_take": {
      emit("controller_event", args);
      return ok(command);
    }

    case "set_tempo": { pushUndo(); snapshot.session.tempo = Math.max(20, num(args.bpm, snapshot.session.tempo)); invalidate(); return ok(command); }
    case "set_key": { pushUndo(); snapshot.session.key = { tonic: str(args.tonic, snapshot.session.key?.tonic ?? "A"), mode: str(args.mode, snapshot.session.key?.mode ?? "minor") }; invalidate(); return ok(command); }
    case "set_count_in": {
      const bars = num(args.bars, snapshot.session.countInBars ?? 0);
      if (![0, 1, 2].includes(bars)) return err(command, "bars must be 0 (off), 1 (one bar), or 2 (two bars)");
      // Preference — NOT undoable (mirrors native's logLine(..., false); see cmdSetCountIn
      // in MoshOps.cpp). No pushUndo() here, unlike the mutation commands above.
      snapshot.session.countInBars = bars; invalidate(); return ok(command);
    }
    case "set_master_volume": { pushUndo(); if (snapshot.master) snapshot.master.volumeDb = num(args.db); invalidate(); return ok(command); }

    case "undo": {
      if (!history.length) return ok(command, { undone: false });
      future.push(clone(snapshot)); snapshot = history.pop()!; stopPlayback(); invalidate(); return ok(command, { undone: true });
    }
    case "redo": {
      if (!future.length) return ok(command, { redone: false });
      history.push(clone(snapshot)); snapshot = future.pop()!; stopPlayback(); invalidate(); return ok(command, { redone: true });
    }
    case "batch_begin": {
      if (inBatch) return err(command, "a batch is already open");
      pushUndo(); inBatch = true; return ok(command);
    }
    case "batch_end": {
      if (!inBatch) return err(command, "no batch is open");
      inBatch = false; invalidate(); return ok(command);
    }
    case "save": case "reload": return ok(command);

    case "get_clip_peaks": {
      const f = findClip(str(args.clipId));
      const buckets = Math.max(8, Math.min(2000, num(args.buckets, 800)));
      const peaks = makePeaks(f?.clip ?? null, buckets);
      return ok(command, { peaks });
    }
    // file_peaks / audition — sample-browser thumbnail + preview seam. The mock can't
    // read real files or play audio, so it returns a synthetic waveform + a no-sound
    // ack (faithful to the backend's command shape; real audio lives in the app).
    case "file_peaks": {
      if (!str(args.path)) return err(command, "missing 'path'");
      const buckets = Math.max(16, Math.min(4000, num(args.buckets, 200)));
      const peaks = Array.from({ length: buckets }, (_, i) => {
        const a = 0.15 + 0.8 * Math.abs(Math.sin(i / 5) * Math.cos(i / 17));
        return [-a, a] as [number, number];
      });
      return ok(command, { path: str(args.path), buckets, peaks });
    }
    case "audition_file":
      return str(args.path) ? ok(command, { path: str(args.path), playing: false }) : err(command, "missing 'path'");
    case "stop_audition":
      return ok(command);

    // ── plugins ────────────────────────────────────────────────
    case "list_plugins": return ok(command, { plugins: VST3S, counts: { vst3: VST3S.length, au: 0, total: VST3S.length } });
    case "list_builtins": return ok(command, { plugins: BUILTINS });
    // FIT-003 — an explicit case (was a bare DEFAULT_OK passthrough returning no
    // `status`, which store.rescanPlugins() then read as `undefined !== "scanning"`
    // and treated as already-done — harmless for the real always-instant dev catalog,
    // but it meant vitest/e2e never exercised the real "scanning" branch of the store
    // action). Real: no dev-mock AU sweep, so this always completes synchronously.
    case "rescan_plugins": return ok(command, { status: "done", count: VST3S.length });
    case "set_master_pan": { pushUndo(); if (snapshot.master) snapshot.master.pan = num(args.pan); invalidate(); return ok(command); }
    case "enable_all_meters": case "enable_track_meter": case "disable_track_meter": return ok(command);
    case "list_wave_inputs": return ok(command, { inputs: MOCK_WAVE_INPUTS, audioEnabled: true });
    case "list_midi_inputs": return ok(command, { inputs: MOCK_MIDI_INPUTS, audioEnabled: true });
    case "list_track_outputs": return ok(command, {
      outputs: MOCK_OUTPUT_DEVICES,
      tracks: snapshot.tracks.filter((t) => !t.isGroup && !t.isReturn).map((t) => ({ id: t.id, name: t.name })),
      audioEnabled: true,
    });
    case "set_track_output": {
      // RTG-002 — an Edit mutation (undoable). Three destination forms mirror the
      // native cmdSetTrackOutput: destTrackId (implicit submix), deviceID (hardware
      // out), or output:"default" (reset). Cycle + self rejection match the backend.
      const t = snapshot.tracks.find((tr) => tr.id === str(args.trackId));
      if (!t) return err(command, "no track");
      if (typeof args.destTrackId === "string") {
        const destId = str(args.destTrackId);
        const dest = snapshot.tracks.find((tr) => tr.id === destId);
        if (!dest) return err(command, "no destination track: " + destId);
        if (dest.id === t.id) return err(command, "a track cannot output to itself");
        if (outputFeedsInto(dest, t.id)) return err(command, "routing would create a cycle");
        pushUndo();
        t.output = { isTrack: true, destId, name: dest.name };
        invalidate();
        return ok(command, { trackId: t.id, destTrackId: destId });
      }
      if (typeof args.deviceID === "string") {
        const deviceID = str(args.deviceID);
        if (!deviceID) return err(command, "empty 'deviceID'");
        const dev = MOCK_OUTPUT_DEVICES.find((d) => d.deviceID === deviceID);
        pushUndo();
        t.output = { isTrack: false, deviceID, name: dev?.name ?? deviceID };
        invalidate();
        return ok(command, { trackId: t.id, deviceID });
      }
      if (str(args.output) === "default") {
        pushUndo();
        delete t.output;
        invalidate();
        return ok(command, { trackId: t.id, output: "default" });
      }
      return err(command, "expected 'destTrackId', 'deviceID', or output:'default'");
    }

    // ── settings / export / command log (topbar utilities) ───────────────────
    case "list_audio_devices": return ok(command, {
      types: [{ name: "CoreAudio", outputs: ["MacBook Pro Speakers", "External Headphones"], inputs: ["MacBook Pro Microphone", "Scarlett 2i2"] }],
      current: { ...mockAudioSel, sampleRate: SR, bufferSize: snapshot.session.bufferSize ?? 512 },
      sampleRates: [44100, 48000, 96000], bufferSizes: [128, 256, 512, 1024], defaultBufferSize: 512, audioEnabled: true,
    });
    case "set_buffer_size": { if (snapshot.session) snapshot.session.bufferSize = num(args.bufferSize, 512); invalidate(); return ok(command); }
    case "set_audio_threads": { if (snapshot.session) { snapshot.session.audioThreads = num(args.threads, 8); snapshot.session.audioThreadsAuto = false; } invalidate(); return ok(command); }
    case "set_audio_device": {
      // Machine preference (undoable:false on the backend) — reflect into the mock
      // selection so the next list_audio_devices shows the new device.
      if (typeof args.outputDevice === "string") mockAudioSel.outputDevice = args.outputDevice;
      if (typeof args.inputDevice === "string") mockAudioSel.inputDevice = args.inputDevice;
      if (typeof args.type === "string") mockAudioSel.type = args.type;
      return ok(command);
    }
    case "set_track_input": {
      // RTG-001 — a routing preference (undoable:false). Stamp the track's input
      // field so the picker reflects the choice. Empty deviceID clears the input.
      const t = snapshot.tracks.find((tr) => tr.id === str(args.trackId));
      if (!t) return err(command, "no track");
      const deviceID = str(args.deviceID);
      if (deviceID) {
        // The chosen input may be a wave OR a MIDI device (CTL-001 instrument tracks) —
        // both are the deviceID-keyed "explicitly-chosen input". Resolve its name from
        // whichever enumeration owns it so the picker reflects a readable label.
        const dev = MOCK_WAVE_INPUTS.find((w) => w.deviceID === deviceID)
          ?? MOCK_MIDI_INPUTS.find((m) => m.deviceID === deviceID);
        t.input = { deviceID, name: dev?.name };
      } else {
        delete t.input;
      }
      invalidate();
      return ok(command);
    }
    case "set_project_settings": case "open_project": case "open_recent": case "save_as": return ok(command);
    // New project = a fresh empty edit (createEmptyEdit on the native side). Resets to a
    // blank session and clears undo history — you can't undo across a New, same as a DAW.
    case "new_project": {
      snapshot = emptySession();
      history.length = 0; future.length = 0;
      stopPlayback();
      invalidate();
      return ok(command);
    }
    case "relink_clip": return ok(command);   // gap 3 — re-point a missing wave source (mock no-op)
    case "set_metronome": { pushUndo(); snapshot.session.metronome = Boolean(args.enabled); invalidate(); return ok(command); }
    case "set_time_signature": {
      pushUndo();
      snapshot.session.timeSigNumerator = Math.max(1, num(args.numerator, snapshot.session.timeSigNumerator));
      snapshot.session.timeSigDenominator = num(args.denominator, snapshot.session.timeSigDenominator);
      invalidate(); return ok(command);
    }
    case "export_audio": return ok(command, { file: str(args.file) || "/mock/mixdown." + str(args.format, "wav"), format: str(args.format, "wav"), bitDepth: num(args.bitDepth, 24), sampleRate: num(args.sampleRate, SR), bytes: 794000, renderMode: "offline" });
    case "get_command_log": {
      const limit = Math.max(1, num(args.limit, 50));
      return ok(command, { entries: cmdLog.slice(-limit).reverse(), total: cmdLog.length });
    }

    case "load_builtin": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      const b = BUILTINS.find((x) => x.type === str(args.type)); if (!b) return err(command, "unknown builtin");
      pushUndo(); t.plugins = t.plugins ?? [];
      t.plugins.push({ index: t.plugins.length, name: b.name, type: b.type, enabled: true, external: false, builtin: true, category: b.category, isInstrument: b.isInstrument, params: mkBuiltinParams(b.type, b.isInstrument), moshFx: mkMoshFx(b.type) });
      invalidate(); return ok(command);
    }
    case "load_plugin": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      const v = VST3S.find((x) => x.id === str(args.pluginId)); if (!v) return err(command, "unknown plugin");
      pushUndo(); t.plugins = t.plugins ?? [];
      t.plugins.push({ index: t.plugins.length, name: v.name, type: v.format, enabled: true, external: true, isInstrument: v.isInstrument, params: mkParams(6) });
      invalidate(); return ok(command);
    }
    case "bypass_plugin": { const f = findPlugin(str(args.trackId), num(args.index)); if (!f) return err(command, "plugin not found"); pushUndo(); f.track.plugins![f.idx].enabled = !Boolean(args.bypassed); invalidate(); return ok(command); }
    case "remove_plugin": { const f = findPlugin(str(args.trackId), num(args.index)); if (!f) return err(command, "plugin not found"); pushUndo(); f.track.plugins!.splice(f.idx, 1); reindex(f.track); invalidate(); return ok(command); }
    case "reorder_plugin": {
      const f = findPlugin(str(args.trackId), num(args.index)); if (!f) return err(command, "plugin not found");
      const to = num(args.toIndex); if (to < 0 || to >= f.track.plugins!.length) return ok(command);
      pushUndo(); const [p] = f.track.plugins!.splice(f.idx, 1); f.track.plugins!.splice(to, 0, p); reindex(f.track); invalidate(); return ok(command);
    }
    case "set_plugin_param": {
      const f = findPlugin(str(args.trackId), num(args.index)); if (!f) return err(command, "plugin not found");
      const p = f.track.plugins![f.idx].params?.find((x) => x.index === num(args.paramIndex)); if (p) p.value = num(args.value);
      invalidate(); return ok(command);
    }
    case "open_plugin_editor": return ok(command);

    // Route C.2 — real-time RAVE insert (dev-mock; the real one is anira+LibTorch).
    case "add_rave_insert": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      pushUndo(); t.plugins = t.plugins ?? [];
      t.plugins.push({ index: t.plugins.length, name: "RAVE", type: "rave", enabled: true, external: false, isInstrument: false, params: [],
        rave: { model: "rave", modelName: "", modelLoaded: false, mix: 100, latencySeconds: 2048 / SR } });
      invalidate(); return ok(command, { index: t.plugins.length - 1, modelLoaded: false });
    }
    case "set_rave_param": {
      const f = findPlugin(str(args.trackId), num(args.index)); if (!f?.track.plugins![f.idx].rave) return err(command, "not a rave insert");
      if (str(args.paramId, "mix") === "mix") f.track.plugins![f.idx].rave!.mix = num(args.value);
      invalidate(); return ok(command);
    }
    case "load_rave_model": {
      const f = findPlugin(str(args.trackId), num(args.pluginIndex)); if (!f?.track.plugins![f.idx].rave) return err(command, "not a rave insert");
      pushUndo(); const r = f.track.plugins![f.idx].rave!;
      const p = str(args.path) || str(args.target);
      r.modelPath = str(args.path) || undefined;
      r.modelName = (p.split("/").pop() || p).replace(/\.ts$/, "");
      r.model = r.modelName; r.modelLoaded = true;
      invalidate(); return ok(command, { applied: true });
    }
    case "reset_rave": return ok(command);

    // ── parameter automation (buried editor) ─────────────────────────────────
    case "add_automation_point": case "set_automation_point": case "remove_automation_point": case "clear_automation": {
      const f = findPlugin(str(args.trackId), num(args.pluginIndex));
      const p = f?.track.plugins![f.idx].params?.find((x) => x.index === num(args.paramIndex));
      if (!p) return err(command, "param not found");
      pushUndo();
      p.points = p.points ?? [];
      if (command === "add_automation_point") p.points.push({ t: Math.max(0, num(args.time)), v: Math.min(1, Math.max(0, num(args.value))) });
      else if (command === "set_automation_point") { const pt = p.points[num(args.pointIndex)]; if (pt) { pt.t = Math.max(0, num(args.time)); pt.v = Math.min(1, Math.max(0, num(args.value))); } }
      else if (command === "remove_automation_point") p.points.splice(num(args.pointIndex), 1);
      else p.points = [];
      p.automated = p.points.length > 0;
      invalidate(); return ok(command);
    }

    // ── generative (Tier-B) render layers ────────────────────────────────────
    // sa3: true matches the mock's existing posture (a populated colour rack always implied
    // SA3 before this field existed) — dev/e2e keep seeing the "SA3" badge, not a spurious
    // "preview" one now that the badge reads /colors' honest field instead of the old proxy.
    case "list_colors": return ok(command, { colors: COLORS, sa3: true });
    // list_loras keeps #343's no-cap shape (maxActive removed per the owner "no cap" directive;
    // the LorasResponse type no longer carries maxActive, so re-adding it would not typecheck).
    case "list_loras": return ok(command, { loras: LORAS });
    case "list_rave_models":   // Lane B — RAVE model browser fixture
      return ok(command, { models: [
        { name: "guitar", sizeMB: 156 }, { name: "piano", sizeMB: 143 },
        { name: "sax", sizeMB: 116 }, { name: "vocals", sizeMB: 156 },
      ], available: true });
    case "list_transform_targets":
      // Mock posture: a fully-equipped dev Mac (matches the fake transform tier's
      // freeText:true — no real RAVE model — but every per-feature venv "installed").
      // e2e/vitest that need a guest-Mac (degraded) posture set `capabilities` directly
      // via the dev-only window.__moshStore handle rather than branching the mock here.
      return ok(command, {
        targets: ["violin", "flute", "choir", "strings", "orchestra", "synth pad", "music box", "brass"],
        freeText: true,
        capabilities: { transcribe: true, skeleton: true, whisper: true, phonology: true, transformReal: false, trainingBackend: "fake" },
      });
    case "create_render_layer": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo();
      f.clip.hasRenderLayer = true;
      const mode = str(args.mode, "reimagine");
      f.clip.renderLayer = { id: "rl-" + f.clip.id, status: "dirty", adapter: str(args.adapter, "fake"), mode, seed: 1, userKept: false, hasArtifact: false, nl: 0.45, colors: [], loras: [],
        ...(mode === "transform" ? { target: "", strength: 65 } : {}) };
      invalidate(); return ok(command);
    }
    case "set_render_param": {
      const f = findClip(str(args.clipId)); if (!f?.clip.renderLayer) return err(command, "no render layer");
      const rl = f.clip.renderLayer;
      if ("colors" in args) rl.colors = args.colors as RenderLayer["colors"];
      if ("loras" in args) rl.loras = (args.loras as RenderLayer["loras"] ?? []);
      if ("prompt" in args) rl.prompt = str(args.prompt, rl.prompt ?? "");
      if ("nl" in args) rl.nl = num(args.nl, rl.nl);
      if ("seed" in args) rl.seed = num(args.seed, rl.seed);
      if ("target" in args) rl.target = str(args.target, rl.target ?? "");
      if ("strength" in args) rl.strength = num(args.strength, rl.strength ?? 65);
      rl.status = "dirty"; rl.hasArtifact = false;
      invalidate(); return ok(command);
    }
    case "render_layer": {
      const f = findClip(str(args.clipId)); if (!f?.clip.renderLayer) return err(command, "no render layer");
      if (f.clip.renderLayer.mode === "sing") {
        if (!f.track.lyricSheet)
          return err(command, "sing needs a lyric sheet on the clip's track (build a flow from a take first)");
        if (!f.track.lyricSheet.lines.some((l) => l.singable))
          return err(command, "no asserted words to sing — assert the lyric line first");
      }
      f.clip.renderLayer.status = "ready"; f.clip.renderLayer.hasArtifact = true;
      // SING never auto-applies (mirrors MoshOps::finalizeRender): the guide vocal lands as an
      // auditionable artifact for the legacy accept/reject flow — it must not replace the take.
      if (f.clip.renderLayer.mode === "sing") { /* ready + hasArtifact only */ }
      // Wave clips auto-apply in place: the render becomes the clip's audio + Reset becomes available.
      else if (f.clip.type === "wave") { f.clip.renderLayer.appliedInPlace = true; f.clip.renderLayer.hasOriginal = true; }
      else {
        // MIDI/drum (Phase 2): the render lands as HIDDEN audio on a dedicated, snapshot-EXCLUDED
        // track (a synth on the source track would silence it), so the UI never sees a hidden clip —
        // it just sees the MIDI muted + the reimagineActive marker (+ Reset).
        f.clip.mute = true;
        f.clip.renderLayer.reimagineActive = true;
      }
      emit("layer_status", { clipId: f.clip.id, qa: { pq: 5.1, pq_base: 5.66, flags: ["quality_degraded"], adapter: f.clip.renderLayer.adapter, reasoning: "Fair production quality (5.1/10); fair enjoyment; flagged: quality_degraded." } });
      invalidate(); return ok(command);
    }
    case "reset_render_layer": {
      const f = findClip(str(args.clipId)); if (!f?.clip.renderLayer) return err(command, "no render layer");
      if (f.clip.type === "wave") { f.clip.renderLayer.appliedInPlace = false; }
      else {
        // MIDI/drum: drop the hidden audio (on its excluded track), un-mute the source, clear the marker.
        f.clip.mute = false;
        f.clip.renderLayer.reimagineActive = false;
      }
      f.clip.renderLayer.status = "dirty"; invalidate(); return ok(command);
    }
    case "accept_render": case "freeze_layer": case "bounce_layer_to_clip": {
      const f = findClip(str(args.clipId)); if (!f?.clip.renderLayer) return err(command, "no render layer");
      pushUndo();
      f.clip.renderLayer.userKept = true;
      f.clip.renderLayer.status = command === "freeze_layer" ? "frozen" : command === "bounce_layer_to_clip" ? "bounced" : "ready";
      invalidate(); return ok(command);
    }
    case "render_ahead_arm": {
      const f = findClip(str(args.clipId)); if (!f?.clip.renderLayer) return err(command, "no render layer");
      if (f.clip.type !== "wave") return err(command, "live render-ahead is wave-clip only (v1)");
      const armed = args.armed === undefined ? true : Boolean(args.armed);
      f.clip.renderLayer.liveArmed = armed;
      if (armed) { f.clip.renderLayer.appliedInPlace = true; f.clip.renderLayer.hasOriginal = true; f.clip.renderLayer.status = "ready"; }
      invalidate(); return ok(command, { armed });
    }
    case "reject_render": { const f = findClip(str(args.clipId)); if (f?.clip.renderLayer) { f.clip.renderLayer.status = "dirty"; f.clip.renderLayer.userKept = false; invalidate(); } return ok(command); }
    case "bypass_layer": { const f = findClip(str(args.clipId)); if (f?.clip.renderLayer) { f.clip.renderLayer.status = Boolean(args.bypassed) ? "bypassed" : "ready"; invalidate(); } return ok(command); }
    case "cancel_render": { const f = findClip(str(args.clipId)); if (f?.clip.renderLayer) { f.clip.renderLayer.status = "dirty"; invalidate(); } return ok(command); }
    case "remove_render_layer": { const f = findClip(str(args.clipId)); if (f) { pushUndo(); f.clip.hasRenderLayer = false; delete f.clip.renderLayer; invalidate(); } return ok(command); }
    case "compile_render": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      const r = mockCompile(str(args.instruction));
      if (r.mode !== "reimagine" && r.mode !== "transform")   // honest boundary: mutate nothing
        return ok(command, { mode: r.mode, backend: "fake", reasoning: r.reasoning, say: r.say, envelope: null, subtype: r.subtype, tool: r.tool });
      pushUndo();
      const env = r.envelope!;
      f.clip.hasRenderLayer = true;
      f.clip.renderLayer = {
        id: "rl-" + f.clip.id, status: "dirty", adapter: r.mode === "transform" ? "transform" : "fake",
        mode: r.mode, seed: num(env.seed, 1), userKept: false, hasArtifact: false,
        nl: num(env.nl, 0.4), colors: (env.colors as RenderLayer["colors"]) ?? [],
        ...(r.mode === "transform" ? { target: str(env.target, ""), strength: num(env.strength, 65) } : {}),
      };
      invalidate();
      return ok(command, { mode: r.mode, backend: "fake", reasoning: r.reasoning, envelope: env, say: null, layerId: f.clip.renderLayer.id });
    }

    // ── MIDI clips + notes (piano-roll) ──────────────────────────────────────
    case "add_midi_clip": {
      const t = findTrack(str(args.trackId)) ?? snapshot.tracks[0]; if (!t) return err(command, "no track");
      pushUndo();
      // DRM-001 — default-instrument policy: a MIDI clip on an instrument-less track
      // auto-loads the sane default so the notes are audible (drum track → sampler).
      ensureInstrument(t, t.type === "drum");
      // Phase 1 — empty by default (matches the backend: "+ MIDI" makes an empty
      // clip). A caller that passes `notes` seeds them; otherwise the clip is blank.
      const seed = Array.isArray(args.notes)
        ? (args.notes as Array<Record<string, unknown>>).map((n, k) => ({ i: k, pitch: num(n.pitch, 60), start: num(n.start, 0), length: num(n.length, 0.5), velocity: num(n.velocity, 100) }))
        : [];
      // Backend fidelity: cmdAddMidiClip honors `length` in seconds (insertMIDIClip
      // {start, start+length}); the hardcoded 4 here rejected legal splits on the
      // evalA {start:4,length:8} fixtures. Default stays 4 (backend default is 2.0;
      // aligning it would churn geometry in unrelated mock tests — tracked separately).
      const c: Clip = { id: nextClipId(), name: "midi", type: "midi", start: num(args.start, snapshot.transport.position), length: num(args.length, 4), offset: 0, hasRenderLayer: false, notes: seed };
      t.clips.push(c); invalidate(); return ok(command, { clipId: c.id });
    }
    case "add_note": {
      const f = findClip(str(args.clipId)); if (!f?.clip.notes) return err(command, "not a midi clip");
      pushUndo();
      f.clip.notes.push({ i: f.clip.notes.length, pitch: num(args.pitch, 60), start: num(args.start, 0), length: num(args.length, 0.5), velocity: num(args.velocity, 100) });
      reindexNotes(f.clip); invalidate(); return ok(command);
    }
    case "add_drum_pattern": {
      // DRM-002 — lay a whole drum grid in ONE undoable step (mirrors the native
      // handler exactly): validate + parse BEFORE mutating; clipId → per-lane
      // replace; instrument-less target → drum type + kit; wave-audio target →
      // error; start defaults to 0.0 (the NATIVE add_midi_clip default — not the
      // mock's transport-position divergence above).
      const parsed = parseDrumPattern(args.pattern, num(args.stepsPerBar, 16), num(args.bars, 0), num(args.velocity, 100));
      if (!parsed.ok) return err(command, parsed.error);
      const beatsPerBar = snapshot.session.timeSigNumerator ?? 4;
      const sb = stepBeats(beatsPerBar, parsed.stepsPerBar);
      const mkNotes = () => parsed.steps.map((s, k) => ({ i: k, pitch: s.pitch, start: s.step * sb, length: sb, velocity: s.velocity }));

      if (str(args.clipId)) {
        const f = findClip(str(args.clipId));
        if (!f || f.clip.type !== "midi" || !f.clip.notes) return err(command, "no midi clip with that id");
        pushUndo();
        const lanes = new Set(parsed.lanePitches);
        f.clip.notes = f.clip.notes.filter((n) => !lanes.has(n.pitch)).concat(mkNotes());
        reindexNotes(f.clip);
        invalidate();
        return ok(command, { clipId: f.clip.id, trackId: f.track.id, noteCount: f.clip.notes.length, steps: parsed.totalSteps, bars: parsed.bars });
      }

      let t = str(args.trackId) ? findTrack(str(args.trackId)) : null;
      if (str(args.trackId) && !t) return err(command, "no track with that id");
      if (t && t.clips.some((c) => c.type === "wave"))
        return err(command, "track holds wave audio — a drum sampler would silence it; use a drum track");
      pushUndo();
      if (!t) {
        t = { id: nextTrackId(), index: snapshot.tracks.length, name: "Drums", type: "drum", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [] };
        ensureInstrument(t, true);
        snapshot.tracks.push(t);
      } else if (!(t.plugins ?? []).some((p) => p.isInstrument)) {
        t.type = "drum";
        ensureInstrument(t, true);
      }
      const beatSec = (4 / (snapshot.session.timeSigDenominator ?? 4)) * (60 / snapshot.session.tempo);
      const notes = mkNotes();
      const c: Clip = { id: nextClipId(), name: str(args.name, "Drums"), type: "midi", start: num(args.start, 0), length: parsed.bars * beatsPerBar * beatSec, offset: 0, hasRenderLayer: false, notes };
      t.clips.push(c);
      invalidate();
      return ok(command, { clipId: c.id, trackId: t.id, noteCount: notes.length, steps: parsed.totalSteps, bars: parsed.bars });
    }
    case "transcribe_clip": {
      // Audio→MIDI (Basic Pitch) — async like the native path: emit working now, then
      // after a simulated inference land a new time-aligned MIDI track + emit done.
      const f = findClip(str(args.clipId));
      if (!f || f.clip.type !== "wave") return err(command, "no wave clip");
      const mode = str(args.mode, "mono");
      const src = f.clip;
      emit("transcribe_status", { clipId: src.id, state: "working", mode });
      scheduleMock(() => {
        pushUndo();
        const pitches = mode === "poly" ? [60, 64, 67] : [62, 64, 65, 67];
        const t: Track = {
          id: nextTrackId(), index: snapshot.tracks.length, name: "MIDI • " + src.name,
          type: "audio", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
        };
        t.clips.push({
          id: nextClipId(), name: "MIDI • " + src.name, type: "midi",
          start: src.start, length: Math.max(2, src.length), offset: 0, hasRenderLayer: false,
          notes: pitches.map((pitch, k) => ({ i: k, pitch, start: k * 0.5, length: 0.5, velocity: 100 })),
        });
        snapshot.tracks.push(t);
        emit("transcribe_status", { clipId: src.id, state: "done", noteCount: pitches.length });
        invalidate();
      }, 400);
      return ok(command, { status: "started" });
    }
    case "build_lyrics_from_clip": {
      // Mumble take (Phase 3) — async like the native path: emit working now, then after a
      // simulated transcribe+analyze land a deterministic lyric sheet on the clip's OWN
      // track (gapped seeds + one anchored word) + emit done. The Lyrics tab picks it up via
      // the snapshot. No real audio analysis here; the mock drives the same command contract.
      const f = findClip(str(args.clipId));
      if (!f || f.clip.type !== "wave") return err(command, "no wave clip");
      if (f.track.lyricSheet) return err(command, "track already has a lyric sheet");
      const clipId = f.clip.id;
      const trk = f.track;
      emit("build_lyrics_status", { clipId, state: "working" });
      scheduleMock(() => {
        pushUndo();
        const mk = (index: number, seedText: string, rg: string, target: number, stress: string): LyricLine => ({
          index, role: "verse", seedText, text: "", syllableTarget: target, syllableTol: 1,
          stress, rhymeGroup: rg, rhymeStrictness: "", locked: false, sectionId: "", status: "seed",
        });
        trk.lyricSheet = {
          id: `ls-${trk.id}`, grid: "1/16", language: "en", topic: "", mood: "",
          explicit: "allow", rhymeStrictness: "slant", styleBias: false, specVersion: 1,
          lines: [
            mk(0, "___ ___ ___ fire", "A", 4, "XxxX"),
            mk(1, "___ ___ ___", "B", 3, "XxX"),
          ],
        };
        emit("build_lyrics_status", { clipId, state: "done", lineCount: 2 });
        invalidate();
      }, 400);
      return ok(command, { status: "started" });
    }
    case "build_skeleton_from_clip": {
      // Phase-2 mumble->skeleton — gibberish (no words). Async like the native path: emit
      // working, then land a deterministic WORDLESS sheet (all-gaps seeds, lines `proposed`)
      // on the clip's OWN track. The Lyrics tab renders the grid editor (confirm_skeleton).
      const f = findClip(str(args.clipId));
      if (!f || f.clip.type !== "wave") return err(command, "no wave clip");
      if (f.track.lyricSheet) return err(command, "track already has a lyric sheet");
      const clipId = f.clip.id;
      const trk = f.track;
      emit("skeleton_status", { clipId, state: "working" });
      scheduleMock(() => {
        pushUndo();
        const mk = (index: number, target: number, rg: string, stress: string): LyricLine => ({
          index, role: "verse", seedText: Array.from({ length: target }).fill("___").join(" "),
          text: "", syllableTarget: target, syllableTol: 1, stress, rhymeGroup: rg,
          rhymeStrictness: "", locked: false, sectionId: "", status: "skeleton",
          hasScore: true,   // Stage 1 lands the take's lyricScore with each skeleton line
          asserted: false, singable: false, hasHeard: false,
        });
        // Extraction parity: one line the take REALLY sang lands verbatim (native sets
        // text + gapless seed + status "seed" + origin "sung" — the loop skips it).
        const sung: LyricLine = {
          index: 2, role: "verse", seedText: "hold the flame", text: "hold the flame",
          syllableTarget: 3, syllableTol: 1, stress: "XxX", rhymeGroup: "A",
          rhymeStrictness: "", locked: false, sectionId: "", status: "seed",
          hasScore: true, hasHeard: true, origin: "sung",
        };
        trk.lyricSheet = {
          id: `ls-${trk.id}`, grid: "1/8", language: "en", topic: "", mood: "",
          explicit: "allow", rhymeStrictness: "slant", styleBias: false, specVersion: 1,
          lines: [mk(0, 4, "A", "XxxX"), mk(1, 3, "B", "XxX"), sung],
        };
        emit("skeleton_status", { clipId, state: "done", lineCount: 3 });
        invalidate();
      }, 400);
      return ok(command, { status: "started" });
    }
    case "confirm_skeleton": {
      // Flip every `proposed` line -> `seed` so the generation loop ("Finish gaps") fills it.
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      if (!t.lyricSheet) return err(command, "track has no lyric sheet");
      pushUndo();
      let n = 0;
      for (const l of t.lyricSheet.lines) if (l.status === "skeleton") { l.status = "seed"; n++; }
      invalidate();
      return ok(command, { confirmed: n });
    }
    case "sketch_beatbox": {
      // Sketch Phase 0 — beatbox WAV → drum MoshOps. Async like the native path:
      // emit working now, then after a simulated transduction set the tempo and land a
      // drum track carrying kick/snare/hat notes on the 16th grid. No audio analysis
      // here (no librosa); the mock plays a fixed, recognisable boom-bap so UI tests
      // exercise the same command contract the native cmdSketchBeatbox drives.
      const file = str(args.file, "");
      if (!file) return err(command, "no audio file");
      const bpm = num(args.bpm, 120);
      const bars = num(args.bars, 1) >= 2 ? 2 : 1;
      emit("sketch_status", { file, state: "working", bpm, bars });
      scheduleMock(() => {
        pushUndo();
        snapshot.session.tempo = Math.max(20, bpm);
        // role → GM pitch (mirrors kDefaultKit: kick 36, snare 38, closed hat 42).
        const PITCH: Record<string, number> = { kick: 36, snare: 38, hat: 42 };
        const hits: Array<{ step: number; role: string; velocity: number }> = [];
        for (let bar = 0; bar < bars; bar++) {
          const base = bar * 16;
          for (const s of [0, 8]) hits.push({ step: base + s, role: "kick", velocity: 112 });
          for (const s of [4, 12]) hits.push({ step: base + s, role: "snare", velocity: 100 });
          for (const s of [0, 2, 4, 6, 8, 10, 12, 14]) hits.push({ step: base + s, role: "hat", velocity: 80 });
        }
        const t: Track = {
          id: nextTrackId(), index: snapshot.tracks.length, name: "Sketch",
          type: "drum", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
        };
        ensureInstrument(t, true);
        t.clips.push({
          id: nextClipId(), name: "Sketch", type: "midi",
          // Loop length mirrors the native cmdSketchBeatbox exactly: bars*4 beats * 60/bpm, no floor.
          start: 0, length: bars * 4 * 60 / Math.max(20, bpm), offset: 0, hasRenderLayer: false,
          notes: hits.map((h, k) => ({ i: k, pitch: PITCH[h.role], start: h.step / 4, length: 0.25, velocity: h.velocity })),
        });
        snapshot.tracks.push(t);
        emit("sketch_status", { file, state: "done", hitCount: hits.length });
        invalidate();
      }, 400);
      return ok(command, { status: "started" });
    }
    case "remove_note": {
      const f = findClip(str(args.clipId)); if (!f?.clip.notes) return err(command, "not a midi clip");
      pushUndo(); f.clip.notes.splice(num(args.noteIndex), 1); reindexNotes(f.clip); invalidate(); return ok(command);
    }
    case "set_note": {
      const f = findClip(str(args.clipId)); const n = f?.clip.notes?.[num(args.noteIndex)]; if (!n) return err(command, "note not found");
      pushUndo();
      if ("start" in args) n.start = Math.max(0, num(args.start, n.start));
      if ("pitch" in args) n.pitch = Math.max(0, Math.min(127, num(args.pitch, n.pitch)));
      if ("length" in args) n.length = Math.max(0.05, num(args.length, n.length));
      if ("velocity" in args) n.velocity = Math.max(1, Math.min(127, num(args.velocity, n.velocity)));
      invalidate(); return ok(command);
    }
    case "quantize_notes": {
      const f = findClip(str(args.clipId)); if (!f?.clip.notes) return err(command, "not a midi clip");
      const div = num(args.division, 1); if (div > 0) { pushUndo(); for (const n of f.clip.notes) n.start = Math.round(n.start / div) * div; invalidate(); }
      return ok(command);
    }

    // ── content browser (read-only directory listing) ────────────────────────
    case "list_directory": {
      const path = str(args.path) || "/Users/you";
      return ok(command, {
        path, parent: path === "/" ? null : path.replace(/\/[^/]+$/, "") || "/", exists: true, error: null,
        roots: [{ name: "Home", path: "/Users/you" }, { name: "Desktop", path: "/Users/you/Desktop" }, { name: "Downloads", path: "/Users/you/Downloads" }],
        entries: [
          { name: "Samples", path: path + "/Samples", isDir: true, size: null },
          { name: "Loops", path: path + "/Loops", isDir: true, size: null },
          { name: "kick.wav", path: path + "/kick.wav", isDir: false, size: 240000 },
          { name: "snare.wav", path: path + "/snare.wav", isDir: false, size: 180000 },
          { name: "vocal_take.wav", path: path + "/vocal_take.wav", isDir: false, size: 4200000 },
        ],
      });
    }

    // ── rights-cleared type-beat training ────────────────────────────────────
    case "import_training_source": {
      const state = trainingState();
      const id = str(args.sourceId, `beat-${String(state.sources.length + 1).padStart(3, "0")}`);
      const src = {
        index: state.sources.length,
        source_id: id,
      title: str(args.title, "Untitled Type Beat"),
      creator: str(args.creator, "Unknown"),
      source_url: str(args.sourceUrl),
      local_path: str(args.localPath),
      user_claimed_license: str(args.userClaimedLicense, str(args.licenseName, "")),
      license_name: str(args.userClaimedLicense, str(args.licenseName, "")),
      proof_of_rights: str(args.proofOfRights),
      approved_for_training: Boolean(args.approvedForTraining),
        expiration: (typeof args.expiration === "string" && args.expiration) ? String(args.expiration) : null,
        notes: str(args.notes, ""),
      };
      const existing = state.sources.findIndex((s) => s.source_id === id);
      if (existing >= 0) state.sources[existing] = src; else state.sources.push(src);
      invalidate();
      return ok(command, { source: src });
    }
    case "list_training_sources": {
      const state = trainingState();
      return ok(command, { registryPath: state.registryPath, sources: state.sources, sourceCount: state.sources.length });
    }
    case "approve_training_source": {
      const state = trainingState();
      const src = state.sources.find((s) => s.source_id === str(args.sourceId));
      if (!src) return err(command, "source not found");
      src.approved_for_training = Boolean(args.approved ?? true);
      invalidate();
      return ok(command, { source: src });
    }
    case "build_training_corpus": {
      const state = trainingState();
      const eligible = state.sources.filter((s) => s.approved_for_training && s.local_path);
      if (eligible.length === 0) return err(command, "no approved local sources available for training");
      const bundleId = str(args.bundleName, `corpus-${String(eligible.length).padStart(3, "0")}`);
      const bundleHash = `mock-${bundleId}-${eligible.length}`;
      const bundlePath = `/mock/training/corpora/${bundleId}`;
      const sources = eligible.map((s, index) => ({ ...s, index, copied_path: `${bundlePath}/sources/${String(index).padStart(3, "0")}-${s.source_id}.wav`, sha256: `mock-${s.source_id}`, bytes: 123456 }));
      const bundle = { bundleId, bundleHash, bundlePath, manifestPath: `${bundlePath}/corpus.manifest.json`, indexPath: `${bundlePath}/bundle.index.json`, sourceCount: sources.length, sources, skippedSources: state.sources.filter((s) => !eligible.includes(s)).map((s) => ({ source_id: s.source_id, reason: s.approved_for_training ? "missing local file" : "not approved_for_training" })) };
      state.activeCorpusHash = bundleHash;
      invalidate();
      return ok(command, bundle);
    }
    case "submit_training_job": {
      const state = trainingState();
      const bundlePath = str(args.corpusBundle);
      if (!bundlePath) return err(command, "missing corpusBundle");
      const jobId = `job-${Math.random().toString(36).slice(2, 8)}`;
      const outputDir = str(args.outputDir, `${bundlePath}/training-output/${jobId}`);
      const job = {
        jobId,
        status: "ready",
        progress: 1,
        bundlePath,
        outputDir,
        artifactPath: `${outputDir}/adapter.lora.json`,
        manifestPath: `${outputDir}/adapter.manifest.json`,
        error: "",
        result: {
          adapter_id: `adapter-${jobId}`,
          artifact_path: `${outputDir}/adapter.lora.json`,
          manifest_path: `${outputDir}/adapter.manifest.json`,
          bundle_hash: `mock-${bundlePath}`,
          quality: { stub: true },
        },
      };
      state.jobs = [...state.jobs.filter((j) => j.jobId !== jobId), job].slice(-20);
      state.adapters = [
        ...state.adapters.filter((a) => a.adapterId !== `adapter-${jobId}`),
        {
          adapterId: `adapter-${jobId}`,
          bundleHash: `mock-${bundlePath}`,
          bundlePath,
          artifactPath: job.artifactPath,
          manifestPath: job.manifestPath,
          active: false,
          quality: { stub: true },
        },
      ];
      invalidate();
      return ok(command, { jobId, bundlePath, outputDir });
    }
    case "training_job_status": {
      const state = trainingState();
      const job = state.jobs.find((j) => j.jobId === str(args.jobId));
      if (!job) return err(command, "unknown jobId");
      return ok(command, job);
    }
    case "cancel_training_job": {
      const state = trainingState();
      const job = state.jobs.find((j) => j.jobId === str(args.jobId));
      if (!job) return err(command, "unknown jobId");
      job.status = "cancelled";
      invalidate();
      return ok(command);
    }
    case "import_lora_adapter": {
      const state = trainingState();
      const job = str(args.jobId) ? state.jobs.find((j) => j.jobId === str(args.jobId)) : null;
      const result = (job?.result ?? {}) as { adapter_id?: string; bundle_hash?: string; quality?: Record<string, unknown> };
      const artifactPath = str(args.artifactPath, job?.artifactPath ?? "");
      const manifestPath = str(args.manifestPath, job?.manifestPath ?? "");
      const adapterId = str(args.adapterId, result.adapter_id ?? `adapter-${state.adapters.length + 1}`);
      const adapter = {
        adapterId,
        bundleHash: result.bundle_hash ?? `mock-${adapterId}`,
        bundlePath: job?.bundlePath ?? "",
        artifactPath,
        manifestPath,
        active: false,
        quality: result.quality ?? { stub: true },
      };
      state.adapters = [...state.adapters.filter((a) => a.adapterId !== adapterId), adapter];
      state.activeAdapterId = adapterId;
      state.activeAdapterPath = artifactPath;
      state.activeCorpusHash = adapter.bundleHash;
      invalidate();
      return ok(command, adapter);
    }
    case "activate_lora_adapter": {
      const state = trainingState();
      const adapter = state.adapters.find((a) => a.adapterId === str(args.adapterId));
      if (!adapter) return err(command, "adapter not found");
      state.activeAdapterId = adapter.adapterId;
      state.activeAdapterPath = adapter.artifactPath;
      state.activeCorpusHash = adapter.bundleHash;
      state.adapters = state.adapters.map((a) => ({ ...a, active: a.adapterId === adapter.adapterId }));
      invalidate();
      return ok(command, { adapterId: adapter.adapterId, adapterPath: adapter.artifactPath, corpusHash: adapter.bundleHash });
    }
    case "list_lora_adapters": {
      const state = trainingState();
      return ok(command, { activeAdapterId: state.activeAdapterId, activeAdapterPath: state.activeAdapterPath, activeCorpusHash: state.activeCorpusHash, adapters: state.adapters });
    }

    // MP-001 — multiplayer (mock peer harness). Simulates a 2-peer session where a
    // peer "Bo" holds the 2nd track and has it selected, so the UI shows a peer
    // roster, a locked-by badge, and a remote selection highlight without a relay.
    case "mp_create_session":
    case "mp_join_session": {
      for (const t of snapshot.tracks) if (!t.logicalId) t.logicalId = "lid-" + t.id;
      const code = command === "mp_create_session" ? "MOCK-ROOM-abcdef0123456789" : str(args.code);
      const locked = snapshot.tracks[1];
      const locks: Record<string, string> = {};
      if (locked?.logicalId) locks[locked.logicalId] = "bo";
      emit("mp_state", {
        active: true,
        roomCode: code,
        selfPeer: "me",
        peers: {
          me: { name: str(args.name) || "You", color: str(args.color) || "#3aa0ff", online: true },
          bo: { name: "Bo", color: "#e0457b", online: true },
        },
        locks,
      });
      if (locked) emit("peer_selection", { peerId: "bo", trackId: locked.id, clipId: locked.clips[0]?.id ?? null });
      emit("peer_presence", { peerId: "bo", position: 5.25, playing: true, recording: false });
      invalidate();   // surface the freshly-stamped logicalIds to the UI snapshot
      return ok(command, { code });
    }
    case "mp_leave_session": {
      emit("mp_state", { active: false, peers: {}, locks: {} });
      return ok(command);
    }
    case "mp_commit_track":
    case "mp_claim_track":
    case "mp_broadcast_selection":
    case "mp_send_signal": // WebRTC handshake passthrough — no loopback peer in the mock
      return ok(command);

    default:
      // Fail-closed (AL-017): only the intentional passthroughs no-op-succeed; any other
      // unmodeled command (crucially, a mutating one) surfaces as an error so the drift is
      // loud instead of a silent fake success.
      return DEFAULT_OK.has(command)
        ? ok(command)
        : err(command, `unhandled command in dev-mock: ${command}`);
  }
}

// Deterministic fake waveform — a couple of decaying sines so clips look alive.
function makePeaks(clip: Clip | null, buckets: number): [number, number][] {
  const seed = clip ? Number(clip.id) : 1;
  const out: [number, number][] = [];
  for (let i = 0; i < buckets; i++) {
    const x = i / buckets;
    const env = Math.exp(-2.2 * ((x * 4) % 1)) * (0.6 + 0.4 * Math.sin(seed + x * 40));
    const a = Math.abs(env) * (0.5 + 0.5 * Math.sin(x * 220 + seed));
    out.push([-a, a]);
  }
  return out;
}

// ── public seam used by bridge.ts ────────────────────────────────────────────

export function mockExecute<T = unknown>(command: unknown): Promise<T> {
  const c = command as { command: string; args?: Record<string, unknown> };
  const res = dispatch(c.command, c.args ?? {});
  if (!READONLY.has(c.command))
    cmdLog.push({ command: c.command, ok: res.ok, undoable: !NON_UNDOABLE.has(c.command), ts: Date.now() });
  return Promise.resolve(res as unknown as T);
}
export function mockSnapshot<T = unknown>(): Promise<T> {
  return Promise.resolve(clone(snapshot) as unknown as T);
}

// Test-only: re-seed the in-memory backend to a clean state between tests and
// stop the 30 Hz play timer (so a set_transport toggle leaves no open handle).
// This module is dev-mock only — a production `vite build` strips it entirely.
export function __resetMockForTests(): void {
  stopPlayback();
  // Reset the id counters too, so a fresh test session is fully deterministic —
  // two resets in one process now mint the same ids (mirroring the separate
  // processes the --dump / --replies offline flow runs in). Without this, the
  // seq climbs across resets and cross-call id matching silently breaks.
  clipSeq = 100;
  trackSeq = 10;
  snapshot = seedSnapshot();
  mockCorpusLines = 0;
  history.length = 0;
  future.length = 0;
  inBatch = false;
  cmdLog.length = 0;
}

// Test-only: inject a synthetic "mosh_event" of the given type/payload straight
// through the mock's listener set, exactly as the native bridge would deliver one.
// Used to cover reducers for events the mock backend doesn't otherwise simulate a
// realistic end-to-end trigger for (e.g. mp_commit_done — the native
// MultiplayerSession::emitCommitDone path has no mock-side upload to fail).
export function __emitMockEvent(type: string, payload?: unknown): void {
  emit(type, payload);
}
