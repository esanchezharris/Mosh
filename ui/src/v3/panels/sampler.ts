// The Sampler panel's pure model (instrument-panels contract §1e/§1f): which sounds show and
// in what order, which view the panel takes, the level/pan mappings, a hit's level, what a
// dropped sample would replace, the key strip and waveform geometry, and the one-line summary.
// No React, no store: SamplerPanel.tsx draws it and sampler.test.ts pins it.
//
// Engine facts this follows (src/moshops/MoshOps.Plugins.cpp, tracktion_SamplerPlugin.cpp):
// - A sound plays every note in minNote..maxNote; a note-on plays EVERY sound covering it
//   (layering). A "drum" sound covers one note (min == max), a "melodic" one 0..127.
// - Pad commands address a sound by a NOTE: the narrowest sound covering it wins. Each sound's
//   `addressNote` is the note that reaches it (absent when a narrower sound shadows its range).
// - assign_sample REPLACES every sound covering the note (a melodic one spanning it too) and
//   resets level, pan and choke. load_drum_kit replaces all sounds.
// - Gains are clamped to ±48 dB. A voice's level is gainDb − 20·(1 − velocity) dB.
// - Mute and solo are keyed by a sound's ROOT note (set_drum_lane); a silenced sound's live
//   gain is parked at −48 dB and `userGainDb` keeps the producer's level. Lanes park only the
//   track's FIRST sampler, and a lane both muted and soloed plays: what is quiet is read from
//   `silenced`, never from the lane lists. clear_drum_pad leaves the lane at its note.
import { noteName } from "../../musicalKey";
import type { Plugin, SamplerInfo, SamplerSound, Track } from "../../types";
import { SAMPLE_DND_MIME } from "../../ui/sampleBrowserUtil";
import { firstThatFits, SUMMARY_CHARS } from "./chorus";
import { clamp } from "./params";

/** The engine's gain clamp, when the snapshot sends no limits. */
export const DEFAULT_LIMITS: SamplerInfo["limits"] = { maxVoices: 32, maxSounds: 64, minGainDb: -48, maxGainDb: 48 };
/** Level edits move in half-decibel steps. */
export const GAIN_STEP_DB = 0.5;
/** Choke groups the engine accepts (0 = none). */
export const CHOKE_MAX = 16;
/** The cells the grid shows at least (the bundled kit's eight pads, two rows of four). */
export const GRID_MIN_CELLS = 8;
/** The note a fresh sampler's first pad goes on (the kit's kick) and a melodic sound's
 *  default root (assign_sample's own default note). */
export const FIRST_PAD_NOTE = 36;
export const DEFAULT_ROOT = 60;

export type SamplerView = "empty" | "drum" | "melodic";

/** The sampler's sounds, or null when the engine sends no sampler block (an older engine). */
export const soundsOf = (plugin: Plugin): SamplerSound[] | null => plugin.sampler?.sounds ?? null;

export const limitsOf = (plugin: Plugin): SamplerInfo["limits"] => plugin.sampler?.limits ?? DEFAULT_LIMITS;

/** A sound's identity across snapshots: its range and root (indices shift when a sound is
 *  removed; the notes it plays do not). */
export const soundKey = (s: Pick<SamplerSound, "minNote" | "maxNote" | "pitch">): string => `${s.minNote}-${s.maxNote}-${s.pitch}`;

/** Sounds in playing order: by root note, then range, then sound index. */
export function sortSounds(sounds: readonly SamplerSound[]): SamplerSound[] {
  return [...sounds].sort((a, b) => a.pitch - b.pitch || a.minNote - b.minNote || a.maxNote - b.maxNote || a.index - b.index);
}

/** What the panel shows: nothing loaded; a pad grid (any one-shot pad present); or the
 *  melodic view (only sounds played across a range of keys). */
export function viewOf(sounds: readonly SamplerSound[]): SamplerView {
  if (sounds.length === 0) return "empty";
  return sounds.some((s) => s.mode === "drum") ? "drum" : "melodic";
}

/** Every sound a note-on at `note` plays (layering), which is also every sound assign_sample
 *  at `note` replaces. */
export const soundsCovering = (sounds: readonly SamplerSound[], note: number): SamplerSound[] =>
  sounds.filter((s) => s.minNote <= note && note <= s.maxNote);

// ── level and pan ──────────────────────────────────────────────────────────────────────

/** A level (dB) as a 0-1 dial position on the engine's ±48 dB range. */
export function gainNorm(db: number, limits = DEFAULT_LIMITS): number {
  const span = limits.maxGainDb - limits.minGainDb;
  return span > 0 ? clamp((db - limits.minGainDb) / span, 0, 1) : 0;
}

/** A dial position back to a level, on the half-decibel grid, inside the engine's clamp. */
export function gainFromNorm(norm: number, limits = DEFAULT_LIMITS): number {
  const db = limits.minGainDb + clamp(norm, 0, 1) * (limits.maxGainDb - limits.minGainDb);
  const snapped = Math.round(db / GAIN_STEP_DB) * GAIN_STEP_DB;
  return clamp(Object.is(snapped, -0) ? 0 : snapped, limits.minGainDb, limits.maxGainDb);
}

/** Pan −1..1 as a dial position (centre 0.5). */
export const panNorm = (pan: number): number => clamp((pan + 1) / 2, 0, 1);

/** A dial position back to a pan, in whole percent. */
export function panFromNorm(norm: number): number {
  const p = Math.round((clamp(norm, 0, 1) * 2 - 1) * 100) / 100;
  return Object.is(p, -0) ? 0 : p;
}

/** "C", "L 25", "R 100". */
export function fmtPan(pan: number): string {
  const pct = Math.round(clamp(pan, -1, 1) * 100);
  return pct === 0 ? "C" : `${pct < 0 ? "L" : "R"} ${Math.abs(pct)}`;
}

/** The Level control's key steps (dB): arrows 1 dB, Shift+arrows 0.5 dB, PageUp/PageDown
 *  6 dB. Null for any other key (Home/End are the dial's own ends). */
export function levelKeyStep(key: string, shift: boolean): number | null {
  const step = shift ? GAIN_STEP_DB : 1;
  switch (key) {
    case "ArrowUp": case "ArrowRight": return step;
    case "ArrowDown": case "ArrowLeft": return -step;
    case "PageUp": return 6;
    case "PageDown": return -6;
    default: return null;
  }
}

/** The Pan control's key steps (−1..1): arrows 5 %, Shift+arrows 1 %, PageUp/PageDown 25 %. */
export function panKeyStep(key: string, shift: boolean): number | null {
  const step = shift ? 0.01 : 0.05;
  switch (key) {
    case "ArrowUp": case "ArrowRight": return step;
    case "ArrowDown": case "ArrowLeft": return -step;
    case "PageUp": return 0.25;
    case "PageDown": return -0.25;
    default: return null;
  }
}

/** "+3.0 dB", "-48.0 dB", "0.0 dB" (a pad's level). */
export function fmtLevel(db: number): string {
  const r = Math.round(db * 10) / 10;
  const v = Object.is(r, -0) ? 0 : r;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
}

/** "0.36 s", "1.2 s", "12 s": a sound's length. */
export function fmtSeconds(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec) || sec <= 0) return "";
  if (sec < 1) return `${sec.toFixed(2)} s`;
  if (sec < 10) return `${sec.toFixed(1)} s`;
  return `${Math.round(sec)} s`;
}

// ── live hits ──────────────────────────────────────────────────────────────────────────

/** The level a hit plays a sound at: its live gain less the velocity's 20·(1 − vel) dB
 *  (tracktion_SamplerPlugin.cpp: Decibels::decibelsToGain (gainDb) · velocity curve). */
export const hitLevelDb = (gainDb: number, vel: number): number => gainDb - 20 * (1 - clamp(vel, 0, 1));

/** How bright a hit's flash is (0.15..1): from the level it plays at, −48 dB (the mute
 *  floor: received but silent) to 0 dB and above. */
export function flashStrength(levelDb: number): number {
  if (!Number.isFinite(levelDb)) return 0.15;
  return 0.15 + 0.85 * clamp((levelDb + 48) / 48, 0, 1);
}

/** The brightest flash a sound shows for the current hits (notes → velocity): every hit on a
 *  note the sound covers plays it. 0 when none does. */
export function soundFlash(s: Pick<SamplerSound, "minNote" | "maxNote" | "gainDb">, hits: ReadonlyMap<number, { vel: number }>): number {
  let best = 0;
  for (const [note, h] of hits) {
    if (note < s.minNote || note > s.maxNote) continue;
    best = Math.max(best, flashStrength(hitLevelDb(s.gainDb, h.vel)));
  }
  return best;
}

// ── lanes (mute / solo) ────────────────────────────────────────────────────────────────

export type LaneState = {
  muted: boolean;
  solo: boolean;
  /** Silent because another lane is soloed (not muted itself). */
  soloedOut: boolean;
};

type Lanes = Pick<Track, "drumMutedPitches" | "drumSoloPitches">;

/** No lane: a sampler the lanes do not reach (only the track's first sampler is parked). */
export const NO_LANE: LaneState = { muted: false, solo: false, soloedOut: false };

/** The lane at a note (a sound's ROOT note), from the track's lane lists: what lights M/S. */
export function laneOf(s: Pick<SamplerSound, "pitch">, track: Lanes | undefined): LaneState {
  const muted = !!track?.drumMutedPitches?.includes(s.pitch);
  const solos = track?.drumSoloPitches ?? [];
  const solo = solos.includes(s.pitch);
  return { muted, solo, soloedOut: !muted && !solo && solos.length > 0 };
}

/** A sound's silence in words. Whether it is silent is the engine's own flag (`silenced`:
 *  its gain is parked), never the lane lists: a second sampler is not parked by the lanes,
 *  and a lane both muted and soloed plays (solo wins). The lane only says why. */
export function laneWords(s: Pick<SamplerSound, "silenced">, lane: LaneState): "" | "muted" | "silent (solo)" | "silent" | "solo" {
  if (s.silenced) return lane.soloedOut ? "silent (solo)" : lane.muted ? "muted" : "silent";
  return lane.solo ? "solo" : "";
}

/** Lane notes no sound is rooted on: a pad soloed or muted and then cleared, or a lane set
 *  in the step sequencer. A solo there silences every sound on the sampler while no cell
 *  shows a lit S, so the panel names it. */
export function orphanLanes(sounds: readonly Pick<SamplerSound, "pitch">[], track: Lanes | undefined): { solo: number[]; mute: number[] } {
  const rooted = new Set(sounds.map((s) => s.pitch));
  const free = (notes: readonly number[] | undefined) => [...new Set(notes ?? [])].filter((n) => !rooted.has(n)).sort((a, b) => a - b);
  return { solo: free(track?.drumSoloPitches), mute: free(track?.drumMutedPitches) };
}

/** "D2", "D2, E2", "3 notes". */
export const notesText = (notes: readonly number[]): string =>
  notes.length <= 2 ? notes.map(noteName).join(", ") : `${notes.length} notes`;

// ── the grid ───────────────────────────────────────────────────────────────────────────

/** The bundled kit's notes in its own order, then the rest of the General MIDI kit. */
const SLOT_ORDER: readonly number[] = [36, 38, 39, 42, 46, 45, 47, 49, 37, 40, 41, 43, 44, 48, 50, 51];

/** The notes the grid's empty cells offer, in order: the kit's notes first, then the rest of
 *  the GM kit, then upward. A note a one-shot (or range) sound already plays is taken; a note
 *  only a melodic sound covers is offered (dropping there replaces it, and says so). */
export function freeSlotNotes(sounds: readonly SamplerSound[], count: number): number[] {
  if (count <= 0) return [];
  const taken = (n: number) => sounds.some((s) => s.mode !== "melodic" && s.minNote <= n && n <= s.maxNote);
  const out: number[] = [];
  const order = [...SLOT_ORDER, ...Array.from({ length: 76 }, (_, i) => 52 + i), ...Array.from({ length: 36 }, (_, i) => 35 - i)];
  for (const n of order) {
    if (out.length >= count) break;
    if (!taken(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/** How many empty cells follow the sounds: up to the grid's eight (a cleared kit pad leaves a
 *  cell to drop its replacement on); a fuller sampler adds none (drop on a sound to swap it). */
export const emptyCellCount = (cells: number): number => Math.max(0, GRID_MIN_CELLS - cells);

/** Which edges of the scrolling grid hide cells (each fades): "", "above", "below", "both". */
export type GridEdge = "" | "above" | "below" | "both";

export function gridEdge(scrollTop: number, scrollHeight: number, clientHeight: number): GridEdge {
  const above = scrollTop > 1;
  const below = scrollTop + clientHeight < scrollHeight - 1;
  return above && below ? "both" : above ? "above" : below ? "below" : "";
}

/** The scroll position that shows a cell (top, height) in a view (scrollTop, viewHeight),
 *  moving as little as it can: unchanged when the cell is already in full view. */
export function scrollToShow(scrollTop: number, viewHeight: number, top: number, height: number): number {
  if (top < scrollTop) return top;
  if (top + height > scrollTop + viewHeight) return Math.max(0, top + height - viewHeight);
  return scrollTop;
}

/** A sound's range in words: "C2" for a pad, "all keys" for 0..127, "C1–B1" for a range. */
export function rangeText(s: Pick<SamplerSound, "minNote" | "maxNote">): string {
  if (s.minNote === s.maxNote) return noteName(s.minNote);
  if (s.minNote === 0 && s.maxNote === 127) return "all keys";
  return `${noteName(s.minNote)}–${noteName(s.maxNote)}`;
}

// ── dropping a sample ──────────────────────────────────────────────────────────────────

/** Where a drop came from: a row of Mosh's sample browser (it carries the real path), or a
 *  file from Finder (a path only where the web view exposes one: Mosh's WebKit view does
 *  not). The drop target, not the selection, decides the note (as DrumPads). */
export type DropSource = { path: string } | { path: null; reason: "no-path" | "not-a-file" };

type DropData = { getData?: (mime: string) => string; files?: ArrayLike<File & { path?: string }> | null } | null | undefined;

export function droppedSample(dt: DropData): DropSource {
  const fromBrowser = dt?.getData?.(SAMPLE_DND_MIME);
  if (fromBrowser) return { path: fromBrowser };
  const f = dt?.files && dt.files.length > 0 ? dt.files[0] : undefined;
  if (!f) return { path: null, reason: "not-a-file" };
  return typeof f.path === "string" && f.path.startsWith("/") ? { path: f.path } : { path: null, reason: "no-path" };
}

/** Whether a drag can be dropped on a sampler cell: a sample-browser row or files. */
export function dragCarriesSample(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  const list = Array.from(types);
  return list.includes(SAMPLE_DND_MIME) || list.includes("Files");
}

/** "clap.wav" from a path. */
export const fileName = (path: string): string => path.split(/[\\/]/).pop() || path;

/** What assigning a sample at `note` would replace (every sound covering it), for the
 *  confirmation: the dropped-on sound first (`onto`), then the narrowest. Nothing → no
 *  question to ask. */
export function replacedBy(sounds: readonly SamplerSound[], note: number, onto?: SamplerSound): SamplerSound[] {
  const covering = sortSounds(soundsCovering(sounds, note)).sort((a, b) => (a.maxNote - a.minNote) - (b.maxNote - b.minNote));
  return onto && covering.includes(onto) ? [onto, ...covering.filter((s) => s !== onto)] : covering;
}

/** Where a sample goes: assign_sample's note and mode, and the sound it was dropped on
 *  (none for an empty cell). */
export type ReplaceTarget = { note: number; mode: "drum" | "melodic"; onto?: SamplerSound };

/** The new sound takes this one's place: a pad on that note stays a pad, a sound played
 *  across the keys from that root stays one. */
const keepsRole = (s: SamplerSound, t: ReplaceTarget): boolean =>
  s.pitch === t.note && (t.mode === "melodic" ? s.mode === "melodic" : s.mode === "drum");

/** The confirmation's sentence. A swap of the dropped-on sound names it and what starts
 *  over (a pad's choke too). Anything else (a drop on an empty cell under an 808, or a
 *  range sound becoming a pad) says what the new sound will be and what it removes, never
 *  "Replace" a sound whose role it does not take. */
export function replaceText(replaced: readonly SamplerSound[], newName: string, target: ReplaceTarget): { title: string; detail: string } {
  if (replaced.length === 0) return { title: `Load ${newName}?`, detail: "" };
  const into = target.onto && replaced.includes(target.onto) && keepsRole(target.onto, target) ? target.onto : undefined;
  const rest = replaced.filter((s) => s !== into);
  const list = rest.map((s) => `${s.name} (${rangeText(s)})`).join(", ");
  if (into) {
    const reset = into.mode === "drum" ? "Level, pan and choke start over." : "Level and pan start over.";
    return { title: `Replace ${into.name} with ${newName}?`, detail: rest.length === 0 ? reset : `${reset} Also removes ${list}.` };
  }
  const where = noteName(target.note);
  const title = target.mode === "melodic" ? `Play ${newName} across the keys from ${where}?` : `Put ${newName} on ${where} as a pad?`;
  return { title, detail: `This removes ${list}: a new sample replaces every sound that plays ${where}.` };
}

// ── drawing ────────────────────────────────────────────────────────────────────────────

const BLACK_PC = new Set([1, 3, 6, 8, 10]);
export const isBlackKey = (note: number): boolean => BLACK_PC.has(((note % 12) + 12) % 12);

export type KeyRect = { note: number; black: boolean; x: number; w: number };

/** A piano strip for notes lo..hi across `width` px: white keys share the width evenly, a
 *  black key (0.6 of a white) straddles the line between its two whites. */
export function pianoKeys(lo: number, hi: number, width: number): KeyRect[] {
  const whites = Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i).filter((n) => !isBlackKey(n)).length;
  if (whites === 0) return [];
  const ww = width / whites, bw = ww * 0.6;
  const out: KeyRect[] = [];
  let wi = 0;
  for (let n = lo; n <= hi; n++) {
    if (isBlackKey(n)) out.push({ note: n, black: true, x: Math.max(0, wi * ww - bw / 2), w: bw });
    else { out.push({ note: n, black: false, x: wi * ww, w: ww }); wi++; }
  }
  return out;
}

/** The centre (px) of a note's key on a strip from pianoKeys. */
export function keyCentre(keys: readonly KeyRect[], note: number): number | null {
  const k = keys.find((x) => x.note === note);
  return k ? k.x + k.w / 2 : null;
}

/** A waveform from file_peaks ([min, max] per bucket, −1..1) as one closed SVG area across
 *  w × h: the maxima left to right, then the minima back. Empty for no peaks. */
export function peaksArea(peaks: readonly (readonly [number, number])[], w: number, h: number): string {
  const n = peaks.length;
  if (n === 0 || !(w > 0) || !(h > 0)) return "";
  const mid = h / 2, half = h / 2;
  const x = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => mid - clamp(Number.isFinite(v) ? v : 0, -1, 1) * half;
  const f = (v: number) => Number(v.toFixed(2));
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const [lo, hi] = peaks[i]!;
    pts.push(`${f(x(i))} ${f(y(Math.max(lo, hi)))}`);
  }
  for (let i = n - 1; i >= 0; i--) {
    const [lo, hi] = peaks[i]!;
    pts.push(`${f(x(i))} ${f(y(Math.min(lo, hi)))}`);
  }
  return `M${pts.join(" L")} Z`;
}

/** Where the minimized row's dots go: one per sound (at most `max`), in rows of up to eight
 *  across a w × h box. */
export function miniDots(count: number, w: number, h: number, max = 24): { cx: number; cy: number }[] {
  const n = Math.min(count, max);
  if (n <= 0) return [];
  const perRow = 8, rows = Math.ceil(n / perRow);
  const out: { cx: number; cy: number }[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / perRow), col = i % perRow;
    const inRow = Math.min(perRow, n - row * perRow);
    out.push({ cx: ((col + 0.5) / Math.max(inRow, 4)) * w, cy: ((row + 0.5) / rows) * h });
  }
  return out;
}

// ── summary ────────────────────────────────────────────────────────────────────────────

/** A name cut to `max` characters with an ellipsis. */
export function clip(name: string, max: number): string {
  if (max <= 0) return "";
  return name.length <= max ? name : `${name.slice(0, Math.max(1, max - 1))}…`;
}

/** The minimized row's line (≤ 16 characters): "8 pads, mosh-kit", "808 · root C2",
 *  "1 of 8 missing", "empty". A sampler whose every sound is silent says so first ("muted ·
 *  808 Boom", "8 pads · silent"): collapsed, it must not read as one that plays. An engine
 *  that sends no sampler block: the plugin's name. */
export function samplerSummary(plugin: Plugin, track?: Lanes): string {
  const sounds = soundsOf(plugin);
  if (!sounds) return plugin.name;
  if (sounds.length === 0) return "empty";
  const missing = sounds.filter((s) => s.missing).length;
  if (missing > 0) return firstThatFits([`${missing} of ${sounds.length} missing`, `${missing} missing`]);
  const sorted = sortSounds(sounds);
  const keys = sorted.filter((s) => s.mode !== "drum");
  if (sorted.every((s) => s.silenced)) {
    const primary = plugin.sampler?.primary !== false;
    const word = sorted.every((s) => laneWords(s, primary ? laneOf(s, track) : NO_LANE) === "muted") ? "muted" : "silent";
    if (sorted.length === 1) {
      const n = sorted[0]!.name;
      return firstThatFits([`${word} · ${n}`, `${word} · ${clip(n, SUMMARY_CHARS - word.length - 3)}`]);
    }
    const what = keys.length === 0 ? `${sorted.length} pads` : `${sorted.length} sounds`;
    return firstThatFits([`${what} · ${word}`, `${what}, ${word}`, `all ${word}`]);
  }
  if (viewOf(sounds) === "melodic") {
    const s = keys[0]!;
    if (keys.length > 1) return firstThatFits([`${keys.length} sounds · keys`, `${keys.length} sounds`]);
    const r = noteName(s.pitch);
    return firstThatFits([`${s.name} · root ${r}`, `${s.name} · ${r}`, `${clip(s.name, SUMMARY_CHARS - r.length - 3)} · ${r}`]);
  }
  const pads = sorted.length - keys.length;
  const padText = `${pads} pad${pads === 1 ? "" : "s"}`;
  if (keys.length > 0) {
    const plus = keys.length === 1 ? keys[0]!.name : `${keys.length} keys`;
    return firstThatFits([`${padText} + ${plus}`, `${padText} + keys`]);
  }
  const kit = plugin.sampler?.kit;
  return kit ? firstThatFits([`${padText} · ${kit}`, `${padText}, ${kit}`, padText]) : padText;
}
