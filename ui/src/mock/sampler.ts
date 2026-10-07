// The dev mock's Sampler: the engine's sound model and pad rules (instrument-panels
// contract §1e/§1f), so the sampler panel can be built and tested against the same shapes
// the engine sends.
//
// The mock keeps every sampler's sounds on its own snapshot entry (`plugin.sampler.sounds`,
// stored fields) and derives the rest the way MoshOps does on every snapshot: each sound's
// index, mode and address note, which sampler is the primary one (the track's first: the
// one pad commands address), its kit, and `track.drumPads` (the primary's sounds in the
// older per-track shape, unchanged).
//
// Engine sources: src/moshops/MoshOps.Plugins.cpp (kDefaultKit, padIndexForNote,
// cmdSetDrumPad/ClearDrumPad/AssignSample/LoadDrumKit, applyDrumLaneGains, ensureSampler)
// and tracktion_SamplerPlugin.cpp (addSound/setSoundGains clamps, 64 sounds, 32 voices).
import type { DrumPad, Plugin, SamplerInfo, SamplerSound, Track } from "../types";

export const SAMPLER_LIMITS: SamplerInfo["limits"] = { maxVoices: 32, maxSounds: 64, minGainDb: -48, maxGainDb: 48 };
/** The quietest gain the sampler stores: a muted (or solo-silenced) pad is parked here. */
export const PAD_MUTE_DB = -48;
export const DEFAULT_KIT = "mosh-kit";

/** The bundled kit's pads, in the engine's kDefaultKit order (sound index order). */
export const KIT_PADS: readonly { file: string; name: string; pitch: number }[] = [
  { file: "kick.wav", name: "Kick", pitch: 36 },
  { file: "snare.wav", name: "Snare", pitch: 38 },
  { file: "clap.wav", name: "Clap", pitch: 39 },
  { file: "hat_closed.wav", name: "Closed Hat", pitch: 42 },
  { file: "hat_open.wav", name: "Open Hat", pitch: 46 },
  { file: "tom_low.wav", name: "Low Tom", pitch: 45 },
  { file: "tom_mid.wav", name: "Mid Tom", pitch: 47 },
  { file: "crash.wav", name: "Crash", pitch: 49 },
];

/** The kits the mock's list_drum_kits reports, by id → folder. */
export const MOCK_KITS: Record<string, string> = { "mosh-kit": "/kits/mosh-kit", "mosh-808": "/kits/mosh-808" };

type FileInfo = { frames: number; sampleRate: number; channels: number };
// The REAL bundled kit files (resources/drumkits/<kit>/*.wav, read 2026-10-05): length in
// frames at 44.1 kHz, mono. So a kit pad's duration in the mock is the file's own.
const KIT_FILE_FRAMES: Record<string, Record<string, number>> = {
  "mosh-kit": {
    "kick.wav": 15876, "snare.wav": 9702, "clap.wav": 9702, "hat_closed.wav": 2646,
    "hat_open.wav": 14994, "tom_low.wav": 17640, "tom_mid.wav": 14994, "crash.wav": 48510,
  },
  "mosh-808": {
    "kick.wav": 39690, "snare.wav": 9702, "clap.wav": 13230, "hat_closed.wav": 2425,
    "hat_open.wav": 18522, "tom_low.wav": 20286, "tom_mid.wav": 16758, "crash.wav": 57330,
  },
};

/** A small stable hash of a string (FNV-1a), for deterministic made-up file data. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const stem = (path: string): string => baseName(path).replace(/\.[^.]+$/, "");

/** What the mock "knows" about an audio file: the real numbers for a bundled kit file, a
 *  stable made-up length (0.2-2 s, 44.1 kHz, mono or stereo) for any other absolute path,
 *  nothing for a relative one (the engine cannot open it either). */
/** An imported copy is the same audio as the file it was copied from. */
function originalOf(path: string): string {
  for (const [source, copy] of importedPaths) if (copy === path && source !== path) return source;
  return path;
}

export function mockFileInfo(pathIn: string): FileInfo | null {
  if (!pathIn.startsWith("/")) return null;
  const path = originalOf(pathIn);
  for (const [kit, dir] of Object.entries(MOCK_KITS)) {
    const frames = path.startsWith(dir + "/") ? KIT_FILE_FRAMES[kit]?.[baseName(path)] : undefined;
    if (frames) return { frames, sampleRate: 44100, channels: 1 };
  }
  const h = hash(path);
  return { frames: Math.round(44100 * (0.2 + (h % 1800) / 1000)), sampleRate: 44100, channels: h % 3 === 0 ? 2 : 1 };
}

/** file_peaks for a path, deterministic: a one-shot's shape (fast attack, decaying body)
 *  seeded by the path. Bucket count as the engine's bucketedPeaks: `buckets`, or one per
 *  frame when the file is shorter than that. Null when the path is unknown. */
export function mockFilePeaks(path: string, buckets: number): [number, number][] | null {
  const info = mockFileInfo(path);
  if (!info) return null;
  const n = Math.min(buckets, info.frames);
  const h = hash(originalOf(path));
  const decay = 3 + (h % 7);                  // how fast the body falls
  const grain = 0.25 + ((h >>> 8) % 50) / 100; // how noisy it is
  return Array.from({ length: n }, (_, i) => {
    const t = i / Math.max(1, n - 1);
    const env = Math.min(1, t * 40) * Math.exp(-decay * t);
    const wobble = 1 - grain * 0.5 * (1 + Math.sin(i * 1.7 + (h % 13)) * Math.cos(i * 0.37));
    const a = Math.max(0.002, Math.min(1, 0.95 * env * wobble));
    const asym = 0.9 + ((h >>> 4) % 10) / 100;
    return [-a * asym, a];
  });
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The track's samplers in chain order; the first one is the primary (findSampler). */
export const samplersOf = (t: Track): Plugin[] => (t.plugins ?? []).filter((p) => p.type === "sampler");
export const primarySampler = (t: Track): Plugin | undefined => samplersOf(t)[0];

/** A sampler entry's sound list, created empty when missing. */
export function soundsOf(p: Plugin): SamplerSound[] {
  if (!p.sampler) p.sampler = { primary: true, sounds: [], limits: { ...SAMPLER_LIMITS } };
  return p.sampler.sounds;
}

/** The engine's padIndexForNote: the NARROWEST sound covering `note` (first on a tie), or -1. */
export function soundIndexForNote(sounds: readonly Pick<SamplerSound, "minNote" | "maxNote">[], note: number): number {
  let best = -1, bestSpan = Infinity;
  sounds.forEach((s, i) => {
    if (s.minNote > note || s.maxNote < note) return;
    const span = s.maxNote - s.minNote;
    if (span < bestSpan) { bestSpan = span; best = i; }
  });
  return best;
}

/** A new sound as addSound + setSoundParams + setSoundOpenEnded leave it. addSound stores
 *  the gain as given (unclamped); setSoundGains is what clamps. */
export function newSound(path: string, name: string, gainDb: number, mode: "drum" | "melodic", note: number): SamplerSound {
  const info = mockFileInfo(path);
  const melodic = mode === "melodic";
  return {
    index: 0, name, file: path, path, missing: false,
    pitch: note, minNote: melodic ? 0 : note, maxNote: melodic ? 127 : note,
    gainDb, userGainDb: gainDb, silenced: false, pan: 0, openEnded: !melodic,
    mode: melodic ? "melodic" : "drum",
    ...(info ? { durationSec: info.frames / info.sampleRate, sampleRate: info.sampleRate, channels: info.channels } : {}),
  };
}

/** load_drum_kit's loadDrumKitInto: every sound removed, the eight pads loaded (gated off:
 *  open-ended one-shots at 0 dB, key = min = max = the pad's pitch). */
export function loadKitInto(sampler: Plugin, kit: string): number {
  const dir = MOCK_KITS[kit] ?? MOCK_KITS[DEFAULT_KIT]!;
  const sounds = soundsOf(sampler);
  sounds.length = 0;
  for (const pad of KIT_PADS) sounds.push(newSound(`${dir}/${pad.file}`, pad.name, 0, "drum", pad.pitch));
  return KIT_PADS.length;
}

/** applyDrumLaneGains: park the gain of every pad whose ROOT note is muted (or not soloed
 *  while any lane is soloed) at the -48 dB floor, and restore the parked level of every pad
 *  that should sound again. The parked level is the flag; it is never inferred. */
export function applyDrumLaneGains(t: Track): void {
  const sampler = primarySampler(t);
  if (!sampler) return;
  const muted = new Set(t.drumMutedPitches ?? []);
  const solo = new Set(t.drumSoloPitches ?? []);
  for (const s of soundsOf(sampler)) {
    const shouldMute = solo.size > 0 ? !solo.has(s.pitch) : muted.has(s.pitch);
    if (shouldMute === s.silenced) continue;
    if (shouldMute) {
      s.userGainDb = clamp(s.gainDb, PAD_MUTE_DB, 48);
      s.gainDb = PAD_MUTE_DB;
      s.silenced = true;
    } else {
      s.gainDb = s.userGainDb;
      s.silenced = false;
    }
  }
}

const modeOf = (s: SamplerSound): SamplerSound["mode"] =>
  s.minNote === s.maxNote ? "drum" : s.minNote === 0 && s.maxNote === 127 ? "melodic" : "range";

/** Recompute everything the engine derives on a snapshot, for one track: per sampler, which
 *  one is primary, its kit, and per sound its index, mode and address note; then
 *  `track.drumPads` from the primary (absent when the track has no sampler). */
export function refreshSamplerViews(t: Track): void {
  const samplers = samplersOf(t);
  samplers.forEach((p, k) => {
    const info = p.sampler ?? (p.sampler = { primary: true, sounds: [], limits: { ...SAMPLER_LIMITS } });
    info.primary = k === 0;
    if (info.primary && t.drumKit) info.kit = t.drumKit;
    else delete info.kit;
    info.limits = { ...SAMPLER_LIMITS };
    info.sounds.forEach((s, i) => {
      s.index = i;
      s.mode = modeOf(s);
      if (!s.silenced) s.userGainDb = s.gainDb;
      let address: number | undefined;
      for (let n = s.minNote; n <= s.maxNote; n++) if (soundIndexForNote(info.sounds, n) === i) { address = n; break; }
      if (address === undefined) delete s.addressNote;
      else s.addressNote = address;
      if (!s.chokeGroup) delete s.chokeGroup;
    });
  });
  const primary = samplers[0];
  if (!primary) { delete t.drumPads; return; }
  t.drumPads = soundsOf(primary).map((s): DrumPad => ({
    index: s.index, pitch: s.pitch, minNote: s.minNote, maxNote: s.maxNote, name: s.name, file: s.file,
    gainDb: s.gainDb, pan: s.pan, openEnded: s.openEnded, ...(s.chokeGroup ? { chokeGroup: s.chokeGroup } : {}),
  }));
}

/** Where assign_sample's copy lands (the engine copies the file into the session's
 *  imports folder and plays the copy). A second, different file with the same name gets a
 *  numbered name. */
const importedPaths = new Map<string, string>();
export function importedPathFor(source: string): string {
  if (source.startsWith("/mock/imports/")) return source;
  const known = importedPaths.get(source);
  if (known) return known;
  const ext = baseName(source).match(/\.[^.]+$/)?.[0] ?? "";
  const taken = new Set(importedPaths.values());
  let candidate = `/mock/imports/${stem(source)}${ext}`;
  for (let n = 2; taken.has(candidate); n++) candidate = `/mock/imports/${stem(source)}-${n}${ext}`;
  importedPaths.set(source, candidate);
  return candidate;
}
export const resetImportedPaths = (): void => importedPaths.clear();
export { stem as sampleStem };
