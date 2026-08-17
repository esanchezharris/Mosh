// ── Browser dev-mock of the MoshOps contract ─────────────────────────────────
// An in-memory backend that implements the SAME execute_command + snapshot +
// events seam the C++ MoshOps exposes (docs/02_MOSHOPS_CONTRACT.md), so the React
// UI runs fully interactive in a plain browser (Vite dev) with no JUCE WebView.
//
// This exists ONLY to make the UI iterable with real DOM/CSS introspection — it
// is NOT the engine: bridge.ts enables it only in Vite development or explicit
// e2e mode when the real native backend is absent. Optimized e2e builds write to
// dist-e2e; production dist keeps MOCK_ENABLED false.
//
// Fidelity rule: the mock speaks the contract, not the engine. It returns the
// same { ok, command, data } envelopes, emits snapshot_invalidated on structural
// change and 30 Hz transport while playing, and keeps an undo/redo history — so
// behaviour the UI relies on is exercised, while audio/Tracktion concepts never
// appear (the swappable seam holds on the web side too).

import { DEFAULT_TRACK_GROUP_MIX_ATTRIBUTES, TRACK_GROUP_MIX_ATTRIBUTES } from "./types";
import type { Annotation, Snapshot, Clip, ClipGainPoint, ClipGroup, Track, TrackGroup, TrackGroupKind, TrackGroupMixAttribute, Transport, CommandResult, RenderLayer, TrainingState, MidiNote, Plugin, PluginParam, MoshFxReadout, LyricSheet, LyricLine } from "./types";
import { syllablesForWord, countSyllables } from "./lyrics/flowMeter";
import { parseDrumPattern, normalizeDrumVelocity } from "./ui/drumPatternUtil";
import { TRACK_ICONS, isTrackIconName } from "./trackIconNames";
import { stepBeats } from "./ui/drumGrid";
import { transformVelocities, splitmix64 } from "./midi/velocityTransform";
import { transformNotes, type NoteTransformMode } from "./midi/noteTransform";

export const MOCK_ENABLED: boolean =
  typeof import.meta !== "undefined" &&
  Boolean(
    import.meta.env?.MODE === "development" ||
    import.meta.env?.MODE === "e2e" ||
    import.meta.env?.MODE === "test"
  );

// ── seed session ─────────────────────────────────────────────────────────────

const SR = 48000;
let clipSeq = 100;
let trackSeq = 10;
let clipGroupSeq = 0;
let trackGroupSeq = 0;
// Layers whose render has already been landed on the "Neural Renders" lane, so a second
// accept/bounce does not duplicate the clip (native guards the same way, via its internal
// landedClipId). Module-local rather than a snapshot field — see the accept_render branch.
const landedLayers = new Set<string>();
const nextClipId = () => String(++clipSeq);
// Skill Foundry Slice B, Task 1 — deterministic, UUID-SHAPED fixture take ids, mirroring
// native state/TakeIdentity.h's lowercase-dashed-uuid shape (so dev/e2e/tests can assert
// on the same "looks like a stable id" shape without depending on crypto.randomUUID()'s
// real randomness). Monotonic per mock instance; never reused, never reassigned.
let mockTakeIdSeq = 0;
const nextTakeId = (): string => {
  const hex = (++mockTakeIdSeq).toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-000000000000`;
};
const nextTrackId = () => String(++trackSeq);
const nextClipGroupId = () => `clip-group-${++clipGroupSeq}`;
const nextTrackGroupId = () => `track-group-${++trackGroupSeq}`;
// Live 12's Space vs ⇧Space marker memory (mirrors MoshOps::cmdSetTransport)
let mockInsertMarker = 0;
let mockViaContinue = false;
let sectionSeq = 3; // seed uses sec-1..3
const nextSectionId = () => "sec-" + ++sectionSeq;
let annotationSeq = 1; // seed uses ann-1
const nextAnnotationId = () => "ann-" + ++annotationSeq;

// G4b — fade curve name -> te::AudioFadeCurve::Type int (1..4), mirroring the native enum.
const FADE_CURVE_TYPE: Record<string, number> = { linear: 1, convex: 2, concave: 3, sCurve: 4 };

function parseMockClipGainPoints(input: unknown): { ok: true; points: ClipGainPoint[] } | { ok: false; error: string } {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { ok: false, error: "points string must be valid JSON" };
    }
  }
  if (!Array.isArray(value)) return { ok: false, error: "points must be an array" };
  if (value.length > 4096) return { ok: false, error: "points must contain at most 4096 items" };

  const points: ClipGainPoint[] = [];
  let previousT = 0;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (item === null || typeof item !== "object")
      return { ok: false, error: "each point must be an object" };
    const record = item as Record<string, unknown>;
    const t = record.t;
    const gainDb = record.gainDb;
    const curve = record.curve;
    if (typeof t !== "number" || typeof gainDb !== "number" || !Number.isFinite(t) || !Number.isFinite(gainDb))
      return { ok: false, error: "point t and gainDb must be finite numbers" };
    if (Math.abs(t) > 604_800)
      return { ok: false, error: "point t must be within seven days of the visible clip start" };
    if (index > 0 && t <= previousT)
      return { ok: false, error: "points must be strictly ascending in t" };
    if (gainDb < -48 || gainDb > 6)
      return { ok: false, error: "point gainDb must be -48..+6" };
    if (curve !== undefined && (typeof curve !== "number" || !Number.isFinite(curve) || curve < -1 || curve > 1))
      return { ok: false, error: "point curve must be -1..1" };
    points.push(curve === undefined ? { t, gainDb } : { t, gainDb, curve });
    previousT = t;
  }
  return { ok: true, points };
}

// CAP-TRN-005 — te::DeviceManager::getDefaultAudioOutDeviceName(false), verbatim. The
// engine's findOutputDeviceWithName resolves this exact string to the current default
// wave out, so it is a routing VALUE, not a UI label — the mock has to spell it the same
// way the backend does or a round-trip through set_metronome would not match.
const DEFAULT_CLICK_OUTPUT = "(default audio output)";

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
    // G4b — default to 0/0 (linear) so the Clip tab's fade controls render deterministically.
    fadeInSec: 0,
    fadeOutSec: 0,
    fadeInType: 1,
    fadeOutType: 1,
    // clip-ops wave — default off, mirrors the native snapshot's unconditional serialization.
    reversed: false,
    autoCrossfade: false,
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

// REC-NO-INPUT dev/e2e fixture (declared before seedSnapshot, which reads it):
// ?mockNoInput=1 models a session with NO usable input (e.g. output on a
// mic-less loopback) — list_wave_inputs enumerates nothing, arm_track degrades
// EXACTLY like the engine (ok, applied:false, reason "no input device"), and
// set_transport record refuses with the engine's REC-NO-INPUT named error.
// ?mockNoInput=armed additionally pre-arms the first track — the
// stale-armed-after-device-switch case (arm skipped, the refusal does the talking).
const MOCK_NO_INPUT = new URLSearchParams(window.location.search).get("mockNoInput");

function seedSnapshot(): Snapshot {
  // Demo-accurate typed seed (dev/preview only): Drums = a drum step-grid (MIDI on a
  // drum track), Bass = MIDI note blocks, Keys = an audio waveform. 8s clips = 16 beats
  // = 4 bars at 120 BPM. Keep exactly 3 tracks (smoke asserts 3).
  const tracks: Track[] = [
    {
      id: nextTrackId(), index: 0, name: "Drums", type: "drum",
      volumeDb: 0, pan: 0, mute: false, solo: false, isInstrument: true,
      // REC-NO-INPUT fixture: ?mockNoInput=armed pre-arms this track (the
      // stale-armed-after-device-switch case — the record refusal does the talking).
      ...(MOCK_NO_INPUT === "armed" ? { armed: true } : {}),
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
      // SES-001 — the tempo MAP; point 0 IS the base tempo (set_tempo edits it,
      // remove_tempo_change refuses it), mirroring the native snapshot.
      tempoMap: [{ time: 0, bpm: 120, curve: 1 }],
      raveAvailable: true,   // Route C.2 — exercise the "+ RAVE" affordance in dev/e2e
      singVoiceEnrolled: false,  // FMS Phase-3 — dev/e2e exercise the not-enrolled copy
      metronome: false, countInBars: 0, length: 16, editFile: "/mock/session.mosh",
      // CAP-TRN-005 — the SAME defaults MoshOps::clickSettingsToVar returns for a project
      // that has never set them: engine level default 0.6, no bar emphasis, always
      // audible, no stored routing, built-in click samples, engine MIDI notes 37/76.
      click: {
        enabled: false, level: 0.6, levelMin: 0.2, levelMax: 1,
        emphasizeBars: false, recordingOnly: false,
        outputDevice: "", outputDeviceResolved: DEFAULT_CLICK_OUTPUT,
        defaultOutputDevice: DEFAULT_CLICK_OUTPUT,
        soundBig: "", soundSmall: "", midiNoteBig: 37, midiNoteSmall: 76,
      },
      // gap 2 — the Recent list the native snapshot carries (newest-first). Seeded so the
      // session picker and every Open-Recent surface have something real to render in dev
      // and e2e; kept in lockstep with `recentPaths` by syncRecents().
      recentProjects: [],
      audioEnabled: true, bitDepth: 24, bufferSize: 512,
      availableCores: 8, audioThreads: 8, audioThreadsAuto: true,
      key: { tonic: "A", mode: "minor" },
      // Dev/e2e boot fixture (no engine side — the failed-open state is HARDWARE):
      // ?mockAudioDead=1 seeds the DEGRADED session, so the Settings recovery
      // pickers + banner-clear flow are exercisable end-to-end. list_audio_devices
      // mirrors the engine while the error is set (enumerates regardless;
      // audioEnabled:false, empty selection); set_audio_device clears it.
      ...(new URLSearchParams(window.location.search).get("mockAudioDead") === "1"
        ? { audioEnabled: false,
            audioDeviceError: 'Audio device "External Headphones" could not open. Running WITHOUT audio — playback and recording are off. Press Retry.' }
        : {}),
      // REC-001 — seeded with the SAME defaults MoshOps::recordOptionsToVar returns for a
      // project that has never set them (overdub on, everything else off/none). A mock
      // that seeded something else would make the recording panel render one way in dev
      // and another way on a fresh real project.
      project: {
        sampleRate: 44100, bitDepth: 24, timeBase: "seconds", countInBars: 0,
        recordOptions: {
          overdub: true, replaceExisting: false, quantize: 0,
          quantizeLabel: "(none)", punchInOut: false, retrospectiveSeconds: 10,
        },
      },
    },
    tracks,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0, plugins: [] },
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

// Project lifecycle. The native side persists a Recent list in <session>/last-project.json
// and swaps the whole edit on open; the mock kept `open_project`/`open_recent` as bare
// `ok(command)` no-ops, so any Recent UI was invisible in dev and untestable in e2e.
// Stashing snapshots by path means reopening a project actually restores its content,
// which is what makes "Start empty, then go back" provable.
const mockProjects = new Map<string, Snapshot>();
let recentPaths: string[] = ["/mock/session.mosh", "/mock/late-night.mosh", "/mock/demo-2.mosh"];
const projectName = (p: string): string => (p.split("/").pop() ?? p).replace(/\.[^.]+$/, "");
function syncRecents(): void {
  snapshot.session.recentProjects = recentPaths.map((path) => ({ path, name: projectName(path) }));
}
/** Move `path` to the front of the Recent list (dedup'd), mirroring native rememberProject. */
function rememberProject(path: string): void {
  if (!path) return;
  recentPaths = [path, ...recentPaths.filter((p) => p !== path)].slice(0, 10);
}

let snapshot: Snapshot = seedSnapshot();
syncRecents();
let mockCorpusLines = 0; // §7 — simulates the cross-song style corpus growing on accept

// AGT-MEM (Phase-B memory lane, M1) — the agent-memory store, mirrored in-memory.
// The native store is real file I/O (src/moshops/AgentMemoryStore.h); the mock has
// no filesystem, so this is a plain in-process mirror of the SAME cap/eviction/
// explicit-protection contract (kept in lockstep by hand — no shared source with the
// C++ side, unlike DrumPattern.h/drumPatternUtil.ts, but the RULES are identical).
type AgentMemoryRecord = { ts: number; kind: string; explicit: boolean; item: unknown };
const AGENT_MEMORY_CAP = 500;
const AGENT_MEMORY_GLOBAL_KINDS = ["preference", "drum_pattern", "lyric_framework"] as const;
let mockAgentMemoryGlobal: Record<string, AgentMemoryRecord[]> = { preference: [], drum_pattern: [], lyric_framework: [] };
let mockAgentMemoryProject: AgentMemoryRecord[] = [];
let mockAgentMemoryTs = 0;   // a monotonic counter standing in for wall-clock ts (deterministic ordering in tests)

/** Mirrors AgentMemoryStore::decideEviction — see src/moshops/AgentMemoryStore.h for
 *  the full policy writeup. @p existing is oldest-first (push()-order), so "the
 *  oldest X" is simply the first matching index. */
function agentMemoryEvictIndex(
  existing: AgentMemoryRecord[],
  newExplicit: boolean,
  cap: number,
): { evictIndex: number; error?: string } {
  if (existing.length < cap) return { evictIndex: -1 };
  for (let i = 0; i < existing.length; i++) if (!existing[i].explicit) return { evictIndex: i };
  if (!newExplicit) return { evictIndex: -1, error: "memory full of explicit items -- remove one first" };
  return { evictIndex: 0 };   // every item is explicit AND the new one is explicit — evict the oldest explicit
}

/** Mirrors AgentMemoryStore::applyWrite: mutates @p existing in place; a rejected
 *  write leaves it completely unchanged. */
function agentMemoryApplyWrite(
  existing: AgentMemoryRecord[],
  record: AgentMemoryRecord,
  cap = AGENT_MEMORY_CAP,
): { ok: boolean; error?: string } {
  const d = agentMemoryEvictIndex(existing, record.explicit, cap);
  if (d.error) return { ok: false, error: d.error };
  if (d.evictIndex >= 0) existing.splice(d.evictIndex, 1);
  existing.push(record);
  return { ok: true };
}

/** Mirrors AgentMemoryStore::selectForRead: newest-first by ts (Array.prototype.sort
 *  is spec-guaranteed stable since ES2019), capped to @p limit (<=0 == no cap). */
function agentMemorySelectForRead(items: AgentMemoryRecord[], limit: number): AgentMemoryRecord[] {
  const sorted = [...items].sort((a, b) => b.ts - a.ts);
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}

/** Mirrors the native validation: item must be present and either a non-empty string
 *  or a plain object (NOT an array — JUCE's var::isObject() excludes JSON arrays). */
function agentMemoryItemValid(item: unknown): boolean {
  if (item == null) return false;
  if (typeof item === "string") return item.trim().length > 0;
  return typeof item === "object" && !Array.isArray(item);
}

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
  // REC-002 — the backend publishes a virtual MIDI input under exactly this name, so the
  // computer keyboard is routable and recordable like any other controller. Listed FIRST
  // because it is the one every user has (a laptop with no hardware still gets it).
  { deviceID: "midi-mosh-kbd", name: "Mosh Keyboard", alias: "Mosh Keyboard", enabled: true, monitor: "automatic" as const },
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
// CAP-PRJ-005 — the undo-transaction mirror, mirroring MoshOps exactly so a UI wired
// against the mock behaves the same against the engine. `history` is the mock's undo
// stack and `future` its redo stack, so the timeline is one list oldest → newest with a
// cursor at history.length. Ids are minted per module load and never reused; the token
// scopes them the way the native per-process token does.
const MOCK_HISTORY_TOKEN = "mockhist";
let mockTxnIds: number[] = [];
let mockNextTxnId = 1;
const mockHistoryTxn = () =>
  `${MOCK_HISTORY_TOKEN}:${history.length > 0 ? (mockTxnIds[history.length - 1] ?? 0) : 0}`;
const mockRestorableTxns = () => [
  `${MOCK_HISTORY_TOKEN}:0`,
  ...mockTxnIds.map((id) => `${MOCK_HISTORY_TOKEN}:${id}`),
];
// Agent batch grouping (mirrors the backend batch_begin/batch_end): while a batch
// is open, per-command pushUndo() is suppressed so the whole batch is ONE undo step.
let inBatch = false;

// ── FS-B2a — the agent batch-TRANSACTION contract, mirrored ──────────────────
// docs/first-stranger-program/lanes/fs-b2.md. The mock implements the SAME semantics as
// MoshOps so `runSkill` runs unchanged against both, which is what makes "one B2 reference
// skill passes the same harness against both the mock and a real engine" literally true of
// one code path rather than two lookalike ones.
//
// Exactness is easier here than in the engine and that is FINE — the mock's undo stack is
// whole-snapshot clones, so "restore the pre-state" is a clone swap. The engine earns it
// with undo-head ownership plus a fingerprint. Both must AGREE on the observable contract,
// which is what the vitest suite pins.
type MockTxnEntry = {
  requestId: string;
  command: string;
  state: "pending" | "applied" | "failed";
  envelopeDigest: string;
  result?: CommandResult;
};
type MockTxn = {
  id: string;
  name: string;
  status: "open" | "failed" | "committed" | "rolled_back" | "needs_recovery";
  failureCode?: string;
  manifestDigest: string;
  preFingerprint: string;
  preState: Snapshot;
  revisionAtBegin: number;
  nextIndex: number;
  entries: MockTxnEntry[];
};
let mockTxn: MockTxn | null = null;
let mockRevision = 0;

/** The mock's stand-in for the engine's canonical fingerprint: the same idea (a stable
 *  digest of the session minus declared volatile fields), not the same bytes — the two are
 *  never compared to each other, only each to its own captured pre-state. */
function mockFingerprint(s: Snapshot): string {
  const stable = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  delete stable.transport; // playhead / play state — 30 Hz, not song content
  delete stable.controller;
  delete stable.audio;
  const session = stable.session as Record<string, unknown> | undefined;
  if (session) {
    for (const k of ["dirty", "audioEnabled", "sampleRate", "audioDeviceName", "editFile"])
      delete session[k];
  }
  return sortedJson(stable);
}

/** Key-order-independent serialization, so a rebuilt object still matches. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const mockManifestDigest = (name: string, manifest: readonly unknown[]): string =>
  sortedJson([name, manifest]);

// Mirrors src/moshops/TransactionSafe.h. A DIVERGENCE HERE IS A BUG, and it is guarded:
// txnSafeRegistry.test.ts parses the C++ registry and requires this list to equal it, so
// the mock cannot quietly admit something the engine refuses (or vice versa).
const MOCK_TXN_SAFE = new Set([
  "set_track_volume", "set_track_pan", "set_track_mute", "set_track_solo", "set_track_active",
  "create_track", "rename_track", "set_track_color", "set_track_icon", "move_track", "remove_track", "set_track_type",
  "move_clip", "trim_clip", "split_clip", "consolidate_clips", "crop_clip", "bounce_track", "freeze_track", "unfreeze_track", "remove_clip", "rename_clip",
  "promote_take_region",
  "duplicate_clip", "set_clip_mute", "set_clip_gain", "write_clip_gain_curve", "set_clip_fade",
  "set_clip_loop", "set_clip_reverse", "set_clip_crossfade", "normalize_clip",
  "stretch_clip", "set_clip_warp",
  "add_midi_clip", "add_note", "set_note", "remove_note", "quantize_notes", "transform_velocities", "transform_notes",
  "add_drum_pattern", "assign_sample", "set_drum_lane", "load_drum_kit",
  "load_plugin", "load_builtin", "remove_plugin", "reorder_plugin",
  "set_plugin_param", "bypass_plugin",
  "set_track_automation_mode", "write_automation_curve",
  "add_automation_point", "remove_automation_point", "set_automation_point",
  "clear_automation",
  "create_bus", "add_send", "set_send_level", "set_send_mute", "set_send_pan",
  "set_send_pre_fader", "remove_send",
  "set_tempo", "set_time_signature",
  "create_section", "rename_section", "move_section", "remove_section",
  "create_clip_group", "ungroup_clip_group", "regroup_clip_group", "rename_clip_group",
  "create_track_group", "configure_track_group", "duplicate_track_group",
  "set_track_group_members", "set_track_group_enabled", "set_track_groups_suspended",
  "rename_track_group", "remove_track_group",
  "create_lyric_sheet", "set_lyric_line", "set_lyric_constraint", "remove_lyric_line",
]);

// Mirrors the engine's central FREEZE GUARD (MoshOps.cpp executeImpl): on a frozen
// track these clip-content / device mutations refuse with "track is frozen".
// Whole-clip structure (move/duplicate/remove/rename), mixer and project ops stay
// allowed — Live's rule. A DIVERGENCE HERE IS A BUG (same class as MOCK_TXN_SAFE).
const MOCK_FROZEN_LOCKED = new Set([
  "add_note", "set_note", "remove_note", "quantize_notes", "transform_velocities", "transform_notes",
  "consolidate_clips", "crop_clip", "split_clip", "trim_clip", "set_clip_loop",
  "promote_take_region",
  "set_clip_gain", "write_clip_gain_curve", "set_clip_fade", "set_clip_reverse", "set_clip_crossfade",
  "normalize_clip", "set_clip_warp", "stretch_clip",
  "load_plugin", "load_builtin", "remove_plugin", "reorder_plugin",
  "set_plugin_param", "bypass_plugin", "open_plugin_editor",
  "set_track_automation_mode", "write_automation_curve",
  "add_automation_point", "set_automation_point", "remove_automation_point",
  "clear_automation", "replace_instrument", "hot_swap_instrument",
]);

// Mirrors TransactionSafe.h's readOnlyDuringTransaction(): reads stay available while a
// transaction is open (the exclusion window bounds mutation, not reading).
const MOCK_TXN_READS = new Set([
  "batch_status",
  "get_clip_peaks", "file_peaks", "get_command_log", "get_plugin_blocklist",
  "list_plugins", "list_builtins", "list_takes", "list_directory",
  "list_audio_devices", "list_midi_inputs", "list_wave_inputs",
  "list_track_outputs", "list_rave_models", "list_training_sources", "list_drum_kits",
  "list_lora_adapters", "list_colors", "list_loras", "list_transform_targets",
  "agent_memory_read", "get_lyric_corpus_stats", "get_rhymes",
  "mp_serialize_track", "mp_serialize_project", "mp_sync_locks",
  // Live note audition — transient sound, no mutation. Mirrors TransactionSafe.h so a
  // keypress still works while an agent transaction is open (asserted byte-equal by
  // txnSafeRegistry.test.ts).
  "audition_note", "all_notes_off",
]);

function mockTxnStatusData(t: MockTxn): Record<string, unknown> {
  return {
    found: true,
    transactionId: t.id,
    name: t.name,
    status: t.status,
    ...(t.failureCode ? { failureCode: t.failureCode } : {}),
    revisionAtBegin: t.revisionAtBegin,
    revision: mockRevision,
    preFingerprint: t.preFingerprint,
    fingerprint: mockFingerprint(snapshot),
    manifestCount: t.entries.length,
    applied: t.entries.filter((e) => e.state === "applied").length,
    canCommit:
      t.status === "open" &&
      t.nextIndex >= t.entries.length &&
      !t.entries.some((e) => e.state === "failed"),
    canRollback: t.status === "open" || t.status === "failed",
    entries: t.entries.map((e, index) => ({
      index,
      requestId: e.requestId,
      command: e.command,
      state: e.state,
      ...(e.result ? { result: e.result } : {}),
    })),
  };
}

// ── event bus (mirrors window.__JUCE__.backend on the real side) ─────────────

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

// Mock command log (drives the CommandLog panel). Read-only commands don't log.
const cmdLog: { command: string; ok: boolean; undoable: boolean; ts: number; txn: string }[] = [];
const READONLY = new Set(["get_snapshot", "get_clip_peaks", "file_peaks", "audition_file", "stop_audition", "get_command_log", "list_plugins", "list_builtins", "list_colors", "list_loras", "list_rave_models", "list_audio_devices", "list_wave_inputs", "list_midi_inputs", "list_track_outputs", "list_takes", "list_training_sources", "training_job_status", "list_lora_adapters",
  "agent_memory_read"]);   // AGT-MEM — reads are never logged, same posture as get_lyric_corpus_stats/get_rhymes
const NON_UNDOABLE = new Set(["set_transport", "arm_track", "stop_recording", "set_input_monitor", "undo", "redo", "jump_to_history", "save", "reload", "new_project", "render_layer", "reset_render_layer", "open_plugin_editor", "set_plugin_param", "export_audio", "mark_take", "import_training_source", "approve_training_source", "build_training_corpus", "submit_training_job", "cancel_training_job", "import_lora_adapter", "activate_lora_adapter", "get_rhymes",
  "complete_lyrics", "fill_lyric_gap", "suggest_next_line", "regenerate_lyric",
  "cancel_lyric_job", "reject_lyric_proposal", "analyze_lyrics", "get_lyric_corpus_stats",
  "agent_memory_write", "agent_memory_delete", "agent_memory_clear"]);  // accept_lyric_proposal IS undoable

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
  // FS-T2 plugin-crash safe mode — native-only for the same reason: it reloads the real
  // .tracktionedit with third-party plugin nodes scrubbed out, and the dev mock hosts no
  // plugins and has no project file to reload.
  "open_without_plugins",
]);
const PROJECT_REPLACEMENTS = new Set([
  "new_project", "open_project", "open_recent", "reload", "recover_session", "open_without_plugins",
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
function mockAnalysisFingerprint(sheet: LyricSheet): string {
  return JSON.stringify({
    grid: sheet.grid,
    topic: sheet.topic,
    mood: sheet.mood,
    explicit: sheet.explicit,
    rhymeStrictness: sheet.rhymeStrictness,
    styleBias: !!sheet.styleBias,
    lines: sheet.lines.map((line) => ({
      index: line.index,
      role: line.role,
      seedText: line.seedText,
      text: line.text,
      syllableTarget: line.syllableTarget,
      syllableTol: line.syllableTol,
      stress: line.stress,
      rhymeGroup: line.rhymeGroup,
      rhymeStrictness: line.rhymeStrictness,
      locked: line.locked,
    })),
  });
}
function clearAnalysisIfChanged(sheet: LyricSheet, before: string): void {
  if (mockAnalysisFingerprint(sheet) !== before)
    sheet.lines.forEach((line) => { delete line.analysis; });
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
if (MOCK_ENABLED && typeof window !== "undefined") {
  (window as Window & { __moshMockEmitForTests?: typeof __mockEmitForTests })
    .__moshMockEmitForTests = __mockEmitForTests;
}
const invalidate = () => { emit("snapshot_invalidated"); emitMuteAutomation(); };

// CAP-AUT-006 — the mute button's follow-the-curve rail, mirroring the native
// muteAutomationAtPlayhead(): only tracks whose mute gate carries a curve, with that
// curve read at the CURRENT transport position and thresholded at 0.5 (the two-state
// parameter's snap point). Emitted from the play tick AND from invalidate(), because
// native emits at 30 Hz regardless of the transport — the button has to be right while
// parked mid-curve too, not just while rolling.
function curveValueAt(points: { t: number; v: number }[], time: number): number {
  if (points.length === 0) return 0;
  const pts = points.slice().sort((a, b) => a.t - b.t);
  if (time <= pts[0].t) return pts[0].v;
  const last = pts[pts.length - 1];
  if (time >= last.t) return last.v;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (time <= b.t) {
      const span = b.t - a.t;
      return span <= 0 ? b.v : a.v + ((time - a.t) / span) * (b.v - a.v);
    }
  }
  return last.v;
}
function emitMuteAutomation(): void {
  const now = snapshot.transport?.position ?? 0;
  const tracks = snapshot.tracks
    .map((t) => {
      const gate = (t.mixerPlugins ?? []).find((p) => p.type === "moshTrackMute");
      const param = gate?.params?.find((x) => x.index === 0);
      const points = param?.points ?? [];
      if (points.length === 0) return null;
      return { id: t.id, muted: curveValueAt(points, now) >= 0.5 };
    })
    .filter((x): x is { id: string; muted: boolean } => x !== null);
  emit("mute_automation", { tracks });
}

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
    const trackFrames = snapshot.tracks
      .filter((t) => !t.isGroup)
      .map((t, i) => {
        const g = t.mute ? 0 : level * (0.6 + 0.4 * Math.abs(Math.sin(pos * 2.3 + i)));
        const db = toDb(g);
        return { track: t, gain: g, reading: { id: t.id, l: db, r: toDb(g * 0.94) } };
      });
    const tracks = trackFrames.map((frame) => frame.reading);
    const sends = trackFrames.flatMap(({ track, gain }) => (track.sends ?? []).map((send) => {
      const plugin = ensureSendAutomationPlugin(track, send);
      const valueAt = (paramIndex: number): number => {
        const param = plugin.params.find((candidate) => candidate.index === paramIndex);
        return param?.points?.length ? curveValueAt(param.points, pos) : (param?.value ?? 0);
      };
      const muted = valueAt(SEND_MUTE_PARAM_INDEX) >= 0.5;
      const pan = valueAt(SEND_PAN_PARAM_INDEX) * 2 - 1;
      const sendGain = muted ? 0 : 10 ** (sendParamToDb(valueAt(SEND_LEVEL_PARAM_INDEX)) / 20);
      const faderGain = send.preFader ? 1 : 10 ** ((track.volumeDb ?? 0) / 20);
      const branch = gain * sendGain * faderGain;
      const left = branch * (pan > 0 ? 1 - pan : 1);
      const right = branch * 0.94 * (pan < 0 ? 1 + pan : 1);
      return { trackId: track.id, bus: send.bus, l: toDb(left), r: toDb(right) };
    }));
    emit("levels", { tracks, master: { l: toDb(level), r: toDb(level * 0.96) }, sends });
    emitMuteAutomation();
  }, 1000 / 30);
}
function stopPlayback() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  emit("spectrum", { bands: Array(8).fill(0), level: 0, flux: 0 }); // calm on stop
  // Drop the meters to the floor when the transport stops.
  const tracks = snapshot.tracks.filter((t) => !t.isGroup).map((t) => ({ id: t.id, l: -100, r: -100 }));
  const sends = snapshot.tracks.flatMap((track) => (track.sends ?? []).map((send) => ({
    trackId: track.id, bus: send.bus, l: -100, r: -100,
  })));
  emit("levels", { tracks, master: { l: -100, r: -100 }, sends });
}

// ── helpers ──────────────────────────────────────────────────────────────────

const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
function mockMemoryLocation(value: unknown): {
  readonly value?: Annotation["memoryLocation"];
  readonly error?: string;
} {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "memoryLocation must be an object or null" };
  }
  const source = value as Record<string, unknown>;
  const normalized: NonNullable<Annotation["memoryLocation"]> = {};
  const trackIds = (candidate: unknown): string[] | null => {
    if (!Array.isArray(candidate) || candidate.some((id) => typeof id !== "string" || !id.trim())) {
      return null;
    }
    return [...new Set(candidate as string[])];
  };
  if (source.editSelection !== undefined) {
    if (typeof source.editSelection !== "object" || source.editSelection === null
        || Array.isArray(source.editSelection)) {
      return { error: "Memory Location editSelection must be an object" };
    }
    const selection = source.editSelection as Record<string, unknown>;
    if (typeof selection.start !== "number" || !Number.isFinite(selection.start)
        || typeof selection.end !== "number" || !Number.isFinite(selection.end)
        || selection.start < 0 || selection.end < selection.start) {
      return { error: "Memory Location selection must be finite and ordered" };
    }
    const ids = selection.trackIds === undefined ? undefined : trackIds(selection.trackIds);
    if (ids === null) return { error: "Memory Location track ids must be non-empty strings" };
    normalized.editSelection = {
      start: selection.start,
      end: selection.end,
      ...(ids ? { trackIds: ids } : {}),
    };
  }
  if (source.horizontalZoom !== undefined) {
    if (typeof source.horizontalZoom !== "number" || !Number.isFinite(source.horizontalZoom)
        || source.horizontalZoom < 20 || source.horizontalZoom > 400) {
      return { error: "Memory Location horizontalZoom must be between 20 and 400" };
    }
    normalized.horizontalZoom = source.horizontalZoom;
  }
  if (source.shownTrackIds !== undefined) {
    const ids = trackIds(source.shownTrackIds);
    if (ids === null) return { error: "Memory Location track ids must be non-empty strings" };
    normalized.shownTrackIds = ids;
  }
  return { value: normalized };
}
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
function trackGroupSupports(group: TrackGroup, axis: "edit" | "mix"): boolean {
  return group.kind === axis || group.kind === "edit_mix";
}
const TRACK_GROUP_MIX_ATTRIBUTE_SET: ReadonlySet<string> = new Set(TRACK_GROUP_MIX_ATTRIBUTES);
function isTrackGroupMixAttribute(value: unknown): value is TrackGroupMixAttribute {
  return typeof value === "string" && TRACK_GROUP_MIX_ATTRIBUTE_SET.has(value);
}
function parseTrackGroupMixAttributes(value: unknown): TrackGroupMixAttribute[] | null {
  if (!Array.isArray(value)) return null;
  const attributes: TrackGroupMixAttribute[] = [];
  for (const item of value) {
    if (!isTrackGroupMixAttribute(item)) return null;
    if (!attributes.includes(item)) attributes.push(item);
  }
  return attributes;
}
function parseTrackGroupKind(value: unknown): TrackGroupKind | null {
  return value === "edit" || value === "mix" || value === "edit_mix" ? value : null;
}
function trackGroupMixAttributes(group: TrackGroup): readonly TrackGroupMixAttribute[] {
  return group.mixAttributes ?? DEFAULT_TRACK_GROUP_MIX_ATTRIBUTES;
}
function trackGroupTrackIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String))] : [];
}
function sameTrackGroupValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function linkedMixTracks(trackId: string, attribute: TrackGroupMixAttribute): Track[] {
  const source = findTrack(trackId);
  if (!source || snapshot.trackGroupsSuspended) return source ? [source] : [];
  const linked = new Set([trackId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of snapshot.trackGroups ?? []) {
      if (!group.enabled || !trackGroupSupports(group, "mix")
        || !trackGroupMixAttributes(group).includes(attribute)
        || !group.trackIds.some((id) => linked.has(id))) continue;
      for (const id of group.trackIds) {
        if (!findTrack(id) || linked.has(id)) continue;
        linked.add(id);
        changed = true;
      }
    }
  }
  return snapshot.tracks.filter((track) => linked.has(track.id));
}
// Is this clip's render layer scoped to PART of the clip? Mirrors the ±1e-3 comparison in
// MoshOps::applyRenderInPlace, which is what decides in-place apply vs the lane landing.
function isSubRegion(clip: Clip): boolean {
  const rl = clip.renderLayer;
  if (!rl || rl.regionStart === undefined || rl.regionEnd === undefined) return false;
  const cs = clip.start, ce = clip.start + clip.length;
  return rl.regionStart > cs + 1e-3 || rl.regionEnd < ce - 1e-3;
}
// accept_render's landing for a render that did NOT auto-apply: a plain wave clip on a shared
// "Neural Renders" lane, spanning the rendered region. Mirrors MoshOps::cmdAcceptRender —
// including that the lane is found-or-created once and reused.
function landOnNeuralLane(src: Clip): Clip {
  let lane = snapshot.tracks.find((t) => t.name === "Neural Renders");
  if (!lane) {
    lane = {
      id: nextTrackId(), index: snapshot.tracks.length, name: "Neural Renders", type: "audio",
      volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
    };
    snapshot.tracks.push(lane);
  }
  const rl = src.renderLayer!;
  const start = rl.regionStart ?? src.start;
  const end = rl.regionEnd ?? src.start + src.length;
  const landed: Clip = {
    id: nextClipId(), name: `${src.name} (re-imagined)`, type: "wave",
    start, length: Math.max(0.001, end - start), offset: 0, hasRenderLayer: false,
  } as unknown as Clip;
  lane.clips.push(landed);
  return landed;
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
// Skill Foundry Slice B, Task 1 — recompute the additive stable-id projections
// (`takeIds`/`currentTakeId`) from `takes`/`currentTakeIndex`, mirroring the native
// clipToVar projection (state/TakeIdentity.h). Call this any time `takes` or
// `currentTakeIndex` changes so the index-based and id-based views never drift.
function syncTakeIdProjections(clip: Clip): void {
  if (!clip.takes || clip.takes.length === 0) {
    delete clip.takeIds;
    delete clip.currentTakeId;
    return;
  }
  clip.takeIds = clip.takes.map((tk) => tk.id ?? "");
  const idx = clip.currentTakeIndex ?? clip.takes.findIndex((tk) => tk.isCurrent);
  clip.currentTakeId = idx >= 0 && idx < clip.takes.length ? (clip.takes[idx]!.id ?? "") : "";
}

function pushUndo() {
  if (inBatch) return;
  history.push(clone(snapshot)); future.length = 0;
  // CAP-PRJ-005 — a new transaction discards the redo tail (native: JUCE does this
  // inside perform()), then takes a fresh never-reused id.
  mockTxnIds = mockTxnIds.slice(0, history.length - 1);
  mockTxnIds.push(mockNextTxnId++);
  // …and the 100-step cap drops from the FRONT, exactly like
  // UndoManager::dropOldTransactionsIfTooLarge. Dropping the snapshot without dropping
  // its id would shift every id one place and restore to the wrong point.
  if (history.length > 100) { history.shift(); mockTxnIds.shift(); }
}

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
    [["too muddy", "muddy", "too harsh", "harsh", "boomy", "boxy", "too thin", "tinny", "fix the tone", "honky"], "tone", "4bandEq", "That's a tone issue — an EQ shapes it without re-performing the take."],
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
// Kept in lockstep with the NATIVE kBuiltins TYPE names (MoshOps.cpp) — the
// Phase-A agent bench caught the drift: the mock accepted "eq" (native rejects
// it; the real type is "4bandEq") and was missing compressor/sampler/chorus/
// phaser/lowpass/pitchShifter entirely, so an agent following the real
// list_builtins vocabulary failed only in dev/e2e. Display names stay the
// mock's shorter forms where the UI already shows them.
const BUILTINS = [
  { type: "4osc", name: "4OSC", category: "Instruments", isInstrument: true, builtin: true as const },
  { type: "sampler", name: "Sampler", category: "Instruments", isInstrument: true, builtin: true as const },
  { type: "reverb", name: "Reverb", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "delay", name: "Delay", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "4bandEq", name: "4-Band EQ", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "compressor", name: "Compressor", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "chorus", name: "Chorus", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "phaser", name: "Phaser", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "lowpass", name: "Low / High-Pass Filter", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "pitchShifter", name: "Pitch Shifter", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "moshAutoTune", name: "Mosh AutoTune", category: "Mosh FX", isInstrument: false, builtin: true as const },
  { type: "moshOTT", name: "Mosh OTT", category: "Mosh FX", isInstrument: false, builtin: true as const },
  { type: "moshXFeedback", name: "Mosh X-FDBK", category: "Mosh FX", isInstrument: false, builtin: true as const },
];
const VST3S = [
  { id: "vital", name: "Vital", format: "VST3", manufacturer: "Vital Audio", isInstrument: true },
  { id: "ott", name: "OTT", format: "VST3", manufacturer: "Xfer", isInstrument: false },
  { id: "waves-cla-2a-stereo", name: "CLA-2A Stereo", format: "VST3", manufacturer: "Waves", isInstrument: false },
];
// AUD-SCAN fidelity — the cold-start scan only catalogs VST3 bundles carrying
// moduleinfo.json; the rest (all Valhalla, Waves shells, most FabFilter…) only show
// up after the deep sweep (rescan_plugins with allowAU). The catalog is therefore a
// `let` that the deep path GROWS, and the sweep is async (progress events, then a
// bigger list) — matching the native backend so the UI's rescan affordance has real
// behaviour to drive in dev/e2e. The VST3-only path stays synchronous (it was).
const DEEP_SCAN_EXTRA = [
  { id: "au:supermassive", name: "Valhalla Supermassive", format: "AudioUnit", manufacturer: "Valhalla DSP", isInstrument: false },
  { id: "au:soothe", name: "soothe2", format: "AudioUnit", manufacturer: "oeksound", isInstrument: false },
  // A second INSTRUMENT so the hot-swap path (load_plugin replaceInstrument) has an
  // A→B pair to drive in e2e.
  { id: "au:serum2", name: "Serum 2", format: "AudioUnit", manufacturer: "Xfer", isInstrument: true },
];
let mockPluginCatalog = [...VST3S];
let mockDeepScanned = false;
type MockPluginBlockEntry = { id: string; rawId: string; reason: string };
let mockPluginBlocklist: MockPluginBlockEntry[] = [];
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

// ── CAP-AUT-006 — the mixer strip's hidden-but-automatable plugins ───────────────────
// Native carries these as real pluginList members (the fader, and the mute gate sitting
// immediately upstream of the metering tap) and filters them out of the snapshot's
// `plugins` array — so their pluginIndex is a REAL index that `plugins` does not
// contain. The mock has no pluginList to index into, so it parks them at a fixed base
// above anything `plugins` (renumbered 0..n-1 by reindex) can reach. The seam behaviour
// that has to survive is the part the UI depends on: a pluginIndex absent from
// `plugins` still resolves for the automation commands, and the mute parameter carries
// discrete/states so the editor snaps its points.
const MIXER_INDEX_BASE = 100;
const SEND_LEVEL_PARAM_INDEX = 0;
const SEND_PAN_PARAM_INDEX = 1;
const SEND_MUTE_PARAM_INDEX = 2;
const sendDbToParam = (db: number): number => Math.max(0, Math.min(1, (db + 100) / 106));
const sendParamToDb = (value: number): number => -100 + Math.max(0, Math.min(1, value)) * 106;
function ensureMixerPlugins(t: Track): Plugin[] {
  if (!t.mixerPlugins) {
    t.mixerPlugins = [
      {
        index: MIXER_INDEX_BASE, name: "Volume & Pan Plugin", type: "volume",
        enabled: true, external: false, isInstrument: false,
        params: [{ index: 0, name: "Volume", value: 0.8 }, { index: 1, name: "Pan", value: 0.5 }],
      },
      {
        index: MIXER_INDEX_BASE + 1, name: "Mute", type: "moshTrackMute",
        enabled: true, external: false, isInstrument: false,
        params: [{ index: 0, name: "Mute", value: 0, discrete: true, states: 2 }],
      },
    ];
  }
  return t.mixerPlugins;
}
function ensureSendAutomationPlugin(t: Track, send: NonNullable<Track["sends"]>[number]): Plugin {
  const pluginIndex = MIXER_INDEX_BASE + 2 + send.bus;
  send.automation = {
    pluginIndex,
    levelParamIndex: SEND_LEVEL_PARAM_INDEX,
    panParamIndex: SEND_PAN_PARAM_INDEX,
    muteParamIndex: SEND_MUTE_PARAM_INDEX,
  };
  const mixerPlugins = ensureMixerPlugins(t);
  let plugin = mixerPlugins.find((candidate) => candidate.index === pluginIndex);
  if (!plugin) {
    plugin = {
      index: pluginIndex,
      name: `Aux Send ${send.bus + 1}`,
      type: "auxSend",
      enabled: true,
      external: false,
      isInstrument: false,
      params: [
        { index: SEND_LEVEL_PARAM_INDEX, name: "Send level", value: sendDbToParam(send.db) },
        { index: SEND_PAN_PARAM_INDEX, name: "Send pan", value: ((send.pan ?? 0) + 1) / 2 },
        { index: SEND_MUTE_PARAM_INDEX, name: "Send mute", value: send.mute ? 1 : 0, discrete: true, states: 2 },
      ],
    };
    mixerPlugins.push(plugin);
  }
  return plugin;
}
function reconcileSendAutomationPlugins(t: Track): void {
  const sends = t.sends ?? [];
  const liveIndices = new Set(sends.map((send) => ensureSendAutomationPlugin(t, send).index));
  t.mixerPlugins = ensureMixerPlugins(t).filter((plugin) =>
    plugin.type !== "auxSend" || liveIndices.has(plugin.index));
}
/** Resolve an automation target across BOTH the rack and the mixer strip — the native
 *  findParam addresses one flat pluginList, so a mock that only looked in `plugins`
 *  would reject every mute/fader curve the real backend accepts. */
function findAutomatableParam(trackId: string, pluginIndex: number, paramIndex: number) {
  const t = findTrack(trackId);
  if (!t) return null;
  reconcileSendAutomationPlugins(t);
  const rack = t.plugins ?? [];
  const plugin = (pluginIndex >= 0 && pluginIndex < rack.length)
    ? rack[pluginIndex]
    : ensureMixerPlugins(t).find((p) => p.index === pluginIndex);
  return plugin?.params?.find((x) => x.index === paramIndex) ?? null;
}
// Master-bus plugins — mirrors findPlugin/reindex one level up, on snapshot.master.plugins
// (no owning track). Kept in lockstep with the native findMasterPlugin/pluginToVar shape.
function masterPlugins(): Plugin[] {
  snapshot.master = snapshot.master ?? { volumeDb: 0, pan: 0 };
  snapshot.master.plugins = snapshot.master.plugins ?? [];
  return snapshot.master.plugins;
}
const reindexMaster = () => masterPlugins().forEach((p, i) => (p.index = i));
function findMasterPlugin(index: number): { idx: number } | null {
  const p = masterPlugins();
  if (index < 0 || index >= p.length) return null;
  return { idx: index };
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

type MockRecordingStop = {
  applied: boolean;
  discarded: boolean;
  clips: { id: string }[];
  reason?: string;
};

function finalizeMockRecording(discardRecordings: boolean): MockRecordingStop {
  if (!snapshot.transport.recording) {
    emit("transport", snapshot.transport);
    invalidate();
    return {
      applied: false,
      discarded: discardRecordings,
      clips: [],
      reason: "not recording",
    };
  }
  stopPlayback();
  snapshot.transport = { ...snapshot.transport, playing: false, recording: false };
  emit("transport", snapshot.transport);
  if (discardRecordings) {
    invalidate();
    return { applied: true, discarded: true, clips: [] };
  }

  const targets = snapshot.tracks.filter((track) => track.armed);
  if (targets.length === 0) {
    invalidate();
    return {
      applied: false,
      discarded: false,
      clips: [],
      reason: "no take captured (no armed live input)",
    };
  }

  const landed: { id: string }[] = [];
  for (const track of targets) {
    const existing = track.clips.find((clip) => clip.takes && clip.takes.length > 0);
    if (existing && existing.takes) {
      const index = existing.takes.length;
      existing.takes.forEach((take) => (take.isCurrent = false));
      existing.takes.push({ index, id: nextTakeId(), description: `Take ${index + 1}`, isCurrent: true });
      existing.numTakes = existing.takes.length;
      existing.currentTakeIndex = index;
      syncTakeIdProjections(existing);
      landed.push({ id: existing.id });
    } else {
      const clip = waveClip("take", Math.max(0, snapshot.transport.position - 2), 2);
      clip.takes = [{ index: 0, id: nextTakeId(), description: "Take 1", isCurrent: true }];
      clip.numTakes = 1;
      clip.currentTakeIndex = 0;
      syncTakeIdProjections(clip);
      track.clips.push(clip);
      landed.push({ id: clip.id });
    }
  }
  invalidate();
  return { applied: true, discarded: false, clips: landed };
}

// Deterministic per-take peaks for the mock's list_takes (take-lanes wave) —
// seeded by (clipId, takeIndex) so two takes on one clip always differ and a
// replayed list reproduces itself. [min,max] bucket pairs, the engine's shape.
function mockTakePeaks(clipId: string, takeIndex: number): [number, number][] {
  let h = 0n;
  const M = (1n << 64n) - 1n;
  for (const c of `${clipId}|take${takeIndex}`) h = (h * 31n + BigInt(c.codePointAt(0)!)) & M;
  const rand = splitmix64(h);
  const out: [number, number][] = [];
  for (let b = 0; b < 120; b++) {
    const v = rand() * 2 - 1;
    out.push([Math.min(0, v * 0.9), Math.max(0, v * 0.9)]);
  }
  return out;
}

function dispatch(command: string, args: Record<string, unknown>): CommandResult {
  // FREEZE GUARD — mirrors the engine's central lock in executeImpl (checked
  // BEFORE the command body, exactly like the native seam).
  if (MOCK_FROZEN_LOCKED.has(command)) {
    const tid = str(args.trackId);
    const t = tid
      ? snapshot.tracks.find((tr) => tr.id === tid)
      : snapshot.tracks.find((tr) => tr.clips.some((c) => c.id === str(args.clipId)));
    if (t?.frozen) return err(command, "track is frozen (unfreeze it first)");
  }
  switch (command) {
    case "set_transport": {
      const action = str(args.action);
      const shouldFinalize = snapshot.transport.recording
        && (action === "stop" || action === "toggle" || action === "record" || action === "to_start");
      if (shouldFinalize) {
        const stopped = finalizeMockRecording(false);
        if (!stopped.applied) return err(command, stopped.reason ?? "could not land recording take");

        const next = { ...snapshot.transport };
        if (action === "to_start") next.position = 0;
        if ("position" in args) next.position = Math.max(0, num(args.position));
        if ("loop" in args) {
          next.looping = Boolean(args.loop);
          next.loopStart = num(args.loopStart, next.loopStart);
          next.loopEnd = num(args.loopEnd, next.loopEnd);
        }
        snapshot.transport = next;
        emit("transport", snapshot.transport);
        return ok(command, snapshot.transport);
      }

      const t = snapshot.transport;
      // Live 12's Space vs ⇧Space: a normal stop RETURNS to the insert marker
      // (last play-start or explicit seek); a continue-start makes the next stop
      // LEAVE the playhead. Mirrors MoshOps::cmdSetTransport's marker memory.
      const posArg = "position" in args ? Math.max(0, num(args.position)) : null;
      if (action === "play" || action === "record" || (action === "toggle" && !t.playing)
          || (action === "continue" && !t.playing)) {
        // REC-NO-INPUT fixture — mirrors the engine's record refusal: with no usable
        // input the record branch errors with the named reason (a record START only;
        // toggling an active recording OFF always works).
        if (action === "record" && MOCK_NO_INPUT && !t.recording)
          return err(command, "no armed track with a usable input — arm a track and pick an input in Settings > Audio");
        if (action === "continue") {
          mockViaContinue = true;
        } else {
          mockInsertMarker = posArg ?? t.position;
          mockViaContinue = false;
        }
        if (action === "record") {
          snapshot.transport = { ...t, recording: !t.recording, playing: true };
        } else {
          snapshot.transport = { ...t, playing: true };
        }
        startPlayback();
        if (posArg != null) snapshot.transport = { ...snapshot.transport, position: posArg };
        emit("transport", snapshot.transport);
        return ok(command, snapshot.transport);
      }
      if (action === "toggle" || action === "stop" || action === "continue") {
        stopPlayback();
        const position = posArg ?? (mockViaContinue ? t.position : mockInsertMarker);
        mockViaContinue = false;
        snapshot.transport = { ...t, playing: false, recording: false, position };
        emit("transport", snapshot.transport);
        return ok(command, snapshot.transport);
      }
      if (action === "to_end") {
        snapshot.transport = { ...t, position: snapshot.session.length ?? 16 };
        emit("transport", snapshot.transport);
        return ok(command, snapshot.transport);
      }
      if (action === "to_start") {
        mockInsertMarker = 0;   // an explicit seek moves the insert marker
        snapshot.transport = { ...t, position: 0 };
        emit("transport", snapshot.transport);
        return ok(command, snapshot.transport);
      }
      if (action === "record") {
        snapshot.transport = { ...t, recording: !t.recording, playing: true };
        startPlayback();
        emit("transport", snapshot.transport);
        return ok(command, snapshot.transport);
      }
      // direct field sets: position / loop
      const next: Transport = { ...t };
      if ("position" in args) { next.position = Math.max(0, num(args.position)); mockInsertMarker = next.position; }
      if ("loop" in args) { next.looping = Boolean(args.loop); next.loopStart = num(args.loopStart, t.loopStart); next.loopEnd = num(args.loopEnd, t.loopEnd); }
      snapshot.transport = next;
      emit("transport", snapshot.transport);
      return ok(command, snapshot.transport);
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
      // CAP-AUT-006 — hand back the mute gate's pluginIndex, same as native: it is
      // hidden from `plugins`, so without this a caller would have to go through the
      // snapshot to write a mute curve.
      const gate = ensureMixerPlugins(t).find((p) => p.type === "moshTrackMute");
      invalidate();
      return ok(command, { trackId: t.id, type, isInstrument: !!t.isInstrument, muteGateIndex: gate?.index ?? -1 });
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
    case "ungroup_track": {
      // Mirrors MoshOps::cmdUngroupTrack — the folder's children return to the top
      // level (parentId cleared) and the folder itself is removed, one undo step.
      const g = snapshot.tracks.find((t) => t.isGroup && t.id === str(args.trackId));
      if (!g) return err(command, "no group track: " + str(args.trackId));
      pushUndo();
      for (const t of snapshot.tracks) if (t.parentId === g.id) delete t.parentId;
      snapshot.tracks = snapshot.tracks.filter((t) => t.id !== g.id);
      invalidate();
      return ok(command);
    }
    case "create_track_group": {
      const trackIds = trackGroupTrackIds(args.trackIds);
      const kind = parseTrackGroupKind(args.kind);
      const mixAttributes = args.mixAttributes === undefined
        ? [...DEFAULT_TRACK_GROUP_MIX_ATTRIBUTES]
        : parseTrackGroupMixAttributes(args.mixAttributes);
      if (trackIds.length === 0) return err(command, "trackIds must contain at least one track");
      if (!kind)
        return err(command, "kind must be edit, mix, or edit_mix");
      if (!mixAttributes) return err(command, "mixAttributes must contain only supported attributes");
      if (trackIds.some((trackId) => {
        const track = findTrack(trackId);
        return !track || track.isGroup || track.isReturn;
      })) return err(command, "trackIds contains an unsupported track");
      pushUndo();
      const group: TrackGroup = {
        id: nextTrackGroupId(),
        name: str(args.name).trim() || `Group ${(snapshot.trackGroups?.length ?? 0) + 1}`,
        trackIds,
        kind,
        enabled: true,
        mixAttributes,
      };
      (snapshot.trackGroups ??= []).push(group);
      invalidate();
      return ok(command, { groupId: group.id, trackIds: [...group.trackIds] });
    }
    case "configure_track_group": {
      const group = (snapshot.trackGroups ?? []).find((candidate) => candidate.id === str(args.groupId));
      const name = str(args.name).trim();
      const kind = parseTrackGroupKind(args.kind);
      const trackIds = trackGroupTrackIds(args.trackIds);
      const mixAttributes = parseTrackGroupMixAttributes(args.mixAttributes);
      if (!group) return err(command, "track group not found");
      if (!name) return err(command, "track group name cannot be empty");
      if (!kind)
        return err(command, "kind must be edit, mix, or edit_mix");
      if (trackIds.length === 0) return err(command, "trackIds must contain at least one track");
      if (trackIds.some((trackId) => {
        const track = findTrack(trackId);
        return !track || track.isGroup || track.isReturn;
      })) return err(command, "trackIds contains an unsupported track");
      if (!mixAttributes) return err(command, "mixAttributes must contain only supported attributes");
      if (group.name === name && group.kind === kind
        && sameTrackGroupValues(group.trackIds, trackIds)
        && sameTrackGroupValues(trackGroupMixAttributes(group), mixAttributes))
        return ok(command, { groupId: group.id, trackIds: [...group.trackIds], mixAttributes: [...mixAttributes] });
      pushUndo();
      group.name = name;
      group.kind = kind;
      group.trackIds = trackIds;
      group.mixAttributes = mixAttributes;
      invalidate();
      return ok(command, { groupId: group.id, trackIds: [...group.trackIds], mixAttributes: [...mixAttributes] });
    }
    case "duplicate_track_group": {
      const source = (snapshot.trackGroups ?? []).find((candidate) => candidate.id === str(args.groupId));
      const name = str(args.name).trim();
      const kind = parseTrackGroupKind(args.kind);
      const trackIds = trackGroupTrackIds(args.trackIds);
      const mixAttributes = parseTrackGroupMixAttributes(args.mixAttributes);
      if (!source) return err(command, "track group not found");
      if (!name) return err(command, "track group name cannot be empty");
      if (!kind)
        return err(command, "kind must be edit, mix, or edit_mix");
      if (trackIds.length === 0) return err(command, "trackIds must contain at least one track");
      if (trackIds.some((trackId) => {
        const track = findTrack(trackId);
        return !track || track.isGroup || track.isReturn;
      })) return err(command, "trackIds contains an unsupported track");
      if (!mixAttributes) return err(command, "mixAttributes must contain only supported attributes");
      pushUndo();
      const duplicate: TrackGroup = {
        id: nextTrackGroupId(),
        name,
        kind,
        trackIds,
        enabled: true,
        mixAttributes,
      };
      (snapshot.trackGroups ??= []).push(duplicate);
      invalidate();
      return ok(command, { groupId: duplicate.id, trackIds: [...trackIds], mixAttributes: [...mixAttributes] });
    }
    case "set_track_group_enabled": {
      const group = (snapshot.trackGroups ?? []).find((candidate) => candidate.id === str(args.groupId));
      if (!group) return err(command, "track group not found");
      pushUndo();
      group.enabled = Boolean(args.enabled);
      invalidate();
      return ok(command, { groupId: group.id, enabled: group.enabled });
    }
    case "set_track_group_members": {
      const group = (snapshot.trackGroups ?? []).find((candidate) => candidate.id === str(args.groupId));
      const trackIds = trackGroupTrackIds(args.trackIds);
      if (!group) return err(command, "track group not found");
      if (trackIds.length === 0) return err(command, "trackIds must contain at least one track");
      if (trackIds.some((trackId) => {
        const track = findTrack(trackId);
        return !track || track.isGroup || track.isReturn;
      })) return err(command, "trackIds contains an unsupported track");
      if (group.trackIds.length === trackIds.length
        && group.trackIds.every((trackId, index) => trackId === trackIds[index]))
        return ok(command, { groupId: group.id, trackIds: [...group.trackIds] });
      pushUndo();
      group.trackIds = trackIds;
      invalidate();
      return ok(command, { groupId: group.id, trackIds: [...group.trackIds] });
    }
    case "set_track_groups_suspended": {
      pushUndo();
      snapshot.trackGroupsSuspended = Boolean(args.suspended);
      invalidate();
      return ok(command, { suspended: snapshot.trackGroupsSuspended });
    }
    case "rename_track_group": {
      const group = (snapshot.trackGroups ?? []).find((candidate) => candidate.id === str(args.groupId));
      const name = str(args.name).trim();
      if (!group) return err(command, "track group not found");
      if (!name) return err(command, "track group name cannot be empty");
      pushUndo();
      group.name = name;
      invalidate();
      return ok(command, { groupId: group.id });
    }
    case "remove_track_group": {
      const groupId = str(args.groupId);
      if (!(snapshot.trackGroups ?? []).some((group) => group.id === groupId))
        return err(command, "track group not found");
      pushUndo();
      snapshot.trackGroups = (snapshot.trackGroups ?? []).filter((group) => group.id !== groupId);
      invalidate();
      return ok(command, { groupId });
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
      // Mirrors the native result shape (MoshOps.cpp cmdLoadDrumKit): {trackId, index,
      // pads} — `index` (this used to be dropped) is the sampler's position in the
      // track's plugin rack, same field the UI's plugin-rack views key off of elsewhere.
      const index = (t.plugins ?? []).findIndex((p) => p.type === "sampler" && p.isInstrument);
      return ok(command, { trackId: t.id, index, pads: 8 });
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
    // TRK-COLOUR — mirrors cmdSetTrackColor's VALIDATION, not just its happy path. A mock
    // that accepted "red" would let an e2e prove a colour picker works while the real
    // engine rejects it: the mock reproducing engine behaviour faithfully is the whole
    // reason it is allowed to stand in for one (cf. the quantize `num()` coercion, which
    // reproduced a bug so exactly that Playwright could never see it).
    case "set_track_color": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      const c = str(args.color).trim().toLowerCase();
      if (c !== "" && !/^#[0-9a-f]{6}$/.test(c))
        return err(command, `color must be "#rrggbb" or "" to clear, got: ${c}`);
      pushUndo();
      if (c === "") delete t.color; else t.color = c;
      invalidate(); return ok(command);
    }
    // TRK-REORDER — mirrors cmdMoveTrack including the two behaviours an e2e would
    // otherwise get wrong: an out-of-range index CLAMPS (a drag past the end means "last"),
    // and a same-index move SUCCEEDS (a drag that lands where it started is ordinary).
    case "move_track": {
      const from = snapshot.tracks.findIndex((t) => t.id === str(args.trackId));
      if (from < 0) return err(command, "track not found");
      if (args.toIndex === undefined) return err(command, "missing 'toIndex'");
      const orderable = snapshot.tracks.filter((t) => !t.isGroup && !t.isReturn);
      const to = Math.max(0, Math.min(orderable.length - 1, num(args.toIndex, 0)));
      if (to === from) return ok(command);
      pushUndo();
      const [moved] = snapshot.tracks.splice(from, 1);
      snapshot.tracks.splice(to, 0, moved);
      snapshot.tracks.forEach((t, i) => (t.index = i));
      invalidate(); return ok(command);
    }
    // CAP-TRK-002 (#613) — mirrors cmdSetTrackIcon's VALIDATION, not just its happy path.
    // A mock that accepted any string would let a Playwright spec prove an icon picker
    // works while the real engine refuses the click: the mock reproducing engine behaviour
    // faithfully is the whole reason it is allowed to stand in for one. Membership comes
    // from trackIconNames.ts, which trackIcons.test.ts pins against the C++ registry — so
    // there is one list in TS, not a second copy free to drift on its own.
    case "set_track_icon": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      const icon = str(args.icon).trim().toLowerCase();
      if (icon !== "" && !isTrackIconName(icon))
        return err(command, `unknown icon "${icon}" — expected one of: ${TRACK_ICONS.join(", ")}, or "" to clear`);
      pushUndo();
      if (icon === "") delete t.icon; else t.icon = icon;
      invalidate(); return ok(command);
    }
    case "remove_track": {
      const idx = snapshot.tracks.findIndex((t) => t.id === str(args.trackId));
      if (idx < 0) return err(command, "track not found");
      pushUndo(); snapshot.tracks.splice(idx, 1);
      snapshot.tracks.forEach((t, i) => (t.index = i));
      invalidate(); return ok(command);
    }
    case "set_track_volume": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      const targets = linkedMixTracks(t.id, "main_volume");
      const requested = num(args.db);
      const delta = requested - (t.volumeDb ?? 0);
      pushUndo();
      for (const target of targets)
        target.volumeDb = targets.length === 1 ? requested : Math.min(6, Math.max(-70, (target.volumeDb ?? 0) + delta));
      invalidate(); return ok(command);
    }
    case "set_track_pan": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      const targets = linkedMixTracks(t.id, "main_pan");
      const requested = num(args.pan);
      const delta = requested - (t.pan ?? 0);
      pushUndo();
      for (const target of targets)
        target.pan = targets.length === 1 ? requested : Math.min(1, Math.max(-1, (target.pan ?? 0) + delta));
      invalidate(); return ok(command);
    }
    case "set_track_mute": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      pushUndo(); for (const target of linkedMixTracks(t.id, "main_mute")) target.mute = Boolean(args.mute);
      invalidate(); return ok(command);
    }
    case "set_track_solo": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      pushUndo(); for (const target of linkedMixTracks(t.id, "solo")) target.solo = Boolean(args.solo);
      invalidate(); return ok(command);
    }
    case "set_track_active": { const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found"); const active = args.active !== false; if ((t.active ?? true) === active) return ok(command); pushUndo(); t.active = active; invalidate(); return ok(command); }

    // ── sends / returns / aux buses (Wave 8) ─────────────────────────────────
    // A "bus" is an integer; the return is an instrument-free audio track carrying
    // an aux-return (isReturn/returnBus). Send controls live on the source track and
    // route purely by matching bus number. Mirrors MoshOps cmdCreateBus/…
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
      const send: NonNullable<Track["sends"]>[number] = {
        bus,
        db: Math.max(-60, Math.min(6, num(args.db, 0))),
        mute: Boolean(args.mute),
        pan: Math.max(-1, Math.min(1, num(args.pan, 0))),
        preFader: Boolean(args.preFader),
      };
      (t.sends ??= []).push(send);
      ensureSendAutomationPlugin(t, send);
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
      const level = ensureSendAutomationPlugin(t, s).params
        .find((param) => param.index === SEND_LEVEL_PARAM_INDEX);
      if (level) level.value = sendDbToParam(s.db);
      invalidate();
      return ok(command);
    }
    case "set_send_mute": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "no track");
      const s = (t.sends ?? []).find((x) => x.bus === num(args.bus, -1));
      if (!s) return err(command, "no send to that bus");
      pushUndo();
      s.mute = Boolean(args.mute);
      const mute = ensureSendAutomationPlugin(t, s).params
        .find((param) => param.index === SEND_MUTE_PARAM_INDEX);
      if (mute) mute.value = s.mute ? 1 : 0;
      invalidate();
      return ok(command);
    }
    case "set_send_pan": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "no track");
      const s = (t.sends ?? []).find((x) => x.bus === num(args.bus, -1));
      if (!s) return err(command, "no send to that bus");
      pushUndo();
      s.pan = Math.max(-1, Math.min(1, num(args.pan, 0)));
      const pan = ensureSendAutomationPlugin(t, s).params
        .find((param) => param.index === SEND_PAN_PARAM_INDEX);
      if (pan) pan.value = (s.pan + 1) / 2;
      invalidate();
      return ok(command);
    }
    case "set_send_pre_fader": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "no track");
      const s = (t.sends ?? []).find((x) => x.bus === num(args.bus, -1));
      if (!s) return err(command, "no send to that bus");
      pushUndo();
      s.preFader = Boolean(args.preFader);
      invalidate();
      return ok(command);
    }
    case "remove_send": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "no track");
      const i = (t.sends ?? []).findIndex((x) => x.bus === num(args.bus, -1));
      if (i < 0) return err(command, "no send to that bus");
      pushUndo();
      const pluginIndex = t.sends![i].automation?.pluginIndex;
      t.sends!.splice(i, 1);
      if (pluginIndex !== undefined) {
        t.mixerPlugins = (t.mixerPlugins ?? []).filter((plugin) => plugin.index !== pluginIndex);
      }
      invalidate();
      return ok(command);
    }
    case "rename_bus": {
      const bus = num(args.bus, -1);
      const b = (snapshot.buses ?? []).find((x) => x.bus === bus);
      if (!b) return err(command, "no such bus");
      pushUndo();
      b.name = str(args.name, b.name);
      const rt = snapshot.tracks.find((t) => t.isReturn && t.returnBus === bus);
      if (rt) rt.name = b.name;
      invalidate();
      return ok(command, { bus, name: b.name });
    }
    case "remove_bus": {
      const bus = num(args.bus, -1);
      const bi = (snapshot.buses ?? []).findIndex((x) => x.bus === bus);
      if (bi < 0) return err(command, "no such bus");
      pushUndo();
      snapshot.buses!.splice(bi, 1);
      const ti = snapshot.tracks.findIndex((t) => t.isReturn && t.returnBus === bus);
      if (ti >= 0) { snapshot.tracks.splice(ti, 1); snapshot.tracks.forEach((t, i) => (t.index = i)); }
      snapshot.tracks.forEach((t) => { if (t.sends) t.sends = t.sends.filter((s) => s.bus !== bus); });
      invalidate();
      return ok(command, { bus });
    }
    case "export_stems": {
      // G7: one file per non-empty audio track. Mirrors cmdExportStems (MoshOps.cpp ~:10035)
      // deliberately closely, because a mock that is merely plausible makes every test
      // written against it vacuous:
      //   • the old filter was `t.type === "audio"`, which silently dropped DRUM tracks —
      //     native has no type filter at all (trackType is a ValueTree property; a drum
      //     track is the same te::AudioTrack underneath), so a beat never got a stem here;
      //   • the old filter also excluded isReturn, which native does not — returns simply
      //     hold no clips, so they drop out on their own unless includeEmpty is set;
      //   • the old return shape was `files: string[]`; native returns `stems: [{trackId,
      //     name, index, file, bytes}]`, so UI code reading data.stems saw undefined;
      //   • the index is assigned BEFORE the empty-track skip natively, so a default export
      //     over a project with an empty track in the middle leaves GAPS (00, 02, 03).
      const fmt = str(args.format, "wav");
      const ext = fmt === "aif" ? "aif" : fmt;
      const dir = str(args.dir) || "/mock/exports/stems-0";
      const includeEmpty = Boolean(args.includeEmpty);
      const stems = snapshot.tracks
        .filter((t) => !t.isGroup)                       // folder tracks are not AudioTracks
        .map((t, index) => ({ t, index }))               // index counts every audio track…
        .filter(({ t }) => includeEmpty || (t.clips?.length ?? 0) > 0)   // …then empties drop
        .map(({ t, index }) => ({
          trackId: t.id,
          logicalId: t.id,
          name: t.name,
          index,
          file: `${dir}/${String(index).padStart(2, "0")}-${t.name.replace(/[?*:"<>|/\\]/g, "").trim() || "unnamed"}.${ext}`,
          bytes: 1024 * (1 + index),
        }));
      if (stems.length === 0) return err(command, "no renderable tracks (all empty or hidden)");
      return ok(command, {
        dir, format: fmt, bitDepth: num(args.bitDepth, 24),
        sampleRate: 48000, seconds: snapshot.session.length, count: stems.length, stems,
      });
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
      const analysisBefore = mockAnalysisFingerprint(s);
      if (args.grid != null) s.grid = str(args.grid, s.grid);
      if (args.topic != null) s.topic = str(args.topic, s.topic);
      if (args.mood != null) s.mood = str(args.mood, s.mood);
      if (args.explicit != null) s.explicit = str(args.explicit, s.explicit);
      if (args.rhymeStrictness != null) s.rhymeStrictness = str(args.rhymeStrictness, s.rhymeStrictness);
      if (args.styleBias != null) s.styleBias = !!args.styleBias;
      clearAnalysisIfChanged(s, analysisBefore);
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
      const analysisBefore = mockAnalysisFingerprint(t.lyricSheet);
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
      clearAnalysisIfChanged(t.lyricSheet, analysisBefore);
      invalidate(); return ok(command, { lineIndex: idx });
    }
    case "remove_lyric_line": {
      const t = findTrack(str(args.trackId));
      if (!t?.lyricSheet) return err(command, "track has no lyric sheet");
      const idx = num(args.lineIndex, -1);
      const at = t.lyricSheet.lines.findIndex((l) => l.index === idx);
      if (at < 0) return err(command, "no line at index " + idx);
      pushUndo();
      const analysisBefore = mockAnalysisFingerprint(t.lyricSheet);
      t.lyricSheet.lines.splice(at, 1);
      t.lyricSheet.lines.forEach((l, i) => (l.index = i)); // keep dense
      clearAnalysisIfChanged(t.lyricSheet, analysisBefore);
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
      const sheet = t?.lyricSheet;
      const l = sheet?.lines.find((x) => x.index === num(args.lineIndex, -1));
      const pi = num(args.proposalIndex, 0);
      if (!sheet || !l) return err(command, "no line at index");
      const p = l.proposals?.[pi];
      if (!p) return err(command, "no proposal at that index");
      pushUndo();
      const analysisBefore = mockAnalysisFingerprint(sheet);
      l.text = p.text;
      l.status = "asserted";
      // Native parity (approximation — the mock has no heard blob): a line whose take
      // anchors fed the proposal lands "mixed", otherwise "generated".
      l.origin = l.origin === "partial" ? "mixed" : "generated";
      delete l.proposals;
      refreshSingable(l);
      clearAnalysisIfChanged(sheet, analysisBefore);
      mockCorpusLines += 1; // §7 — auto-accumulate the accepted line into the voice corpus
      invalidate();
      return ok(command, { text: p.text });
    }
    case "assert_lyric_line": {
      const t = findTrack(str(args.trackId));
      const sheet = t?.lyricSheet;
      const l = sheet?.lines.find((x) => x.index === num(args.lineIndex, -1));
      if (!sheet || !l) return err(command, "no line at index");
      const text = args.text != null ? str(args.text) : l.text;
      if (!completeLyricText(text)) return err(command, "line needs complete words before it can be asserted");
      pushUndo();
      const analysisBefore = mockAnalysisFingerprint(sheet);
      l.text = text.trim();
      l.status = "asserted";
      delete l.proposals;
      refreshSingable(l);
      clearAnalysisIfChanged(sheet, analysisBefore);
      invalidate();
      return ok(command, { text: l.text });
    }
    case "get_lyric_corpus_stats":
      return ok(command, { lines: mockCorpusLines });
    case "agent_memory_write": {
      const scope = str(args.scope);
      if (scope !== "global" && scope !== "project")
        return err(command, "'scope' must be \"global\" or \"project\"");
      if (!agentMemoryItemValid(args.item))
        return err(command, "missing or invalid 'item' (must be a non-empty JSON object or string)");
      const explicitFlag = Boolean(args.explicit);

      if (scope === "global") {
        const kind = str(args.kind);
        if (!(AGENT_MEMORY_GLOBAL_KINDS as readonly string[]).includes(kind))
          return err(command, "'kind' must be one of \"preference\", \"drum_pattern\", \"lyric_framework\" for global scope");
        const store = mockAgentMemoryGlobal[kind];
        const res = agentMemoryApplyWrite(store, { ts: ++mockAgentMemoryTs, kind, explicit: explicitFlag, item: args.item });
        if (!res.ok) return err(command, res.error!);
        return ok(command, { count: store.length });
      }

      const kind = args.kind !== undefined ? str(args.kind) : "note";
      const res = agentMemoryApplyWrite(mockAgentMemoryProject, { ts: ++mockAgentMemoryTs, kind, explicit: explicitFlag, item: args.item });
      if (!res.ok) return err(command, res.error!);
      return ok(command, { count: mockAgentMemoryProject.length });
    }
    case "agent_memory_read": {
      const scope = str(args.scope);
      if (scope !== "global" && scope !== "project")
        return err(command, "'scope' must be \"global\" or \"project\"");
      const limit = num(args.limit, 50);

      if (scope === "global") {
        const kind = str(args.kind);
        if (kind && !(AGENT_MEMORY_GLOBAL_KINDS as readonly string[]).includes(kind))
          return err(command, "'kind' must be one of \"preference\", \"drum_pattern\", \"lyric_framework\" for global scope");
        const merged = kind ? [...mockAgentMemoryGlobal[kind]] : AGENT_MEMORY_GLOBAL_KINDS.flatMap((k) => mockAgentMemoryGlobal[k]);
        return ok(command, { items: agentMemorySelectForRead(merged, limit) });
      }
      return ok(command, { items: agentMemorySelectForRead(mockAgentMemoryProject, limit) });
    }
    // AGT-MEM (M3) — mirrors MoshOps::cmdAgentMemoryDelete: global scope's `kind`
    // selects WHICH FILE to search (all three when omitted); project scope's `kind`,
    // if given, is an extra safety check against the found item's own kind field.
    case "agent_memory_delete": {
      const scope = str(args.scope);
      if (scope !== "global" && scope !== "project")
        return err(command, "'scope' must be \"global\" or \"project\"");
      if (args.ts === undefined) return err(command, "missing 'ts'");
      const ts = num(args.ts, NaN);

      if (scope === "global") {
        const kind = str(args.kind);
        if (kind && !(AGENT_MEMORY_GLOBAL_KINDS as readonly string[]).includes(kind))
          return err(command, "'kind' must be one of \"preference\", \"drum_pattern\", \"lyric_framework\" for global scope");
        const kindsToSearch = kind ? [kind] : AGENT_MEMORY_GLOBAL_KINDS;
        for (const k of kindsToSearch) {
          const store = mockAgentMemoryGlobal[k];
          const idx = store.findIndex((r) => r.ts === ts);
          if (idx >= 0) {
            store.splice(idx, 1);
            return ok(command, { count: store.length });
          }
        }
        return err(command, `no item with ts ${ts} found`);
      }

      const kind = str(args.kind);
      const idx = mockAgentMemoryProject.findIndex((r) => r.ts === ts && (!kind || r.kind === kind));
      if (idx < 0) return err(command, `no item with ts ${ts} found`);
      mockAgentMemoryProject.splice(idx, 1);
      return ok(command, { count: mockAgentMemoryProject.length });
    }
    // AGT-MEM (M3) — mirrors MoshOps::cmdAgentMemoryClear: global scope's `kind`
    // wipes just that ONE kind's store (all three when omitted); project scope's
    // `kind`, if given, removes only notes carrying that kind field.
    case "agent_memory_clear": {
      const scope = str(args.scope);
      if (scope !== "global" && scope !== "project")
        return err(command, "'scope' must be \"global\" or \"project\"");
      const kind = str(args.kind);

      if (scope === "global") {
        if (kind && !(AGENT_MEMORY_GLOBAL_KINDS as readonly string[]).includes(kind))
          return err(command, "'kind' must be one of \"preference\", \"drum_pattern\", \"lyric_framework\" for global scope");
        const kindsToClear = kind ? [kind] : AGENT_MEMORY_GLOBAL_KINDS;
        let cleared = 0;
        for (const k of kindsToClear) {
          cleared += mockAgentMemoryGlobal[k].length;
          mockAgentMemoryGlobal[k] = [];
        }
        return ok(command, { cleared });
      }

      const before = mockAgentMemoryProject.length;
      if (!kind) {
        mockAgentMemoryProject = [];
        return ok(command, { cleared: before });
      }
      const kept = mockAgentMemoryProject.filter((r) => r.kind !== kind);
      const cleared = mockAgentMemoryProject.length - kept.length;
      mockAgentMemoryProject = kept;
      return ok(command, { cleared });
    }
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
      const normalizedMemory = mockMemoryLocation(args.memoryLocation);
      if (normalizedMemory.error) return err(command, normalizedMemory.error);
      pushUndo();
      const ann: Annotation = {
        id: str(args.annotationId) || nextAnnotationId(),
        text: str(args.text, ""),
        beat: num(args.beat, 0),
        color: str(args.color) || undefined,
        author: args.author != null ? str(args.author) : undefined,
        ...(normalizedMemory.value
          ? { memoryLocation: structuredClone(normalizedMemory.value) }
          : {}),
      };
      (snapshot.annotations ??= []).push(ann);
      invalidate(); return ok(command, { annotationId: ann.id });
    }
    case "edit_annotation": {
      const ann = (snapshot.annotations ?? []).find((x) => x.id === str(args.annotationId));
      if (!ann) return err(command, "annotation not found");
      const normalizedMemory = mockMemoryLocation(args.memoryLocation);
      if (Object.prototype.hasOwnProperty.call(args, "memoryLocation") && normalizedMemory.error) {
        return err(command, normalizedMemory.error);
      }
      pushUndo();
      if (args.text != null) ann.text = str(args.text, ann.text);
      if (args.color != null) ann.color = str(args.color) || undefined;
      if (Object.prototype.hasOwnProperty.call(args, "memoryLocation")) {
        ann.memoryLocation = normalizedMemory.value
          ? structuredClone(normalizedMemory.value)
          : undefined;
      }
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
      const activeGroup = (snapshot.clipGroups ?? []).find((group) =>
        group.active && group.clipIds.includes(f.clip.id));
      const groupMembers = activeGroup
        ? activeGroup.clipIds.map((id) => findClip(id)).filter((member) => member !== null)
        : [f];
      // CAP-CLP-017 — the cross-track refusal is validated BEFORE any mutation, exactly
      // like the native handler: ripple describes a distance on the track the clip is
      // leaving, so it has no meaning across a move to another one.
      if (args.ripple && "trackId" in args) {
        const dest = findTrack(str(args.trackId));
        if (dest && dest !== f.track)
          return err(command, "ripple:true cannot be combined with a move to another track");
      }
      if (activeGroup && args.ripple)
        return err(command, "ripple move is not supported for a clip group");
      if (activeGroup && "trackId" in args) {
        const dest = findTrack(str(args.trackId));
        if (dest && dest !== f.track)
          return err(command, "moving a multitrack clip group between tracks is not supported");
      }
      pushUndo();
      const oldStart = f.clip.start, oldEnd = f.clip.start + f.clip.length;
      const requestedDelta = num(args.start, f.clip.start) - f.clip.start;
      const earliestStart = Math.min(...groupMembers.map((member) => member.clip.start));
      const delta = Math.max(requestedDelta, -earliestStart);
      for (const member of groupMembers) member.clip.start += delta;
      if ("trackId" in args) { // move across tracks
        const dest = findTrack(str(args.trackId));
        if (dest && dest !== f.track) { f.track.clips = f.track.clips.filter((c) => c.id !== f.clip.id); dest.clips.push(f.clip); }
      }
      // CAP-CLP-017 — opt-in ripple (default absent ⇒ path above unchanged): same-track
      // clips at/after this clip's OLD end follow by the move distance. Mirrors
      // rippleShiftClipsAfter exactly — negative-start clamp, moved clip excluded.
      if (args.ripple) {
        const delta = f.clip.start - oldStart;
        if (Math.abs(delta) > 1e-6)
          for (const c of f.track.clips)
            if (c.id !== f.clip.id && c.start >= oldEnd - 1e-6)
              c.start = Math.max(0, c.start + delta);
      }
      invalidate(); return ok(command);
    }
    case "create_clip_group": {
      const ids = Array.isArray(args.clipIds)
        ? [...new Set(args.clipIds.map(String))]
        : [];
      if (ids.length === 0) return err(command, "clipIds must contain at least one clip");
      if (ids.some((id) => !findClip(id))) return err(command, "clipIds contains an unknown clip");
      if ((snapshot.clipGroups ?? []).some((group) =>
        group.active && group.clipIds.some((id) => ids.includes(id))))
        return err(command, "one or more clips are already grouped");
      pushUndo();
      const group: ClipGroup = {
        id: nextClipGroupId(),
        name: str(args.name).trim() || "Clip Group",
        clipIds: ids,
        active: true,
      };
      (snapshot.clipGroups ??= []).push(group);
      invalidate();
      return ok(command, { groupId: group.id, clipIds: [...group.clipIds] });
    }
    case "ungroup_clip_group": {
      const clipId = str(args.clipId);
      const group = (snapshot.clipGroups ?? []).find((candidate) =>
        candidate.active && candidate.clipIds.includes(clipId));
      if (!group) return err(command, "active clip group not found");
      pushUndo();
      group.active = false;
      snapshot.lastUngroupedClipGroupId = group.id;
      invalidate();
      return ok(command, { groupId: group.id, clipIds: [...group.clipIds] });
    }
    case "regroup_clip_group": {
      const groupId = str(args.groupId) || snapshot.lastUngroupedClipGroupId || "";
      const group = (snapshot.clipGroups ?? []).find((candidate) => candidate.id === groupId);
      if (!group || group.active) return err(command, "no ungrouped clip group is available to regroup");
      const existingIds = group.clipIds.filter((id) => findClip(id));
      if (existingIds.length === 0) return err(command, "the clip group's members no longer exist");
      if ((snapshot.clipGroups ?? []).some((candidate) =>
        candidate.active && candidate.id !== group.id
          && candidate.clipIds.some((id) => existingIds.includes(id))))
        return err(command, "one or more former members now belong to another clip group");
      pushUndo();
      group.clipIds = existingIds;
      group.active = true;
      delete snapshot.lastUngroupedClipGroupId;
      invalidate();
      return ok(command, { groupId: group.id, clipIds: [...group.clipIds] });
    }
    case "rename_clip_group": {
      const clipId = str(args.clipId);
      const group = (snapshot.clipGroups ?? []).find((candidate) =>
        candidate.clipIds.includes(clipId));
      const name = str(args.name).trim();
      if (!group) return err(command, "clip group not found");
      if (!name) return err(command, "clip group name cannot be empty");
      pushUndo();
      group.name = name;
      invalidate();
      return ok(command, { groupId: group.id, clipIds: [...group.clipIds] });
    }
    case "trim_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo();
      const oldEnd = f.clip.start + f.clip.length;
      if ("start" in args) f.clip.start = Math.max(0, num(args.start, f.clip.start));
      if ("length" in args) f.clip.length = Math.max(0.05, num(args.length, f.clip.length));
      if ("offset" in args) f.clip.offset = Math.max(0, num(args.offset, f.clip.offset));
      // ARR-011 — opt-in ripple (default absent ⇒ path above unchanged): same-track
      // clips at/after the OLD end follow the end delta (mirrors rippleShiftClipsAfter:
      // negative-start clamp, the trimmed clip itself excluded).
      if (args.ripple) {
        const delta = f.clip.start + f.clip.length - oldEnd;
        if (Math.abs(delta) > 1e-6)
          for (const c of f.track.clips)
            if (c.id !== f.clip.id && c.start >= oldEnd - 1e-6)
              c.start = Math.max(0, c.start + delta);
      }
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
      if (f.clip.type === "midi") {
        // MIDI halves keep their type and partition their notes at the cut (the
        // engine's splitClip does exactly this; the wave-only path below predates
        // MIDI splitting in the mock — consolidate_clips' e2e exposed it).
        const beatsPerSec = (snapshot.session.tempo ?? 120) / 60;
        const cutBeat = (t - f.clip.start) * beatsPerSec;
        const leftNotes = (f.clip.notes ?? []).filter((n) => n.start < cutBeat);
        const rightNotes = (f.clip.notes ?? [])
          .filter((n) => n.start >= cutBeat)
          .map((n) => ({ ...n, start: n.start - cutBeat }));
        const right = midiClip(f.clip.name, t, f.clip.start + f.clip.length - t, rightNotes);
        f.clip.notes = leftNotes;
        f.clip.length = t - f.clip.start;
        f.track.clips.push(right);
        invalidate(); return ok(command, { clipId: right.id });
      }
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
    case "bounce_track": {
      // Mirrors cmdBounceTrack's STATE changes (the audio render itself is engine-verified
      // in the native selftest; the mock models the resulting clip/track structure).
      const t = snapshot.tracks.find((tr) => tr.id === str(args.trackId));
      if (!t || t.isGroup || t.isReturn) return err(command, "no bounceable track (groups, returns and the master bus can't be bounced)");
      const mode = str(args.mode);
      if (mode !== "inPlace" && mode !== "newTrack") return err(command, "mode must be inPlace|newTrack");
      const lastEnd = t.clips.reduce((m, c) => Math.max(m, c.start + c.length), 0);
      if (lastEnd <= 1e-4) return err(command, "track has no clips to bounce");
      pushUndo();
      const rendered: Clip = { id: nextClipId(), name: t.name, type: "wave",
                               start: 0, length: lastEnd, offset: 0, hasRenderLayer: false };
      if (mode === "inPlace") {
        t.clips = [rendered];
        invalidate();
        return ok(command, { mode, length: lastEnd, trackId: t.id, clipId: rendered.id });
      }
      const idx = snapshot.tracks.indexOf(t);
      const nt: Track = { id: nextTrackId(), index: idx + 1, name: `${t.name} (bounce)`, type: "audio",
                          volumeDb: 0, pan: 0, mute: false, solo: false, clips: [rendered], plugins: [] } as Track;
      snapshot.tracks.splice(idx + 1, 0, nt);
      snapshot.tracks.forEach((tr, i) => (tr.index = i));
      invalidate();
      return ok(command, { mode, length: lastEnd, trackId: nt.id, clipId: rendered.id, sourceTrackId: t.id });
    }
    case "freeze_track": {
      // Mirrors cmdFreezeTrack's STATE changes (the audio render itself is
      // engine-verified in the native selftest): the clips become one wave clip
      // spanning [0, last end], every device is parked (enabled false), and the
      // additive frozen marker goes on the track. Undo semantics ride pushUndo,
      // same as the engine's single transaction.
      const t = snapshot.tracks.find((tr) => tr.id === str(args.trackId));
      if (!t || t.isGroup || t.isReturn) return err(command, "no freezable track (groups, returns and the master bus can't be frozen)");
      if (t.frozen) return err(command, "track is already frozen");
      const lastEnd = t.clips.reduce((m, c) => Math.max(m, c.start + c.length), 0);
      if (lastEnd <= 1e-4) return err(command, "track has no clips to freeze");
      pushUndo();
      const rendered: Clip = { id: nextClipId(), name: t.name, type: "wave",
                               start: 0, length: lastEnd, offset: 0, hasRenderLayer: false };
      t.clips = [rendered];
      for (const p of t.plugins ?? []) p.enabled = false;
      t.frozen = true;
      invalidate();
      return ok(command, { clipId: rendered.id });
    }
    case "unfreeze_track": {
      // Mirrors cmdUnfreezeTrack: devices back on, marker gone, rendered clips STAY.
      const t = snapshot.tracks.find((tr) => tr.id === str(args.trackId));
      if (!t) return err(command, "no track");
      if (!t.frozen) return err(command, "track is not frozen");
      pushUndo();
      for (const p of t.plugins ?? []) p.enabled = true;
      delete t.frozen;   // additive-absent — the snapshot's unfrozen shape
      invalidate();
      return ok(command);
    }
    // ARR-011 — remove everything in [start, end] across ALL tracks (or an optional
    // trackIds subset — a real JSON array, deliberately NOT in the agent catalog).
    // Produces the same end state as the native split-at-bounds + remove-inside
    // pipeline: straddling clips keep their outside piece(s), the right piece is a
    // NEW clip (native splitClip mints the new id on the right half) whose source
    // offset advances past the removed span; MIDI pieces keep the notes that fall
    // inside them (beats re-based via the session tempo). ripple:true then slides
    // every clip at/after the range END left by the range length (clamped at 0).
    case "delete_time_range": {
      const start = num(args.start, 0), end = num(args.end, 0);
      if (!(start < end)) return err(command, "start must be less than end");
      const ripple = Boolean(args.ripple);
      const idsArg = Array.isArray(args.trackIds) ? (args.trackIds as unknown[]).map(String) : null;
      const targets = idsArg ? snapshot.tracks.filter((t) => idsArg.includes(t.id)) : snapshot.tracks;
      pushUndo();
      const EPS = 5e-4;
      const beatsPerSec = (snapshot.session.tempo || 120) / 60;
      let removed = 0, splits = 0;
      for (const t of targets) {
        const next: typeof t.clips = [];
        for (const c of t.clips) {
          const c0 = c.start, c1 = c.start + c.length;
          if (c1 <= start + EPS || c0 >= end - EPS) { next.push(c); continue; }   // fully outside
          const leftKeep = c0 < start - EPS;
          const rightKeep = c1 > end + EPS;
          if (rightKeep) {
            const right = JSON.parse(JSON.stringify(c)) as typeof c;
            right.id = nextClipId();
            right.start = end;
            right.length = c1 - end;
            right.offset = (c.offset ?? 0) + (end - c0);
            if (right.notes) {
              const cutBeats = (end - c0) * beatsPerSec;
              right.notes = right.notes
                .filter((n) => n.start >= cutBeats - 1e-9)
                .map((n) => ({ ...n, start: n.start - cutBeats }));
              reindexNotes(right);
            }
            next.push(right);
            splits++;
          }
          if (leftKeep) {
            c.length = start - c0;
            if (c.notes) {
              const keepBeats = (start - c0) * beatsPerSec;
              c.notes = c.notes.filter((n) => n.start < keepBeats - 1e-9);
              reindexNotes(c);
            }
            next.push(c);
            splits++;
          }
          removed++;   // the middle segment is gone
        }
        t.clips = next.sort((a, b) => a.start - b.start);
        if (ripple)
          for (const c of t.clips)
            if (c.start >= end - 1e-6) c.start = Math.max(0, c.start - (end - start));
      }
      invalidate();
      return ok(command, { removed, splits, tracks: targets.length, ripple });
    }
    // CAP-CLP-017 — insert_time: open `duration` seconds at `start` and push everything
    // after it right. The inverse of the ripple delete above, and modelled here to the
    // same depth the mock models anything: clips (split at the point, then shifted),
    // plugin-parameter automation on the targeted tracks AND the master bus (points
    // shifted, with hold points at both edges of the new span so the value is held FLAT
    // across it), the tempo map, beat-anchored sections/annotations, and the loop region.
    //
    // The one native behaviour the mock does NOT reproduce is the clip-ORDER hazard the
    // native handler exists to dodge (Tracktion sorts its clip list asynchronously; a JS
    // array has no such thing). So a green mock run is NOT evidence about that — the
    // "clips in un-sorted order" case is proven in --selftest against the real engine.
    case "insert_time": {
      const start = num(args.start, 0), duration = num(args.duration, 0);
      if (start < 0) return err(command, "start must be >= 0");
      if (!(duration > 0)) return err(command, "duration must be greater than 0");
      const idsArg = Array.isArray(args.trackIds) ? (args.trackIds as unknown[]).map(String) : null;
      const scoped = idsArg !== null;
      const targets = idsArg ? snapshot.tracks.filter((t) => idsArg.includes(t.id)) : snapshot.tracks;
      pushUndo();
      const EPS = 1e-6;
      const beatsPerSec = (snapshot.session.tempo || 120) / 60;

      // Points at/after the insertion point move right; a hold point at each edge keeps
      // the value in force at `start` flat across the new space instead of stretching a
      // ramp through it. Mirrors te::Track::insertSpaceIntoTrack, which is what the
      // native side calls.
      const shiftAutomation = (plugins: typeof snapshot.tracks[number]["plugins"]) => {
        for (const pl of plugins ?? [])
          for (const p of pl.params ?? []) {
            if (!p.points?.length) continue;
            // Linear between neighbours, flat outside the curve's own span — the shape
            // te::AutomationCurve::getValueAt produces for the curve:0 points
            // add_automation_point writes. A step-function read here would report the
            // wrong held value and quietly make the hold pair a lie.
            const valueAt = (t: number) => {
              const pts = p.points!;
              if (t <= pts[0].t + EPS) return pts[0].v;
              for (let i = 1; i < pts.length; i++) {
                if (t > pts[i].t + EPS) continue;
                const span = pts[i].t - pts[i - 1].t;
                return span <= EPS ? pts[i].v
                  : pts[i - 1].v + (pts[i].v - pts[i - 1].v) * ((t - pts[i - 1].t) / span);
              }
              return pts[pts.length - 1].v;
            };
            const held = valueAt(start);
            for (const pt of p.points) if (pt.t >= start - EPS) pt.t += duration;
            p.points.push({ t: start, v: held }, { t: start + duration, v: held });
            p.points.sort((a, b) => a.t - b.t);
          }
      };

      let splits = 0, clipsMoved = 0;
      for (const t of targets) {
        const next: typeof t.clips = [];
        for (const c of t.clips) {
          const c0 = c.start, c1 = c.start + c.length;
          if (c0 < start - EPS && c1 > start + EPS) {   // straddles → split at the point
            const right = JSON.parse(JSON.stringify(c)) as typeof c;
            right.id = nextClipId();
            right.start = start;
            right.length = c1 - start;
            right.offset = (c.offset ?? 0) + (start - c0);
            if (right.notes) {
              const cutBeats = (start - c0) * beatsPerSec;
              right.notes = right.notes.filter((n) => n.start >= cutBeats - 1e-9)
                                       .map((n) => ({ ...n, start: n.start - cutBeats }));
              reindexNotes(right);
            }
            c.length = start - c0;
            if (c.notes) {
              const keepBeats = (start - c0) * beatsPerSec;
              c.notes = c.notes.filter((n) => n.start < keepBeats - 1e-9);
              reindexNotes(c);
            }
            next.push(c, right);
            splits++;
          } else next.push(c);
        }
        for (const c of next)
          if (c.start >= start - EPS) { c.start += duration; clipsMoved++; }
        t.clips = next.sort((a, b) => a.start - b.start);
        shiftAutomation(t.plugins);
      }

      let sectionsMoved = 0, annotationsMoved = 0, loopShifted = false;
      if (!scoped) {
        shiftAutomation(snapshot.master?.plugins);
        for (const m of snapshot.session.tempoMap ?? []) if (m.time >= start - EPS) m.time += duration;
        // Sections/annotations are BEAT-anchored: shift by the beat width of the new span.
        const beatAt = start * beatsPerSec, beatDelta = duration * beatsPerSec;
        for (const s of snapshot.sections ?? []) {
          if (s.endBeat <= beatAt + EPS) continue;
          if (s.startBeat >= beatAt - EPS) s.startBeat += beatDelta;   // whole → moves
          s.endBeat += beatDelta;                                      // straddling → grows
          sectionsMoved++;
        }
        for (const a of snapshot.annotations ?? [])
          if (a.beat >= beatAt - EPS) { a.beat += beatDelta; annotationsMoved++; }
        const tr = snapshot.transport;
        if (tr.loopEnd - tr.loopStart > EPS && tr.loopEnd > start + EPS) {
          if (tr.loopStart >= start - EPS) tr.loopStart += duration;   // whole → moves
          tr.loopEnd += duration;                                      // straddling → grows
          loopShifted = true;
        }
      }
      invalidate();
      return ok(command, { start, duration, tracks: targets.length, splits, clipsMoved,
                           sectionsMoved, annotationsMoved, loopShifted, scoped });
    }
    case "duplicate_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo();
      const dup: Clip = {
        ...f.clip,
        id: nextClipId(),
        start: f.clip.start + f.clip.length,
        notes: f.clip.notes?.map((note) => ({ ...note })),
        clipGainPoints: f.clip.clipGainPoints?.map((point) => ({ ...point })),
      };
      f.track.clips.push(dup); invalidate(); return ok(command, { newClipId: dup.id });
    }
    case "consolidate_clips": {
      // Mirrors MoshOps::cmdConsolidateClips — MIDI-only merge, one undo step, notes
      // re-anchored clip-local. The mock's session tempo drives seconds→beats (its
      // clips are seconds, its notes clip-local beats; the tempo map is a UI-side
      // concern here — the seed and every test project are constant-tempo).
      const ids = (Array.isArray(args.clipIds) ? args.clipIds : []).map(String);
      const found = ids.map((id) => findClip(id)).filter((f): f is NonNullable<typeof f> => !!f);
      if (found.length === 0) return err(command, "no clips found");
      const track = found[0].track;
      let midiCount = 0, waveCount = 0;
      for (const f of found) {
        if (f.track !== track) return err(command, "consolidate works within one track");
        if (f.clip.type === "midi") midiCount++;
        else if (f.clip.type === "wave") waveCount++;
        else return err(command, "consolidate works on MIDI and audio clips");
      }
      if (midiCount > 0 && waveCount > 0)
        return err(command, "a mixed MIDI + audio selection can't consolidate — consolidate per type (Live's rule)");
      if (waveCount > 0) {
        // WAVE path — mirrors the engine's render-consolidate at the structure level
        // (audio content is engine-verified in the native selftest).
        const spanStart = Math.min(...found.map((f) => f.clip.start));
        const spanEnd = Math.max(...found.map((f) => f.clip.start + f.clip.length));
        const selected = new Set(found.map((f) => f.clip));
        for (const c of track.clips)
          if (!selected.has(c) && c.start + c.length > spanStart + 1e-4 && c.start < spanEnd - 1e-4)
            return err(command, "an unselected clip overlaps the span — include it or move it before consolidating");
        pushUndo();
        track.clips = track.clips.filter((c) => !selected.has(c));
        const merged: Clip = { id: nextClipId(), name: found[0].clip.name, type: "wave",
                               start: spanStart, length: spanEnd - spanStart, offset: 0,
                               hasRenderLayer: false };
        track.clips.push(merged);
        invalidate();
        return ok(command, { newClipId: merged.id, file: `/mock/consolidate/${track.id}.wav` });
      }
      pushUndo();
      const spanStart = Math.min(...found.map((f) => f.clip.start));
      const spanEnd = Math.max(...found.map((f) => f.clip.start + f.clip.length));
      const beatsPerSec = (snapshot.session.tempo ?? 120) / 60;
      const notes: MidiNote[] = [];
      for (const f of found)
        for (const n of f.clip.notes ?? [])
          notes.push({ i: notes.length, pitch: n.pitch, velocity: n.velocity,
                       start: (f.clip.start - spanStart) * beatsPerSec + n.start,
                       length: n.length, ...(n.mute ? { mute: true } : {}) });
      track.clips = track.clips.filter((c) => !ids.includes(c.id));
      const merged: Clip = { id: nextClipId(), name: found[0].clip.name, type: "midi",
                             start: spanStart, length: spanEnd - spanStart, offset: 0,
                             hasRenderLayer: false, notes };
      track.clips.push(merged); invalidate();
      return ok(command, { newClipId: merged.id, noteCount: notes.length });
    }
    case "crop_clip": {
      // Mirrors MoshOps::cmdCropClip — trim each given clip to its intersection with
      // the passed range; MIDI notes outside the crop are removed, crossing notes
      // clipped to the edge and re-anchored clip-local; audio edge-trims with the
      // offset advanced. One undo step; the same no-selection/no-overlap/already-
      // covering refusals as the engine.
      const start = num(args.start), end = num(args.end);
      if (!(end > start)) return err(command, "crop needs a time selection (start < end)");
      const ids = (Array.isArray(args.clipIds) ? args.clipIds : []).map(String);
      const found = ids.map((id) => findClip(id)).filter((f): f is NonNullable<typeof f> => !!f);
      if (found.length === 0) return err(command, "no clips found");
      const plans = found.map((f) => {
        const cs = f.clip.start, ce = f.clip.start + f.clip.length;
        const s = Math.max(cs, start), e = Math.min(ce, end);
        return { f, s, e, startMoved: s > cs + 1e-9, endMoved: e < ce - 1e-9 };
      }).filter((p) => p.e > p.s);
      if (plans.length === 0) return err(command, "the time selection does not overlap the clip(s)");
      if (!plans.some((p) => p.startMoved || p.endMoved))
        return err(command, "the time selection already covers the clip(s)");
      pushUndo();
      const beatsPerSec = (snapshot.session.tempo ?? 120) / 60;
      for (const p of plans) {
        if (!p.startMoved && !p.endMoved) continue;
        const c = p.f.clip;
        if (c.type === "midi" && c.notes) {
          const cropStartBeat = (p.s - c.start) * beatsPerSec;
          const cropEndBeat = (p.e - c.start) * beatsPerSec;
          const kept: MidiNote[] = [];
          for (const n of c.notes) {
            const ns = n.start, ne = n.start + n.length;
            if (ns >= cropEndBeat - 1e-4 || ne <= cropStartBeat + 1e-4) continue;   // fully outside
            const s2 = Math.max(ns, cropStartBeat), e2 = Math.min(ne, cropEndBeat);
            kept.push({ ...n, i: kept.length, start: s2 - cropStartBeat, length: e2 - s2 });
          }
          c.notes = kept;
        } else {
          c.offset = Math.max(0, c.offset + (p.s - c.start));
        }
        c.start = p.s; c.length = p.e - p.s;
      }
      invalidate(); return ok(command);
    }
    case "rename_clip": { const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found"); pushUndo(); f.clip.name = str(args.name, f.clip.name); invalidate(); return ok(command); }
    case "set_clip_mute": { const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found"); pushUndo(); f.clip.mute = Boolean(args.mute); invalidate(); return ok(command); }
    case "set_clip_gain": { const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found"); pushUndo(); f.clip.gainDb = num(args.gainDb); invalidate(); return ok(command); }
    case "write_clip_gain_curve": {
      const found = findClip(str(args.clipId));
      if (!found) return err(command, "clip not found");
      if (found.clip.type !== "wave") return err(command, "not an audio clip");
      const parsed = parseMockClipGainPoints(args.points);
      if (!parsed.ok) return err(command, parsed.error);
      pushUndo();
      if (parsed.points.length === 0) delete found.clip.clipGainPoints;
      else found.clip.clipGainPoints = parsed.points;
      invalidate();
      return ok(command, { pointCount: parsed.points.length });
    }
    // G4b — clip fades: clamps each dimension present in args to [0, clip.length]
    // (mirrors the engine's no-boundary-move clamp). Curve names map to the same
    // te::AudioFadeCurve::Type ints (1..4) the native snapshot carries. Like
    // set_clip_gain above, the mock does not gate on clip type — the UI only ever
    // calls this for wave clips (ClipTab), and the real audio-clip-only rejection
    // is a backend contract proven by the native selftest, not re-derived here.
    case "set_clip_fade": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo();
      if ("fadeInSec" in args) f.clip.fadeInSec = Math.max(0, Math.min(num(args.fadeInSec), f.clip.length));
      if ("fadeOutSec" in args) f.clip.fadeOutSec = Math.max(0, Math.min(num(args.fadeOutSec), f.clip.length));
      if ("curveIn" in args) f.clip.fadeInType = FADE_CURVE_TYPE[str(args.curveIn)] ?? 1;
      if ("curveOut" in args) f.clip.fadeOutType = FADE_CURVE_TYPE[str(args.curveOut)] ?? 1;
      invalidate();
      return ok(command, { clipId: f.clip.id, fadeInSec: f.clip.fadeInSec, fadeOutSec: f.clip.fadeOutSec });
    }
    // clip-ops wave — reverse / auto-crossfade: like set_clip_gain/set_clip_fade above,
    // the mock does not gate on clip type (the UI only ever calls these for wave clips;
    // the real audio-clip-only rejection is a backend contract proven natively).
    case "set_clip_reverse": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo(); f.clip.reversed = Boolean(args.reversed); invalidate(); return ok(command);
    }
    case "set_clip_crossfade": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo(); f.clip.autoCrossfade = Boolean(args.enabled); invalidate(); return ok(command);
    }
    // CLP-LOOP — clip loop region. Mirrors the native semantics that matter to the UI:
    // "looping" IS "loop length > 0" (there is no separate flag in the engine), disabling
    // zeroes the region without touching the clip's position/length, and enabling with a
    // non-positive length is an error. The native source-length clamp is not modelled —
    // the mock has no real source file to clamp against.
    case "set_clip_loop": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      const enabled = Boolean(args.enabled);
      // MIDI branch — mirrors cmdSetClipLoop's MIDI case: content-relative seconds
      // converted to beats at the session tempo (mock sessions are constant-tempo),
      // stored as the additive midiLoop*Beats fields (absent when not looping).
      if (f.clip.type === "midi") {
        const curLenBeats = f.clip.midiLoopLengthBeats ?? 0;
        const beatsPerSec = (snapshot.session.tempo ?? 120) / 60;
        const length = "length" in args ? num(args.length) : (curLenBeats > 0 ? curLenBeats / beatsPerSec : f.clip.length);
        if (enabled && !(length > 0)) return err(command, "loop length must be greater than 0 when enabled");
        pushUndo();
        if (enabled) {
          f.clip.midiLoopStartBeats = Math.max(0, "start" in args ? num(args.start) * beatsPerSec : curLenBeats > 0 ? (f.clip.midiLoopStartBeats ?? 0) : 0);
          f.clip.midiLoopLengthBeats = length * beatsPerSec;
        } else {
          delete f.clip.midiLoopStartBeats;
          delete f.clip.midiLoopLengthBeats;
        }
        invalidate();
        return ok(command, {
          clipId: f.clip.id,
          loopEnabled: enabled,
          midiLoopStartBeats: f.clip.midiLoopStartBeats ?? 0,
          midiLoopLengthBeats: f.clip.midiLoopLengthBeats ?? 0,
        });
      }
      const length = "length" in args ? num(args.length) : (f.clip.loopLength || f.clip.length);
      if (enabled && !(length > 0)) return err(command, "loop length must be greater than 0 when enabled");
      pushUndo();
      if (enabled) {
        f.clip.loopStart = Math.max(0, "start" in args ? num(args.start) : (f.clip.loopStart ?? 0));
        f.clip.loopLength = length;
      } else {
        f.clip.loopStart = 0;
        f.clip.loopLength = 0;
      }
      f.clip.loopEnabled = (f.clip.loopLength ?? 0) > 0;
      invalidate();
      return ok(command, {
        clipId: f.clip.id,
        loopEnabled: f.clip.loopEnabled,
        loopStart: f.clip.loopStart,
        loopLength: f.clip.loopLength,
      });
    }
    // normalize_clip: the dev mock has no real audio samples to scan, so it assumes a
    // fixed nominal source peak of -6 dBFS (gain = targetDb - assumedPeakDb, mirroring
    // the native formula) — deterministic and testable without decoding a WAV in-browser.
    case "normalize_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      if (f.clip.type !== "wave") return err(command, "no wave clip");
      pushUndo();
      const targetDb = "targetDb" in args ? num(args.targetDb) : 0;
      const assumedPeakDb = -6;
      const gainDb = Math.max(-48, Math.min(24, targetDb - assumedPeakDb));
      f.clip.gainDb = gainDb;
      invalidate();
      return ok(command, { clipId: f.clip.id, gainDb, peakDb: assumedPeakDb });
    }

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
    // act on that tree. arm, monitor, and take landing mirror the backend's
    // non-undoable recording lifecycle; later comp selection remains undoable.
    case "arm_track": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      // REC-NO-INPUT fixture: degrade EXACTLY like the engine with no input
      // instances (ok, applied:false, reason "no input device"; the arm doesn't stick)
      if (MOCK_NO_INPUT && args.armed)
        return ok(command, { trackId: t.id, armed: true, applied: false, reason: "no input device" });
      t.armed = Boolean(args.armed); invalidate();
      return ok(command, { trackId: t.id, armed: t.armed, applied: true });
    }
    case "set_input_monitor": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      const mode = str(args.mode, "automatic");
      t.monitor = mode === "off" || mode === "on" ? mode : "automatic";
      invalidate();
      // Mirrors the NATIVE result shape (MoshOps.cpp cmdSetInputMonitor): {trackId, mode,
      // applied, reason?} — not the {monitor} this used to return before anything called
      // it from the UI. `applied` is always true here (the dev mock always simulates a
      // connected input, see mockAudioSel); the real applied:false/reason path (no input
      // device instance targets this track) is exercised in the UI test via a direct
      // exec override, not through this mock.
      return ok(command, { trackId: t.id, mode: t.monitor, applied: true });
    }
    case "stop_recording": {
      return ok(command, finalizeMockRecording(Boolean(args.discardRecordings)));
    }
    case "list_takes": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      const takes = f.clip.takes ?? [];
      // Per-take peaks (take-lanes wave) — deterministic per (clip, take index),
      // distinct across takes, mirroring the engine's additive field shape
      // ([min,max] bucket pairs) so the lanes draw real ink in dev/e2e.
      const withPeaks = takes.map((tk) => ({ ...tk, peaks: mockTakePeaks(f.clip.id, tk.index) }));
      return ok(command, {
        takes: withPeaks,
        numTakes: f.clip.numTakes ?? takes.length,
        currentTakeIndex: f.clip.currentTakeIndex ?? 0,
        // Skill Foundry Slice B, Task 1 — additive stable-id projections (mirrors native
        // cmdListTakes' "id" field / clipToVar's takeIds/currentTakeId).
        takeIds: f.clip.takeIds ?? takes.map((tk) => tk.id ?? ""),
        currentTakeId: f.clip.currentTakeId ?? "",
      });
    }
    case "set_current_take": {
      const f = findClip(str(args.clipId)); if (!f?.clip.takes) return err(command, "clip has no takes");
      const idx = num(args.takeIndex);
      if (idx < 0 || idx >= f.clip.takes.length) return err(command, "take index out of range");
      pushUndo();
      f.clip.takes.forEach((tk) => (tk.isCurrent = tk.index === idx));
      f.clip.currentTakeIndex = idx;
      syncTakeIdProjections(f.clip);
      invalidate(); return ok(command);
    }
    case "promote_take_region": {
      const f = findClip(str(args.clipId));
      if (!f || f.clip.type !== "wave") return err(command, "no wave clip");
      if (!f.clip.takes || f.clip.takes.length === 0) return err(command, "clip has no takes");
      const takeIndex = args.takeIndex;
      const start = args.start;
      const end = args.end;
      if (typeof takeIndex !== "number" || !Number.isInteger(takeIndex)
        || takeIndex < 0 || takeIndex >= f.clip.takes.length)
        return err(command, "take index out of range");
      if (typeof start !== "number" || typeof end !== "number"
        || !Number.isFinite(start) || !Number.isFinite(end))
        return err(command, "start and end must be finite timeline seconds");
      const clipStart = f.clip.start;
      const clipEnd = clipStart + f.clip.length;
      const EPS = 1e-6;
      if (start < clipStart - EPS || end > clipEnd + EPS || end <= start + EPS)
        return err(command, "range must be inside the visible clip with start before end");

      const rangeStart = Math.max(clipStart, start);
      const rangeEnd = Math.min(clipEnd, end);
      const original = JSON.parse(JSON.stringify(f.clip)) as Clip;
      const hasLeft = rangeStart > clipStart + EPS;
      const hasRight = rangeEnd < clipEnd - EPS;
      pushUndo();

      const segments: Clip[] = [];
      if (hasLeft) {
        const left = JSON.parse(JSON.stringify(original)) as Clip;
        left.length = rangeStart - clipStart;
        left.fadeOutSec = 0;
        segments.push(left);
      }
      const middle = JSON.parse(JSON.stringify(original)) as Clip;
      middle.id = hasLeft ? nextClipId() : original.id;
      middle.start = rangeStart;
      middle.length = rangeEnd - rangeStart;
      middle.offset = original.offset + (rangeStart - clipStart);
      if (hasLeft) middle.fadeInSec = 0;
      if (hasRight) middle.fadeOutSec = 0;
      middle.takes?.forEach((take) => { take.isCurrent = take.index === takeIndex; });
      middle.currentTakeIndex = takeIndex;
      syncTakeIdProjections(middle);
      segments.push(middle);

      let tail: Clip | undefined;
      if (hasRight) {
        tail = JSON.parse(JSON.stringify(original)) as Clip;
        tail.id = nextClipId();
        tail.start = rangeEnd;
        tail.length = clipEnd - rangeEnd;
        tail.offset = original.offset + (rangeEnd - clipStart);
        tail.fadeInSec = 0;
        segments.push(tail);
      }
      const sourceIndex = f.track.clips.findIndex((clip) => clip.id === original.id);
      f.track.clips.splice(sourceIndex, 1, ...segments);
      invalidate();
      return ok(command, {
        clipId: middle.id,
        ...(tail ? { newClipId: tail.id } : {}),
        takeIndex,
        start: rangeStart,
        end: rangeEnd,
        applied: true,
      });
    }
    case "keep_take": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      if (!f.clip.takes || f.clip.takes.length === 0) return err(command, "clip has no takes");

      // Skill Foundry Slice B, Task 1 — an OPTIONAL, stable-id target for Keep, additive
      // to the legacy `{clipId}`-only call (which keeps whichever take is already
      // current — unchanged below). Resolved and guarded BEFORE pushUndo/any mutation,
      // mirroring the native command's "validate every guard before beginTxn" discipline:
      // a malformed or unknown id mutates nothing.
      let targetIndex = -1;
      if (typeof args.takeId === "string") {
        const takeId = args.takeId;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(takeId))
          return err(command, "malformed takeId");
        const matches = f.clip.takes.filter((tk) => tk.id === takeId);
        if (matches.length === 0) return err(command, "no take with that id");
        if (matches.length > 1) return err(command, "duplicate takeId in take set");
        targetIndex = f.clip.takes.findIndex((tk) => tk.id === takeId);
      }

      pushUndo();
      const cur = targetIndex >= 0 ? targetIndex : (f.clip.currentTakeIndex ?? f.clip.takes.findIndex((tk) => tk.isCurrent));
      const kept = f.clip.takes[cur >= 0 ? cur : 0] ?? f.clip.takes[0];
      if (kept?.description) f.clip.name = kept.description; // flatten the comp to the kept take
      delete f.clip.takes; delete f.clip.numTakes; delete f.clip.currentTakeIndex;
      delete f.clip.takeIds; delete f.clip.currentTakeId;
      invalidate(); return ok(command);
    }
    case "mark_take": {
      emit("controller_event", args);
      return ok(command);
    }

    case "set_tempo": {
      pushUndo();
      snapshot.session.tempo = Math.max(20, num(args.bpm, snapshot.session.tempo));
      // Point 0 of the tempo map IS the base tempo — keep them in lockstep.
      if (snapshot.session.tempoMap?.[0]) snapshot.session.tempoMap[0].bpm = snapshot.session.tempo;
      invalidate(); return ok(command);
    }
    // SES-001 — tempo-map points beyond the base tempo. Times in seconds; a point's
    // curve shapes the span from IT to the NEXT point (1 = step, (-1,1) = ramp).
    // Error strings mirror MoshOps::cmdInsertTempoChange / cmdRemoveTempoChange.
    case "insert_tempo_change": {
      const time = num(args.time, -1);
      if (time < 0) return err(command, "missing/negative 'time'");
      const bpm = num(args.bpm, 0);
      if (bpm < 20 || bpm > 999) return err(command, "bpm must be 20..999");
      const curve = Math.max(-1, Math.min(1, num(args.curve, 1)));
      pushUndo();
      const map = (snapshot.session.tempoMap ??= [{ time: 0, bpm: snapshot.session.tempo, curve: 1 }]);
      map.push({ time, bpm, curve });
      map.sort((a, b) => a.time - b.time);
      snapshot.session.tempo = map[0].bpm;
      invalidate();
      return ok(command, { time, bpm, curve, count: map.length });
    }
    case "remove_tempo_change": {
      const map = snapshot.session.tempoMap ?? [];
      const index = num(args.index, -1);
      if (index <= 0 || index >= map.length) return err(command, "index must be 1..numTempos-1");
      pushUndo();
      map.splice(index, 1);
      invalidate();
      return ok(command, { count: map.length });
    }
    case "set_key": { pushUndo(); snapshot.session.key = { tonic: str(args.tonic, snapshot.session.key?.tonic ?? "A"), mode: str(args.mode, snapshot.session.key?.mode ?? "minor") }; invalidate(); return ok(command); }
    case "set_count_in": {
      const bars = num(args.bars, snapshot.session.countInBars ?? 0);
      if (![0, 1, 2].includes(bars)) return err(command, "bars must be 0 (off), 1 (one bar), or 2 (two bars)");
      // Preference — NOT undoable (mirrors native's logLine(..., false); see cmdSetCountIn
      // in MoshOps.cpp). No pushUndo() here, unlike the mutation commands above.
      snapshot.session.countInBars = bars; invalidate(); return ok(command);
    }
    // REC-001 — the same partial-patch shape as native: each field independent, an
    // out-of-domain value refused WITHOUT writing any of the others. Preference, so no
    // pushUndo (mirrors cmdSetRecordOptions' logLine(..., false)).
    case "set_record_options": {
      const cur = snapshot.session.project?.recordOptions;
      if (!cur) return err(command, "no record options on this snapshot");
      // Mirrors kQuantGrids in MoshOps.Record.cpp — deliberately irregular, and refused
      // rather than snapped, exactly as native does it.
      const GRIDS: [number, string][] = [
        [0, "(none)"], [1 / 64, "1/64 beat"], [1 / 32, "1/32 beat"], [1 / 24, "1/24 beat"],
        [1 / 16, "1/16 beat"], [1 / 12, "1/12 beat"], [1 / 9, "1/9 beat"], [1 / 8, "1/8 beat"],
        [1 / 6, "1/6 beat"], [1 / 4, "1/4 beat"], [1 / 3, "1/3 beat"], [1 / 2, "1/2 beat"], [1, "1 beat"],
      ];
      if (args.quantize !== undefined) {
        const q = num(args.quantize, 0);
        const hit = GRIDS.find(([b]) => Math.abs(b - q) <= 1e-6 * Math.max(1, Math.abs(b)));
        if (!hit) return err(command, `quantize must be one of these beat divisions: ${GRIDS.map(([b]) => b).join(", ")}`);
        cur.quantize = hit[0];
        cur.quantizeLabel = hit[1];
      }
      if (args.retrospectiveSeconds !== undefined) {
        const s = num(args.retrospectiveSeconds, 10);
        if (s < 0 || s > 60) return err(command, "retrospectiveSeconds must be 0..60");
        cur.retrospectiveSeconds = s;
      }
      if (args.overdub !== undefined) cur.overdub = !!args.overdub;
      if (args.replaceExisting !== undefined) cur.replaceExisting = !!args.replaceExisting;
      if (args.punchInOut !== undefined) cur.punchInOut = !!args.punchInOut;
      invalidate();
      return ok(command, { ...cur });
    }
    // REC-001 — Capture MIDI. The mock has no retrospective buffer (nothing is ever
    // PLAYED into it in a browser), so it answers with the same graceful applied:false
    // shape native gives when the buffer is empty, rather than inventing a clip. That
    // keeps the UI's empty-handed path — the common one — honest in dev and e2e.
    case "capture_midi":
      return ok(command, { applied: false, clips: [], reason: "nothing had been played into the retrospective buffer" });
    case "set_master_volume": { pushUndo(); if (snapshot.master) snapshot.master.volumeDb = num(args.db); invalidate(); return ok(command); }

    case "undo": {
      if (!history.length) return ok(command, { undone: false });
      future.push(clone(snapshot)); snapshot = history.pop()!; stopPlayback(); invalidate(); return ok(command, { undone: true });
    }
    case "redo": {
      if (!future.length) return ok(command, { redone: false });
      history.push(clone(snapshot)); snapshot = future.pop()!; stopPlayback(); invalidate(); return ok(command, { redone: true });
    }
    // CAP-PRJ-005 — jump to a point in undo history. Same contract as MoshOps: the
    // argument is a history STAMP, resolved against the live timeline here rather than a
    // step count computed by the caller, so a non-undoable command or a batch in the
    // middle cannot make the landing wrong. Undo/redo above do NOT touch mockTxnIds:
    // moving the cursor is history.length changing, and the ids stay put.
    case "jump_to_history": {
      const target = str(args.txn).trim();
      if (!target) return err(command, "txn is required (the history stamp of the point to restore)");
      if (inBatch) return err(command, "a batch is open; end or roll it back before jumping");
      if (!target.startsWith(`${MOCK_HISTORY_TOKEN}:`))
        return err(command, "that point belongs to an earlier session and can no longer be restored");
      const suffix = target.slice(MOCK_HISTORY_TOKEN.length + 1);
      if (!/^\d+$/.test(suffix)) return err(command, `malformed txn stamp: ${target}`);
      const wanted = Number(suffix);
      const found = mockTxnIds.indexOf(wanted);
      // wanted === 0 is the session's own starting point, always reachable by undoing
      // everything. Anything else must still be ON the timeline; -1 is a refusal.
      const destination = wanted === 0 ? 0 : found + 1;
      if (!Number.isFinite(wanted) || (wanted !== 0 && found < 0))
        return err(command, "that point is no longer in the undo history (it was undone past and overwritten by a later edit, or dropped as the history filled)");
      const from = history.length;
      let undone = 0, redone = 0;
      while (history.length > destination) { future.push(clone(snapshot)); snapshot = history.pop()!; undone++; }
      while (history.length < destination && future.length) { history.push(clone(snapshot)); snapshot = future.pop()!; redone++; }
      if (undone > 0 || redone > 0) stopPlayback();
      invalidate();
      return ok(command, { txn: mockHistoryTxn(), undone, redone, from, depth: history.length });
    }
    // FS-B2a — TWO MODES, mirroring MoshOps exactly: no transactionId ⇒ the legacy
    // id-less batch (unchanged, still what runAgentBatch uses); with one ⇒ the identified,
    // manifest-validated transaction.
    case "batch_begin": {
      const txnId = str(args.transactionId);
      if (!txnId) {
        if (inBatch) return err(command, "a batch is already open");
        pushUndo(); inBatch = true; return ok(command);
      }

      const name = str(args.name);
      const manifest = Array.isArray(args.commands) ? (args.commands as Record<string, unknown>[]) : null;
      if (!manifest || manifest.length === 0)
        return err(command, "manifest_rejected: 'commands' manifest is empty");
      for (const [i, entry] of manifest.entries()) {
        if (!entry || typeof entry !== "object")
          return err(command, `manifest_rejected: manifest entry ${i} is not an object`);
        if (!str(entry.requestId)) return err(command, `manifest_rejected: manifest entry ${i} has no 'requestId'`);
        if (!str(entry.command)) return err(command, `manifest_rejected: manifest entry ${i} has no 'command'`);
        if (num(entry.index, -1) !== i)
          return err(command, `manifest_rejected: manifest entry ${i} declares index ${num(entry.index, -1)}`);
      }
      const digest = mockManifestDigest(name, manifest);

      if (mockTxn && mockTxn.id === txnId) {
        if (mockTxn.manifestDigest !== digest)
          return err(command, `transaction_identity_conflict: transaction ${txnId} already exists with a different manifest`);
        return ok(command, { ...mockTxnStatusData(mockTxn), replayed: true });
      }
      if (mockTxn && (mockTxn.status === "open" || mockTxn.status === "failed"))
        return err(command, `transaction_already_open: transaction ${mockTxn.id} is still ${mockTxn.status}`);
      if (inBatch) return err(command, "a batch is already open");

      // Manifest preflight BEFORE anything mutates.
      for (const [i, entry] of manifest.entries()) {
        const cmdName = str(entry.command);
        if (!MOCK_TXN_SAFE.has(cmdName))
          return err(command, `manifest_rejected: step ${i} — ${cmdName} is not in the engine's transactionSafe registry`);
      }

      pushUndo();
      inBatch = true;
      mockTxn = {
        id: txnId,
        name,
        status: "open",
        manifestDigest: digest,
        preFingerprint: mockFingerprint(snapshot),
        preState: clone(snapshot),
        revisionAtBegin: mockRevision,
        nextIndex: 0,
        entries: manifest.map((entry) => ({
          requestId: str(entry.requestId),
          command: str(entry.command),
          state: "pending" as const,
          envelopeDigest: "",
        })),
      };
      return ok(command, mockTxnStatusData(mockTxn));
    }
    case "batch_end": {
      const txnId = str(args.transactionId);
      if (!txnId) {
        if (!inBatch) return err(command, "no batch is open");
        inBatch = false; invalidate(); return ok(command);
      }
      if (!mockTxn || mockTxn.id !== txnId)
        return err(command, `unknown_transaction: no transaction ${txnId}`);
      if (mockTxn.status === "committed")
        return ok(command, { ...mockTxnStatusData(mockTxn), replayed: true });
      if (mockTxn.status !== "open" && mockTxn.status !== "failed")
        return err(command, `unknown_transaction: transaction ${txnId} is ${mockTxn.status} and cannot be committed`);
      if (mockTxn.entries.some((e) => e.state === "failed") || mockTxn.nextIndex < mockTxn.entries.length) {
        mockTxn.status = "failed";
        mockTxn.failureCode = "transaction_incomplete";
        const applied = mockTxn.entries.filter((e) => e.state === "applied").length;
        return err(command, `transaction_incomplete: ${applied} of ${mockTxn.entries.length} manifested commands applied`);
      }
      inBatch = false;
      mockTxn.status = "committed";
      mockTxn.failureCode = undefined;
      invalidate();
      return ok(command, mockTxnStatusData(mockTxn));
    }
    case "batch_status": {
      const txnId = str(args.transactionId);
      if (!txnId) return err(command, "missing 'transactionId'");
      if (!mockTxn || mockTxn.id !== txnId)
        return ok(command, { found: false, transactionId: txnId, revision: mockRevision });
      return ok(command, mockTxnStatusData(mockTxn));
    }
    case "batch_rollback": {
      const txnId = str(args.transactionId);
      if (!txnId) return err(command, "missing 'transactionId'");
      if (!mockTxn || mockTxn.id !== txnId)
        return err(command, `unknown_transaction: no transaction ${txnId} — performing no undo`);
      if (mockTxn.status === "rolled_back")
        return ok(command, { ...mockTxnStatusData(mockTxn), replayed: true });
      if (mockTxn.status === "committed")
        return err(command, `needs_recovery: transaction ${txnId} is already committed; performing no undo`);
      if (mockTxn.status === "needs_recovery")
        return err(command, `needs_recovery: transaction ${txnId} needs human recovery; performing no undo`);

      // The mock's exact rollback: restore the captured pre-state clone. (The engine gets
      // there via undo-head ownership + fingerprint; the observable contract is the same.)
      snapshot = clone(mockTxn.preState);
      inBatch = false;
      mockRevision += 1;
      stopPlayback();
      invalidate();
      if (mockFingerprint(snapshot) !== mockTxn.preFingerprint) {
        mockTxn.status = "needs_recovery";
        mockTxn.failureCode = "fingerprint_mismatch";
        return err(command, "fingerprint_mismatch: the undo did not restore the pre-transaction state");
      }
      mockTxn.status = "rolled_back";
      mockTxn.failureCode = undefined;
      return ok(command, mockTxnStatusData(mockTxn));
    }
    case "save": {
      const file = snapshot.session.editFile;
      if (!file) return err(command, "no project file");
      rememberProject(file);
      syncRecents();
      mockProjects.set(file, clone(snapshot));
      return ok(command, { file });
    }
    case "reload": {
      const file = snapshot.session.editFile;
      const saved = mockProjects.get(file);
      if (!saved) return err(command, "project has not been saved");
      snapshot = clone(saved);
      history.length = 0;
      future.length = 0;
      stopPlayback();
      return ok(command, { file });
    }

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
    // Live note audition. The dev mock has no engine, so it answers with the same
    // graceful "nothing sounded, and here is why" shape the native command returns
    // headless — callers must handle that path anyway, and pretending otherwise would
    // let a UI bug that ignores `audible` pass every browser test.
    case "audition_note": {
      if (args.pitch == null) return err(command, "missing 'pitch'");
      const action = str(args.action) || "blip";
      if (!["on", "off", "blip"].includes(action)) return err(command, "action must be 'on', 'off' or 'blip'");
      if (!findTrack(str(args.trackId))) return err(command, "no track");
      return ok(command, {
        trackId: str(args.trackId), pitch: num(args.pitch, 60), action,
        // REC-002 — `recordable` is true only on the "input" path. The mock has no engine
        // to arm to, so it answers false, exactly as a headless backend does.
        audible: false, path: "none", held: 0, recordable: false, reason: "no audio device",
      });
    }
    case "all_notes_off":
      return ok(command, { released: 0, held: 0 });

    // ── plugins ────────────────────────────────────────────────
    case "list_plugins": return ok(command, { plugins: mockPluginCatalog, counts: { vst3: VST3S.length, au: mockPluginCatalog.length - VST3S.length, total: mockPluginCatalog.length } });
    case "list_builtins": return ok(command, { plugins: BUILTINS });
    case "get_plugin_blocklist":
      return ok(command, { blocklist: mockPluginBlocklist.map((entry) => ({ ...entry })) });
    case "unblock_plugin": {
      const pluginId = str(args.pluginId);
      if (!pluginId) return err(command, "missing pluginId");
      const index = mockPluginBlocklist.findIndex((entry) => entry.rawId === pluginId || entry.id === pluginId);
      if (index < 0) return err(command, "plugin is not quarantined");
      mockPluginBlocklist.splice(index, 1);
      invalidate();
      return ok(command);
    }
    // FIT-003 — an explicit case (was a bare DEFAULT_OK passthrough returning no
    // `status`, which store.rescanPlugins() then read as `undefined !== "scanning"`
    // and treated as already-done — harmless for the real always-instant dev catalog,
    // but it meant vitest/e2e never exercised the real "scanning" branch of the store
    // action). Real: no dev-mock AU sweep, so this always completes synchronously.
    // AUD-SCAN — mirror the native `allowAU` gate: an explicit format:"au" without the
    // opt-in is an ERROR, not a silent VST3-only success. (The old native code answered
    // "done" there, which is precisely how "Mosh can't see my AUs" stayed invisible.)
    // The dev catalog holds no AUs, so an ALLOWED sweep still just reports the VST3s.
    case "rescan_plugins": {
      const fmt = str(args.format, "all");
      if (fmt === "au" && !args.allowAU) return err(command, "Audio Unit scanning is off — pass allowAU:true (or set MOSH_SCAN_AU=1)");
      // The deep sweep (allowAU) is async like the native OOP scan: a progress sample,
      // then done with the grown catalog (see DEEP_SCAN_EXTRA above). The store keeps
      // scanProgress alive on status:"scanning" and the done event refreshes the list.
      if (args.allowAU) {
        emit("plugin_scan_progress", { format: fmt, done: false, count: mockPluginCatalog.length, elapsedMs: 0 });
        scheduleMock(() => {
          if (!mockDeepScanned) { mockPluginCatalog.push(...DEEP_SCAN_EXTRA); mockDeepScanned = true; }
          emit("plugin_scan_progress", { format: fmt, done: true, count: mockPluginCatalog.length, elapsedMs: 250 });
        // 250ms: long enough for e2e to observe the in-flight status line, short
        // enough to stay instant-feeling in dev.
        }, 250);
        return ok(command, { status: "scanning" });
      }
      return ok(command, { status: "done", count: mockPluginCatalog.length });
    }
    case "set_master_pan": { pushUndo(); if (snapshot.master) snapshot.master.pan = num(args.pan); invalidate(); return ok(command); }
    case "enable_all_meters": case "enable_track_meter": case "disable_track_meter": return ok(command);
    case "list_wave_inputs": return ok(command, { inputs: MOCK_NO_INPUT ? [] : MOCK_WAVE_INPUTS, audioEnabled: true });
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
    case "list_audio_devices": {
      // DEGRADED mirror (AUD-017 follow-up): a set audioDeviceError models the
      // failed-open state — the engine enumerates CoreAudio REGARDLESS of an open
      // device (enumeration is gated on registered types, not hasAudio), so the
      // Settings pickers still offer the switch; audioEnabled goes false and the
      // current selection reads empty. set_audio_device clears it (recovery).
      const dead = Boolean(snapshot.session?.audioDeviceError);
      return ok(command, {
        types: [{ name: "CoreAudio", outputs: ["MacBook Pro Speakers", "External Headphones"], inputs: ["MacBook Pro Microphone", "Scarlett 2i2"] }],
        current: { ...mockAudioSel,
                   outputDevice: dead ? "" : mockAudioSel.outputDevice,
                   inputDevice: dead ? "" : mockAudioSel.inputDevice,
                   sampleRate: SR, bufferSize: snapshot.session.bufferSize ?? 512 },
        sampleRates: [44100, 48000, 96000], bufferSizes: [128, 256, 512, 1024], defaultBufferSize: 512,
        audioEnabled: !dead,
        // CAP-TRN-005 — click destinations, by te::OutputDevice NAME (not the deviceID the
        // track-output pickers use). Sentinel first, then wave outs, then the MIDI sentinel
        // + MIDI outs, exactly as cmdListAudioDevices builds it — so the metronome panel's
        // "reveal the MIDI notes once a MIDI destination is chosen" branch is reachable in
        // dev and e2e.
        clickOutputs: [
          { name: DEFAULT_CLICK_OUTPUT, isMidi: false },
          { name: "MacBook Pro Speakers", isMidi: false },
          { name: "External Headphones", isMidi: false },
          { name: "(default MIDI output)", isMidi: true },
          { name: "IAC Driver Bus 1", isMidi: true },
        ],
      });
    }
    case "set_buffer_size": { if (snapshot.session) snapshot.session.bufferSize = num(args.bufferSize, 512); invalidate(); return ok(command); }
    case "set_audio_threads": { if (snapshot.session) { snapshot.session.audioThreads = num(args.threads, 8); snapshot.session.audioThreadsAuto = false; } invalidate(); return ok(command); }
    case "set_audio_device": {
      // Machine preference (undoable:false on the backend) — reflect into the mock
      // selection so the next list_audio_devices shows the new device.
      if (typeof args.outputDevice === "string") mockAudioSel.outputDevice = args.outputDevice;
      if (typeof args.inputDevice === "string") mockAudioSel.inputDevice = args.inputDevice;
      if (typeof args.type === "string") mockAudioSel.type = args.type;
      // DEGRADED-recovery mirror: a successful pick from the failed-open state IS
      // the recovery engine-side (adoptOpenedAudioDevice) — audio comes back and
      // the banner clears. From the healthy state the pick changes nothing here.
      if (snapshot.session?.audioDeviceError) {
        snapshot.session.audioDeviceError = "";
        snapshot.session.audioEnabled = true;
        invalidate();
      }
      return ok(command);
    }
    case "retry_audio_device": {
      // AUD-017 — the mock has no HAL, so a retry always "succeeds": clear the error so
      // the banner's dismissal path is exercisable in the browser fixture and e2e.
      if (snapshot.session) snapshot.session.audioDeviceError = "";
      invalidate();
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
    case "set_project_settings": return ok(command);
    case "save_as": {
      const file = str(args.file);
      if (!file) return err(command, "save_as needs a file");
      snapshot.session.editFile = file;
      rememberProject(file);
      syncRecents();
      mockProjects.set(file, clone(snapshot));
      invalidate();
      return ok(command, { file });
    }

    // Open an existing project — by path, or by index into the live Recent list. The
    // index form mirrors native `open_recent`, including its out-of-range error, because
    // an index is resolved against a list the UI read one snapshot ago.
    case "open_project": case "open_recent": {
      let target: string;
      if (command === "open_recent") {
        const i = num(args.index, -1);
        if (!Number.isInteger(i) || i < 0 || i >= recentPaths.length) return err(command, `no recent project at index ${i}`);
        target = recentPaths[i];
      } else {
        target = str(args.file);
        if (!target) return err(command, "open_project needs a file");
      }
      mockProjects.set(snapshot.session.editFile, clone(snapshot));   // keep what we're leaving
      rememberProject(snapshot.session.editFile);              // …and keep it reachable
      const restored = mockProjects.get(target);
      snapshot = restored ? clone(restored) : emptySession();
      snapshot.session.editFile = target;
      rememberProject(target);
      syncRecents();
      history.length = 0; future.length = 0;
      stopPlayback();
      return ok(command);
    }

    // New project = a fresh empty edit (createEmptyEdit on the native side). Resets to a
    // blank session and clears undo history — you can't undo across a New, same as a DAW.
    case "new_project": {
      const leaving = snapshot.session.editFile;
      mockProjects.set(leaving, clone(snapshot));
      snapshot = emptySession();
      snapshot.session.editFile = `/mock/untitled-${mockProjects.size}.mosh`;
      // The project you LEFT stays in Recent, so "Start empty" is reversible. This
      // mirrors the native rememberProject(editPath) added to MoshEngine::newProject.
      rememberProject(leaving);
      rememberProject(snapshot.session.editFile);
      syncRecents();
      history.length = 0; future.length = 0;
      stopPlayback();
      return ok(command);
    }
    case "relink_clip": return ok(command);   // gap 3 — re-point a missing wave source (mock no-op)
    // CAP-TRN-005 — a PARTIAL PATCH over the click settings, and NOT undoable: the real
    // cmdSetMetronome takes no Tracktion transaction (every CLICKTRACK CachedValue is
    // bound with a nullptr UndoManager), so the old pushUndo() here made the mock revert
    // on undo where the app does not. Validation mirrors the backend field for field,
    // because a Playwright spec against this mock is the ONLY thing some of these paths
    // get before the real app sees them.
    case "set_metronome": {
      const c = snapshot.session.click;
      if (!c) return err(command, "no click settings");
      const has = (k: string) => Object.prototype.hasOwnProperty.call(args, k);
      const KEYS = ["enabled", "level", "emphasizeBars", "recordingOnly", "outputDevice",
                    "soundBig", "soundSmall", "midiNoteBig", "midiNoteSmall"];
      if (!KEYS.some(has))
        return err(command, `expected at least one of: ${KEYS.join(", ")}`);
      if (has("level")) {
        const lv = num(args.level, -1);
        if (lv < 0 || lv > 1) return err(command, "level must be a linear gain in 0..1 (the engine clamps it to 0.2..1.0)");
      }
      for (const k of ["midiNoteBig", "midiNoteSmall"] as const)
        if (has(k)) {
          const n = num(args[k], -1);
          if (n < 0 || n > 127) return err(command, `${k} must be 0..127`);
        }
      for (const k of ["soundBig", "soundSmall"] as const)
        if (has(k)) {
          const p = String(args[k] ?? "").trim();
          // The mock has no filesystem, so it can only enforce the half of the rule that
          // is about the STRING (the engine's click loader is WAV-only). Existence is the
          // backend's to check — noted so nobody reads a green spec as proof of both.
          if (p !== "" && !/\.wav$/i.test(p))
            return err(command, `${k} must be an existing .wav file (or "" to restore the built-in click): ${p}`);
        }
      if (has("enabled")) { c.enabled = Boolean(args.enabled); snapshot.session.metronome = c.enabled; }
      if (has("emphasizeBars")) c.emphasizeBars = Boolean(args.emphasizeBars);
      if (has("recordingOnly")) c.recordingOnly = Boolean(args.recordingOnly);
      // The engine clamps on write AND on read, so the mock stores the clamped value —
      // otherwise a slider dragged to 0 would read back 0 here and 0.2 in the real app.
      if (has("level")) c.level = Math.min(c.levelMax, Math.max(c.levelMin, num(args.level, c.level)));
      if (has("outputDevice")) {
        const raw = String(args.outputDevice ?? "").trim();
        c.outputDevice = raw === "" || raw === "default" ? c.defaultOutputDevice : raw;
        c.outputDeviceResolved = c.outputDevice;
      }
      if (has("soundBig")) c.soundBig = String(args.soundBig ?? "").trim();
      if (has("soundSmall")) c.soundSmall = String(args.soundSmall ?? "").trim();
      if (has("midiNoteBig")) c.midiNoteBig = num(args.midiNoteBig, c.midiNoteBig);
      if (has("midiNoteSmall")) c.midiNoteSmall = num(args.midiNoteSmall, c.midiNoteSmall);
      invalidate();
      return ok(command, { ...c, metronome: c.enabled });
    }
    case "set_time_signature": {
      pushUndo();
      snapshot.session.timeSigNumerator = Math.max(1, num(args.numerator, snapshot.session.timeSigNumerator));
      snapshot.session.timeSigDenominator = num(args.denominator, snapshot.session.timeSigDenominator);
      invalidate(); return ok(command);
    }
    case "export_audio": {
      // G1: range (78) + delay-tail (81) — echo a faithful envelope so the requested
      // span is reflected in seconds/bytes (a UI test can assert a shorter render).
      const MOCK_EDIT_LEN = 4;   // seconds — the mock's nominal "edit length"
      const rng = str(args.range, args.start !== undefined && args.end !== undefined ? "custom" : "full");
      const rs = rng === "custom" ? num(args.start, 0) : rng === "loop" ? num(snapshot.transport.loopStart, 0) : 0;
      const re = rng === "custom" ? num(args.end, MOCK_EDIT_LEN) : rng === "loop" ? num(snapshot.transport.loopEnd, MOCK_EDIT_LEN) : MOCK_EDIT_LEN;
      const tail = str(args.tail, "cut");
      const endAllowance = tail === "include" ? num(args.tailSeconds, 2) : 0;
      const seconds = Math.max(0, re - rs);
      return ok(command, {
        file: str(args.file) || "/mock/mixdown." + str(args.format, "wav"), format: str(args.format, "wav"),
        bitDepth: num(args.bitDepth, 24), sampleRate: num(args.sampleRate, SR),
        bytes: Math.round(794000 * (seconds / MOCK_EDIT_LEN)), seconds, renderMode: "offline",
        range: rng, rangeStart: rs, rangeEnd: re, tail, endAllowance,
      });
    }
    case "get_command_log": {
      const limit = Math.max(1, num(args.limit, 50));
      return ok(command, {
        entries: cmdLog.slice(-limit).reverse(),
        total: cmdLog.length,
        currentTxn: mockHistoryTxn(),        // CAP-PRJ-005
        restorableTxns: mockRestorableTxns(),
      });
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
      const v = mockPluginCatalog.find((x) => x.id === str(args.pluginId)); if (!v) return err(command, "unknown plugin");
      // Mirrors the native wave-3 guard (MoshOps::cmdLoadPlugin): an instrument on a
      // track holding WAVE clips is silent-by-construction and refused with the way
      // out named. Empty/MIDI-only tracks stay loadable (that's how one starts).
      if (v.isInstrument && (t.type ?? "audio") === "audio"
          && t.clips.some((c) => c.type === "wave"))
        return err(command, `${v.name} is an instrument — instruments go on instrument tracks (⇧⌘T), not audio tracks`);
      pushUndo(); t.plugins = t.plugins ?? [];
      // Hot-swap (mirrors cmdLoadPlugin): replaceInstrument + an incoming instrument
      // + one already in the chain ⇒ the new one takes its slot. Effects never swap.
      if (Boolean(args.replaceInstrument) && v.isInstrument) {
        const idx = t.plugins.findIndex((p) => p.isInstrument);
        if (idx >= 0) {
          const removed = t.plugins[idx];
          t.plugins.splice(idx, 1, { index: idx, name: v.name, type: v.format, enabled: true, external: true, isInstrument: true, params: mkParams(6) });
          reindex(t);
          invalidate();
          return ok(command, { index: idx, name: v.name, replaced: true, replacedName: removed.name });
        }
      }
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
      // G10 — mirrors the native cmdSetPluginParam: when the owning track is armed
      // "write", capture a point at the current transport position in the SAME mutation
      // (touch/latch are accepted by set_track_automation_mode but inert here too, v0).
      if (p && f.track.automationMode === "write") {
        p.points = p.points ?? [];
        p.points.push({ t: Math.max(0, num(snapshot.transport.position)), v: Math.min(1, Math.max(0, num(args.value))) });
        p.automated = p.points.length > 0;
      }
      invalidate(); return ok(command);
    }
    case "open_plugin_editor": return ok(command);

    // Master-bus plugins — mirrors load_builtin/load_plugin/bypass_plugin/remove_plugin/
    // reorder_plugin/set_plugin_param/open_plugin_editor above one level up, on
    // snapshot.master.plugins (no owning track).
    case "load_master_builtin": {
      const b = BUILTINS.find((x) => x.type === str(args.type)); if (!b) return err(command, "unknown builtin");
      pushUndo(); const list = masterPlugins();
      list.push({ index: list.length, name: b.name, type: b.type, enabled: true, external: false, builtin: true, category: b.category, isInstrument: b.isInstrument, params: mkBuiltinParams(b.type, b.isInstrument), moshFx: mkMoshFx(b.type) });
      invalidate(); return ok(command, { index: list.length - 1 });
    }
    case "load_master_plugin": {
      const v = VST3S.find((x) => x.id === str(args.pluginId)); if (!v) return err(command, "unknown plugin");
      pushUndo(); const list = masterPlugins();
      list.push({ index: list.length, name: v.name, type: v.format, enabled: true, external: true, isInstrument: v.isInstrument, params: mkParams(6) });
      invalidate(); return ok(command, { index: list.length - 1 });
    }
    case "bypass_master_plugin": {
      const f = findMasterPlugin(num(args.index)); if (!f) return err(command, "plugin not found");
      pushUndo(); masterPlugins()[f.idx].enabled = !Boolean(args.bypassed); invalidate(); return ok(command);
    }
    case "remove_master_plugin": {
      const f = findMasterPlugin(num(args.index)); if (!f) return err(command, "plugin not found");
      pushUndo(); masterPlugins().splice(f.idx, 1); reindexMaster(); invalidate(); return ok(command);
    }
    case "reorder_master_plugin": {
      const f = findMasterPlugin(num(args.index)); if (!f) return err(command, "plugin not found");
      const list = masterPlugins();
      const to = num(args.toIndex); if (to < 0 || to >= list.length) return ok(command);
      pushUndo(); const [p] = list.splice(f.idx, 1); list.splice(to, 0, p); reindexMaster(); invalidate(); return ok(command);
    }
    case "set_master_plugin_param": {
      const f = findMasterPlugin(num(args.index)); if (!f) return err(command, "plugin not found");
      const p = masterPlugins()[f.idx].params?.find((x) => x.index === num(args.paramIndex)); if (p) p.value = num(args.value);
      invalidate(); return ok(command);
    }
    case "open_master_plugin_editor": return ok(command);

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
      const p = findAutomatableParam(str(args.trackId), num(args.pluginIndex), num(args.paramIndex));
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

    // G10 — automation record-arm mode. All 4 values are stored+round-trip; only "write"
    // is behavioral (see the set_plugin_param case above) — touch/latch are Phase 2.
    case "set_track_automation_mode": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      const mode = str(args.mode) as Track["automationMode"];
      if (mode !== "read" && mode !== "touch" && mode !== "latch" && mode !== "write")
        return err(command, `mode must be one of read|touch|latch|write (got "${str(args.mode)}")`);
      pushUndo();
      t.automationMode = mode;
      invalidate(); return ok(command);
    }

    // G10 — bulk-author a curve in one step. `points` is a native array (UI/tests) OR a
    // JSON-encoded string (the agent-catalog form, since ArgType has no array type — same
    // duality add_drum_pattern's `pattern` arg already uses). Validated before mutating.
    case "write_automation_curve": {
      const p = findAutomatableParam(str(args.trackId), num(args.pluginIndex), num(args.paramIndex));
      if (!p) return err(command, "param not found");
      const applyMode = str(args.apply, "replace");
      if (applyMode !== "replace" && applyMode !== "merge") return err(command, 'apply must be "replace" or "merge"');

      let raw: unknown = args.points;
      if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return err(command, "points string is not valid JSON"); } }
      if (!Array.isArray(raw) || raw.length === 0) return err(command, "points must be a non-empty array");

      const parsed: { t: number; v: number }[] = [];
      let lastT = 0;
      for (let i = 0; i < raw.length; i++) {
        const pt: unknown = raw[i];
        const rec = (typeof pt === "object" && pt !== null) ? (pt as Record<string, unknown>) : null;
        const t = rec && typeof rec.t === "number" ? rec.t : NaN;
        const v = rec && typeof rec.v === "number" ? rec.v : NaN;
        if (rec === null || Number.isNaN(t) || Number.isNaN(v)) return err(command, "each point must be an object {t, v}");
        if (t < 0) return err(command, `point t must be >= 0 (got ${t})`);
        if (i > 0 && !(t > lastT)) return err(command, `points must be strictly ascending in t (got ${t} after ${lastT})`);
        if (v < 0 || v > 1) return err(command, `point v must be 0..1 (got ${v})`);
        parsed.push({ t, v });
        lastT = t;
      }

      let replaceStart = parsed[0].t;
      let replaceEnd = parsed[parsed.length - 1].t;
      if (applyMode === "replace") {
        const hasReplaceStart = Object.prototype.hasOwnProperty.call(args, "replaceStart");
        const hasReplaceEnd = Object.prototype.hasOwnProperty.call(args, "replaceEnd");
        if (hasReplaceStart !== hasReplaceEnd) {
          return err(command, "replaceStart and replaceEnd must be provided together");
        }
        if (hasReplaceStart) {
          if (typeof args.replaceStart !== "number" || typeof args.replaceEnd !== "number"
            || !Number.isFinite(args.replaceStart) || !Number.isFinite(args.replaceEnd)) {
            return err(command, "replaceStart and replaceEnd must be finite numbers");
          }
          replaceStart = args.replaceStart;
          replaceEnd = args.replaceEnd;
          if (replaceStart < 0 || replaceEnd < replaceStart) {
            return err(command, "replacement bounds must satisfy 0 <= replaceStart <= replaceEnd");
          }
          if (replaceStart > parsed[0].t || replaceEnd < parsed[parsed.length - 1].t) {
            return err(command, "replacement bounds must cover every new point");
          }
        }
      }

      pushUndo();
      p.points = p.points ?? [];
      if (applyMode === "replace") {
        p.points = p.points.filter((pt) => pt.t < replaceStart || pt.t > replaceEnd);
      }
      p.points.push(...parsed);
      p.points.sort((a, b) => a.t - b.t);
      p.automated = p.points.length > 0;
      invalidate(); return ok(command, { pointCount: parsed.length, numPoints: p.points.length });
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
      // Section-scoped render: an explicit sub-region bounds the layer to part of the clip
      // (cmdCreateRenderLayer clamps it to the clip and ignores a degenerate range, falling
      // back to the whole clip). The snapshot always carries a region — whole-clip layers
      // report the clip's own span — so the UI can tell the two apart by comparison.
      const cs = f.clip.start, ce = f.clip.start + f.clip.length;
      let rs = cs, re = ce;
      if (args.regionStart !== undefined && args.regionEnd !== undefined) {
        const qs = Math.min(Math.max(num(args.regionStart, cs), cs), ce);
        const qe = Math.min(Math.max(num(args.regionEnd, ce), cs), ce);
        if (Math.abs(qe - qs) > 1e-3) { rs = Math.min(qs, qe); re = Math.max(qs, qe); }
      }
      f.clip.renderLayer = { id: "rl-" + f.clip.id, status: "dirty", adapter: str(args.adapter, "fake"), mode, seed: 1, userKept: false, hasArtifact: false, nl: 0.45, colors: [], loras: [],
        regionStart: rs, regionEnd: re,
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
      // A SUB-REGION render never auto-applies either: in-place apply replaces the clip's WHOLE
      // source, which a section-scoped render cannot do, so MoshOps::applyRenderInPlace returns
      // false for it and the render falls through to the legacy "Neural Renders" lane landing
      // (accept_render / bounce_layer_to_clip). This is the ONLY shape where those two commands
      // do real work rather than relabelling a no-op.
      else if (f.clip.type === "wave" && isSubRegion(f.clip)) { /* ready + hasArtifact only */ }
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
      // Freeze is the reactive opt-out, not just the label — mirrors cmdFreezeLayer.
      if (command === "freeze_layer") f.clip.renderLayer.reactive = false;
      // accept_render (and bounce, which delegates to it) LANDS a clip only where the render
      // did not already auto-apply — a section-scoped render, or sing. On the whole-clip wave
      // and MIDI-beneath paths the native command takes a no-op branch, which is precisely why
      // bounce_layer_to_clip is a pure relabel there and why no UI offers it.
      else if (f.clip.renderLayer.hasArtifact
               && !f.clip.renderLayer.appliedInPlace && !f.clip.renderLayer.reimagineActive
               && !landedLayers.has(f.clip.renderLayer.id)) {
        // Kept OUT of the snapshot on purpose: native tracks the landed clip on an internal
        // `landedClipId` property that snapshot() does not emit, so a mock field would be its
        // own kind of drift — a shape no real backend ever sends.
        landedLayers.add(f.clip.renderLayer.id);
        landOnNeuralLane(f.clip);
      }
      invalidate(); return ok(command);
    }
    case "unfreeze_layer": {
      const f = findClip(str(args.clipId)); if (!f?.clip.renderLayer) return err(command, "no render layer");
      if (f.clip.renderLayer.reactive !== false) return err(command, "layer is not frozen");
      pushUndo();
      f.clip.renderLayer.reactive = true;
      // "dirty", not "ready" — edits made while frozen skipped their re-render, so the artifact
      // may not match its source and nothing here can tell (mirrors cmdUnfreezeLayer).
      f.clip.renderLayer.status = "dirty";
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
      const parsed = parseDrumPattern(args.pattern, num(args.stepsPerBar, 16), num(args.bars, 0), normalizeDrumVelocity(num(args.velocity, 100)));
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
      // Mirrors native cmdSketchBeatbox exactly: the TRACK stays plain "Sketch", but the
      // CLIP carries the source filename (sans extension) so a producer with several
      // sketched takes can tell them apart — `wav.getFileNameWithoutExtension()` there,
      // this here. (Was drifted to a bare "Sketch" clip name pre-fix — every existing
      // test happened not to assert the clip name, so the drift was invisible.)
      const srcName = (file.split("/").pop() ?? file).replace(/\.[^./]+$/, "");
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
          id: nextClipId(), name: "Sketch • " + srcName, type: "midi",
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
      const f = findClip(str(args.clipId));
      if (!f?.clip.notes) return err(command, "not a midi clip");
      // Mirrors the native command: an `edits` array resolves every target FIRST, then
      // mutates. The backend does that because moving a note re-sorts the list and
      // invalidates later indices; the mock keeps the same shape so a group edit is
      // exercised identically in the browser.
      const specs = Array.isArray(args.edits)
        ? (args.edits as Record<string, unknown>[])
        : [args as Record<string, unknown>];
      const targets = specs.map((s) => f.clip.notes![num(s.noteIndex)]);
      if (targets.some((t) => !t)) return err(command, "note not found");
      pushUndo();
      specs.forEach((s, k) => {
        const n = targets[k];
        if ("start" in s) n.start = Math.max(0, num(s.start, n.start));
        if ("pitch" in s) n.pitch = Math.max(0, Math.min(127, num(s.pitch, n.pitch)));
        if ("length" in s) n.length = Math.max(0.05, num(s.length, n.length));
        if ("velocity" in s) n.velocity = Math.max(1, Math.min(127, num(s.velocity, n.velocity)));
        if ("mute" in s) n.mute = Boolean(s.mute);
      });
      invalidate(); return ok(command);
    }
    // Drum-rack pads. The mock keeps its own pad list on the track so the grid, the
    // per-pad mixer and the choke picker all round-trip in the browser.
    case "list_drum_kits":
      return ok(command, {
        kits: [
          { id: "mosh-kit", name: "mosh kit", pads: 8, path: "/kits/mosh-kit", available: true },
          { id: "mosh-808", name: "mosh 808", pads: 8, path: "/kits/mosh-808", available: true },
        ],
        defaultKit: "mosh-kit",
      });
    case "apply_choke": {
      const f = findClip(str(args.clipId));
      if (!f?.clip.notes) return err(command, "not a midi clip");
      const t = findTrack(f.track.id);
      const group = new Map<number, number>();
      for (const p of t?.drumPads ?? []) if (p.chokeGroup) group.set(p.pitch, p.chokeGroup);
      if (group.size === 0) return ok(command, { clipId: str(args.clipId), truncated: 0, groups: 0 });
      pushUndo();
      let truncated = 0;
      for (const n of f.clip.notes) {
        const g = group.get(n.pitch);
        if (g == null) continue;
        const next = f.clip.notes
          .filter((o) => o !== n && group.get(o.pitch) === g && o.start > n.start)
          .reduce((m, o) => Math.min(m, o.start), Infinity);
        if (next === Infinity) continue;
        const capped = next - n.start;
        if (capped > 0 && capped < n.length) { n.length = capped; truncated++; }
      }
      invalidate();
      return ok(command, { clipId: str(args.clipId), truncated, groups: new Set(group.values()).size });
    }
    case "set_drum_pad": {
      const t = findTrack(str(args.trackId));
      const pad = t?.drumPads?.find((p) => p.pitch === num(args.note, -1));
      if (!pad) return err(command, "no pad at note");
      pushUndo();
      if ("gainDb" in args) pad.gainDb = num(args.gainDb, pad.gainDb);
      if ("pan" in args) pad.pan = num(args.pan, pad.pan);
      if ("name" in args) pad.name = str(args.name);
      if ("chokeGroup" in args) {
        const g = num(args.chokeGroup, 0);
        if (g > 0) { pad.chokeGroup = g; pad.openEnded = false; }
        else { delete pad.chokeGroup; pad.openEnded = true; }
      }
      invalidate(); return ok(command, { trackId: str(args.trackId), note: pad.pitch });
    }
    case "clear_drum_pad": {
      const t = findTrack(str(args.trackId));
      const i = t?.drumPads?.findIndex((p) => p.pitch === num(args.note, -1)) ?? -1;
      if (!t?.drumPads || i < 0) return err(command, "no pad at note");
      pushUndo();
      t.drumPads.splice(i, 1);
      invalidate(); return ok(command, { trackId: t.id, note: num(args.note, -1), removed: 1 });
    }
    case "quantize_notes": {
      const f = findClip(str(args.clipId)); if (!f?.clip.notes) return err(command, "not a midi clip");
      // Mirrors cmdQuantizeNotes exactly, clamps included — this mock's whole job is to
      // coerce like JUCE's `var` so a seam bug reproduces here instead of only in the app.
      // `swing` (CAP-MID-004) is 0..100, 0 = straight, and DELAYS every second subdivision
      // of the grid while leaving the on-beats put; 100 is the MPC 75% ceiling (half a
      // subdivision), so an off-beat can never collide with the next on-beat.
      const div = Math.max(0.03125, num(args.division, 1));
      const strength = Math.min(1, Math.max(0, num(args.strength, 1)));
      const swing = Math.min(100, Math.max(0, num(args.swing, 0)));
      const swingOffset = (swing / 100) * (div * 0.5);
      pushUndo();
      let moved = 0, swung = 0;
      for (const n of f.clip.notes) {
        const slot = Math.round(n.start / div);
        const offbeat = slot % 2 !== 0;
        const target = swingOffset > 0 && offbeat ? slot * div + swingOffset : slot * div;
        const next = n.start + (target - n.start) * strength;
        if (Math.abs(next - n.start) > 1e-6) { n.start = Math.max(0, next); moved++; if (swingOffset > 0 && offbeat) swung++; }
      }
      invalidate();
      return ok(command, { moved, swung });
    }
    case "transform_velocities": {
      // Mirrors cmdTransformVelocities — Live 12's velocity tool row. Targets = an
      // explicit noteIndexes array, else ALL notes; the math + deterministic seed
      // live in midi/velocityTransform.ts (the engine's own FNV seed is the same
      // contract — replay reproduces, per environment).
      const f = findClip(str(args.clipId)); if (!f?.clip.notes) return err(command, "not a midi clip");
      const mode = str(args.mode);
      if (mode !== "randomize" && mode !== "ramp" && mode !== "deviate")
        return err(command, "mode must be randomize|ramp|deviate");
      if (mode === "ramp" && (!("lo" in args) || !("hi" in args)))
        return err(command, "ramp needs 'lo' and 'hi'");
      if (mode !== "ramp" && !("amount" in args)) return err(command, "mode needs 'amount'");
      const notes = f.clip.notes;
      let targets: { i: number }[];
      if (Array.isArray(args.noteIndexes)) {
        if (args.noteIndexes.length === 0) return err(command, "'noteIndexes' is empty");
        targets = [];
        for (const v of args.noteIndexes) {
          const i = num(v, -1);
          if (i < 0 || i >= notes.length || notes[i] == null) return err(command, "bad noteIndex");
          targets.push({ i });
        }
      } else {
        targets = notes.map((_, i) => ({ i }));
      }
      if (targets.length === 0) return err(command, "no notes to transform");
      const payload = targets.map(({ i }) => ({ start: notes[i].start, pitch: notes[i].pitch, velocity: notes[i].velocity }));
      const out = transformVelocities(payload, mode, {
        amount: num(args.amount, 0), lo: num(args.lo, 1), hi: num(args.hi, 127), clipId: f.clip.id,
      });
      pushUndo();
      let changed = 0;
      targets.forEach(({ i }, k) => {
        if (notes[i].velocity !== out[k]) { notes[i].velocity = out[k]; changed++; }
      });
      invalidate();
      return ok(command, { mode, changed });
    }
    case "transform_notes": {
      // Mirrors cmdTransformNotes — Live 12's Transform tools row (Reverse / Invert /
      // Legato / Humanize / ×2 / /2 / Set Length / Add Interval / Fit to Scale).
      // Targets = an explicit noteIndexes array, else ALL notes; the math +
      // deterministic humanize seed live in midi/noteTransform.ts (same
      // replay-determinism contract as the engine); fitToScale reads the mock's
      // session.key through the same resolveKey the engine defaults match.
      const f = findClip(str(args.clipId)); if (!f?.clip.notes) return err(command, "not a midi clip");
      const mode = str(args.mode);
      if (!["reverse", "invert", "legato", "humanize", "x2", "d2", "setLength", "addInterval", "fitToScale"].includes(mode))
        return err(command, "mode must be reverse|invert|legato|humanize|x2|d2|setLength|addInterval|fitToScale");
      if (mode === "humanize" && !("amount" in args)) return err(command, "humanize needs 'amount'");
      if (mode === "setLength" && (!("lengthBeats" in args) || num(args.lengthBeats) <= 1e-4))
        return err(command, "setLength needs 'lengthBeats' (beats > 0)");
      if (mode === "addInterval" && !("semitones" in args)) return err(command, "addInterval needs 'semitones'");
      const notes = f.clip.notes;
      let targets: { i: number }[];
      if (Array.isArray(args.noteIndexes)) {
        if (args.noteIndexes.length === 0) return err(command, "'noteIndexes' is empty");
        if (args.noteIndexes.length > notes.length) return err(command, "too many noteIndexes");
        targets = [];
        const seen = new Set<number>();
        for (const v of args.noteIndexes) {
          if (typeof v !== "number" || !Number.isInteger(v)) return err(command, "bad noteIndex");
          const i = v;
          if (i < 0 || i >= notes.length || notes[i] == null) return err(command, "bad noteIndex");
          if (seen.has(i)) continue;
          seen.add(i);
          targets.push({ i });
        }
      } else {
        targets = notes.map((_, i) => ({ i }));
      }
      if (targets.length === 0) return err(command, "no notes to transform");
      const payload = targets.map(({ i }) => ({
        start: notes[i].start, length: notes[i].length, pitch: notes[i].pitch, velocity: notes[i].velocity,
      }));
      const out = transformNotes(payload, mode as NoteTransformMode, {
        amount: num(args.amount, 0), clipId: f.clip.id,
        lengthBeats: num(args.lengthBeats), semitones: num(args.semitones),
        key: snapshot.session.key,
        clipNotes: notes.map((n) => ({ start: n.start, pitch: n.pitch })),
      });
      pushUndo();
      let changed = 0, added = 0;
      if (mode === "addInterval") {
        // `out` is the tones to ADD (the source notes are untouched).
        for (const t of out) {
          notes.push({ i: notes.length, pitch: t.pitch, start: t.start, length: t.length, velocity: t.velocity });
          added++;
        }
        if (added > 0) reindexNotes(f.clip);
      } else {
        targets.forEach(({ i }, k) => {
          const n = notes[i], o = out[k];
          if (n.start !== o.start || n.length !== o.length || n.pitch !== o.pitch || n.velocity !== o.velocity) {
            n.start = o.start; n.length = o.length; n.pitch = o.pitch; n.velocity = o.velocity;
            changed++;
          }
        });
      }
      invalidate();
      return ok(command, { mode, changed, added });
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
      // #42 — deterministic join FAILURE for codes outside the mock's own format, so
      // the inline join-error UI is exercisable without a relay. Divergence note:
      // native fails via relay lookup; the mock fails on format — same result shape.
      if (command === "mp_join_session" && !str(args.code).startsWith("MOCK-ROOM-"))
        return err(command, "no such room: " + str(args.code));
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

/** FS-B2a — the mirror of MoshOps::txnPreDispatch. Returns a result when dispatch must be
 *  skipped entirely (a refusal, or a replayed recorded result), else null. Fail-closed: a
 *  command is admitted only if it is the manifest's next entry or a declared read. */
function mockTxnPreDispatch(
  name: string,
  args: Record<string, unknown>,
  meta: { transactionId?: unknown; requestId?: unknown; index?: unknown } | undefined,
): CommandResult | null {
  if (name === "batch_begin" || name === "batch_end" || name === "batch_rollback" || name === "batch_status")
    return null;

  const open = mockTxn !== null && (mockTxn.status === "open" || mockTxn.status === "failed");

  if (!meta) {
    if (!open) return null;
    if (MOCK_TXN_READS.has(name)) return null;
    return err(name, `transaction_in_progress: agent transaction ${mockTxn!.id} is open; this change was not applied`);
  }

  const metaId = str(meta.transactionId);
  const requestId = str(meta.requestId);
  const metaIndex = num(meta.index, -1);

  if (!mockTxn || mockTxn.id !== metaId)
    return err(name, `unknown_transaction: no transaction ${metaId} — query batch_status`);

  const entryIndex = mockTxn.entries.findIndex((e) => e.requestId === requestId);
  if (entryIndex < 0)
    return err(name, `manifest_mismatch: requestId ${requestId} is not in transaction ${metaId}'s manifest`);
  const entry = mockTxn.entries[entryIndex];
  const digest = sortedJson({ command: name, args: args ?? {} });

  if (entry.state !== "pending") {
    if (entry.envelopeDigest !== digest)
      return err(name, `request_envelope_conflict: requestId ${requestId} was already used with different content`);
    return { ...(entry.result ?? ok(name)), replayed: true } as CommandResult;
  }
  if (!open)
    return err(name, `unknown_transaction: transaction ${metaId} is ${mockTxn.status}; no further commands may run`);
  if (entryIndex !== mockTxn.nextIndex)
    return err(name, `manifest_mismatch: expected manifest step ${mockTxn.nextIndex}, got step ${entryIndex}`);
  if (metaIndex !== entryIndex)
    return err(name, `manifest_mismatch: envelope declares index ${metaIndex} for manifest step ${entryIndex}`);
  if (entry.command !== name)
    return err(name, `manifest_mismatch: manifest step ${entryIndex} is ${entry.command}`);

  return null;   // admitted
}

export function mockExecute<T = unknown>(command: unknown): Promise<T> {
  const c = command as {
    command: string;
    args?: Record<string, unknown>;
    transaction?: { transactionId?: unknown; requestId?: unknown; index?: unknown };
    _moshProjectEpochPrepared?: unknown;
  };

  // FS-B2a guard, before dispatch — so a refusal mutates nothing, exactly as in the engine.
  const early = mockTxnPreDispatch(c.command, c.args ?? {}, c.transaction);
  if (early) return Promise.resolve(early as unknown as T);

  const admittedIndex = c.transaction && mockTxn
    ? mockTxn.entries.findIndex((e) => e.requestId === str(c.transaction!.requestId))
    : -1;

  const res = dispatch(c.command, c.args ?? {});

  // Mirror of txnPostDispatch: record the outcome against its manifest entry.
  if (admittedIndex >= 0 && mockTxn) {
    const entry = mockTxn.entries[admittedIndex];
    entry.state = res.ok ? "applied" : "failed";
    entry.envelopeDigest = sortedJson({ command: c.command, args: c.args ?? {} });
    entry.result = res;
    mockTxn.nextIndex = admittedIndex + 1;
    mockRevision += 1;
    if (!res.ok) {
      mockTxn.status = "failed";
      mockTxn.failureCode = "command_failed";
    }
  }
  if (!READONLY.has(c.command))
    // CAP-PRJ-005 — stamp AFTER the command ran, like MoshOps::logLine: the line records
    // the undo point the session is at once the command has landed. A command that
    // opened no transaction therefore shares the previous line's stamp, which is the
    // divergence between this log and the undo stack made visible rather than guessed at.
    cmdLog.push({ command: c.command, ok: res.ok, undoable: !NON_UNDOABLE.has(c.command), ts: Date.now(), txn: mockHistoryTxn() });
  // DAW-parity P5 replay lane: a dev-only FULL trace (args + result ids) on window, so an
  // e2e run can dump the commands its UI gestures emitted and the native lane can replay
  // them through `Mosh --run-script` (scripts/daw-conformance/replay_e2e_log.py rebinds
  // mock ids → engine ids via the resultIds captured here). NOT part of the command
  // contract — get_command_log stays args-free, mirroring native.
  if (typeof window !== "undefined" && !READONLY.has(c.command)) {
    const w = window as unknown as { __moshCmdTrace?: unknown[] };
    if (!w.__moshCmdTrace) w.__moshCmdTrace = [];
    const data = (res as { data?: Record<string, unknown> }).data ?? {};
    const resultIds: Record<string, unknown> = {};
    for (const k of ["trackId", "clipId", "newClipId", "index", "busNumber", "groupId"])
      if (data[k] !== undefined) resultIds[k] = data[k];
    w.__moshCmdTrace.push({ command: c.command, args: c.args ?? {}, ok: res.ok, resultIds });
  }
  if (res.ok && PROJECT_REPLACEMENTS.has(c.command)) {
    emit("snapshot_invalidated", {
      projectReplaced: true,
      reason: c.command,
      epochManagedByUi: c._moshProjectEpochPrepared === true,
    });
    emitMuteAutomation();
  }
  return Promise.resolve(res as unknown as T);
}
export function mockSnapshot<T = unknown>(): Promise<T> {
  // CAP-AUT-006 — mirror the native self-heal (ensureTrackMuteGate runs from
  // ensureTrackMeter, so every track that has a meter has a mute gate): fill the mixer
  // strip in for every track, whichever of the mock's many track factories made it.
  for (const t of snapshot.tracks) reconcileSendAutomationPlugins(t);
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
  clipGroupSeq = 0;
  trackGroupSeq = 0;
  snapshot = seedSnapshot();
  mockProjects.clear();
  recentPaths = ["/mock/session.mosh", "/mock/late-night.mosh", "/mock/demo-2.mosh"];
  syncRecents();
  landedLayers.clear();
  mockCorpusLines = 0;
  mockPluginBlocklist = [];
  mockAgentMemoryGlobal = { preference: [], drum_pattern: [], lyric_framework: [] };
  mockAgentMemoryProject = [];
  mockAgentMemoryTs = 0;
  history.length = 0;
  future.length = 0;
  mockTxnIds = [];            // CAP-PRJ-005 — the mirror follows the stacks it mirrors
  mockNextTxnId = 1;
  inBatch = false;
  mockTxn = null;          // FS-B2a — a leaked transaction would refuse the next test's mutations
  mockRevision = 0;
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
