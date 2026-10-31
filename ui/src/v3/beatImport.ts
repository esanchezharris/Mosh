import type { CommandResult } from "../types";

// The Start page's Beat step, React-free: getting a beat onto the Backing track at bar 1,
// proposing its tempo, and confirming it.
//
// Owner decision (2026-10-30): DETECT, THEN CONFIRM. detect_clip_bpm proposes; the singer
// confirms ("Use 88 BPM") or nudges (÷2 / ×2) or types; confirming sets the project tempo
// and the loop to the clip. Imports never warp (LOOPINFO is pre-seeded on import since
// 89d6090a), so the tempo moves the GRID under the beat, never the beat itself.

export type Exec = (command: string, args?: Record<string, unknown>) => Promise<CommandResult | null>;

export const MIN_BPM = 40;
export const MAX_BPM = 240;
/** Below this detect_clip_bpm confidence the card asks instead of telling. A guess until
 *  the owner's START-beat row runs real beats through it. */
export const BPM_SURE = 0.3;
/** Drops are sent as base64 over the synchronous bridge, which freezes the UI while a big
 *  file travels. Above this the page points at "Choose a file…" (an import by path). */
export const DROP_CAP_BYTES = 64 * 1024 * 1024;

export const AUDIO_EXTENSIONS = [".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg"] as const;
export const AUDIO_FILTERS = AUDIO_EXTENSIONS.map((e) => `*${e}`).join(";");

export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return 120;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm * 10) / 10));
}

/** "late night 88bpm.wav" → 88. Only plausible tempos count. */
export function bpmFromName(name: string): number | null {
  const m = /(\d{2,3})\s?bpm/i.exec(name);
  if (!m) return null;
  const bpm = Number(m[1]);
  return bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : null;
}

export interface Detected { bpm: number; confidence: number }

export interface TempoProposal {
  bpm: number;
  source: "name" | "detected" | "session";
  /** False when the card should ask ("Not sure, sounds like 44 BPM?"). */
  sure: boolean;
}

const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

/** The tempo the card proposes. A BPM in the file name wins when detection agrees with it
 *  or is an octave off (detect_clip_bpm only searches 70..180, so a 60 or 200 BPM beat
 *  comes back doubled or halved); otherwise detection; otherwise the session tempo. */
export function proposeTempo(detected: Detected | null, fileName: string, sessionTempo: number): TempoProposal {
  const nameBpm = bpmFromName(fileName);
  if (nameBpm !== null && (!detected || near(detected.bpm, nameBpm)
    || near(detected.bpm, nameBpm * 2) || near(detected.bpm, nameBpm / 2))) {
    return { bpm: nameBpm, source: "name", sure: true };
  }
  if (detected && detected.bpm > 0) {
    return { bpm: clampBpm(detected.bpm), source: "detected", sure: detected.confidence >= BPM_SURE };
  }
  return { bpm: clampBpm(sessionTempo || 120), source: "session", sure: false };
}

export const halveBpm = (bpm: number) => clampBpm(bpm / 2);
export const doubleBpm = (bpm: number) => clampBpm(bpm * 2);
/** What the card shows: whole numbers stay whole, otherwise one decimal. */
export const formatBpm = (bpm: number) => (Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1));

export function looksLikeAudioName(name: string): boolean {
  const n = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((e) => n.endsWith(e));
}

export type BeatSource =
  | { kind: "path"; file: string }
  | { kind: "data"; name: string; dataBase64: string };

export interface ImportedBeat {
  ok: boolean;
  clipId: string | null;
  error: string | null;
}

/** Put a beat on the Backing track at bar 1. If this flow already put a beat there, it is
 *  removed first, so a second drop REPLACES the first instead of stacking on top of it.
 *
 *  The engine falls back to the first audio track when a trackId does not resolve, with no
 *  error (MoshOps.Clips.cpp importWaveFileToTrack). The result names the track it used, so
 *  a beat that landed anywhere but Backing is undone and reported, never left on the
 *  vocal. */
export async function importBeat(exec: Exec, source: BeatSource, backingTrackId: string,
  previousClipId: string | null): Promise<ImportedBeat> {
  if (previousClipId) {
    const removed = await exec("remove_clip", { clipId: previousClipId });
    if (!removed?.ok && removed?.error !== "no clip") {
      return { ok: false, clipId: null, error: removed?.error ?? "Couldn't replace the previous beat" };
    }
  }
  const result = source.kind === "path"
    ? await exec("import_clip", { file: source.file, trackId: backingTrackId, startSeconds: 0 })
    : await exec("import_clip_data", { name: source.name, dataBase64: source.dataBase64, trackId: backingTrackId, start: 0 });
  if (!result?.ok) return { ok: false, clipId: null, error: result?.error ?? "The beat couldn't be added" };
  const data = result.data as { clipId?: unknown; trackId?: unknown } | undefined;
  const clipId = typeof data?.clipId === "string" ? data.clipId : null;
  const landedOn = typeof data?.trackId === "string" ? data.trackId : null;
  if (landedOn !== null && landedOn !== backingTrackId) {
    await exec("undo", {});
    return { ok: false, clipId: null, error: "The Backing track went missing, so the beat wasn't added. Start the song again." };
  }
  return { ok: !!clipId, clipId, error: clipId ? null : "The engine didn't name the new clip" };
}

/** detect_clip_bpm, read-only. Null when the engine can't hear a pulse. */
export async function detectBpm(exec: Exec, clipId: string): Promise<Detected | null> {
  try {
    const r = await exec("detect_clip_bpm", { clipId });
    const d = r?.ok ? r.data as { bpm?: unknown; confidence?: unknown } | undefined : undefined;
    const bpm = typeof d?.bpm === "number" ? d.bpm : 0;
    if (!(bpm > 0)) return null;
    return { bpm, confidence: typeof d?.confidence === "number" ? d.confidence : 0 };
  } catch {
    return null;
  }
}

/** "Use N BPM": the tempo (one undo step), then the loop to the clip (machine state). */
export async function confirmTempo(exec: Exec, bpm: number, clip: { start: number; length: number }): Promise<string | null> {
  const tempo = await exec("set_tempo", { bpm: clampBpm(bpm) });
  if (!tempo?.ok) return tempo?.error ?? "Couldn't set the tempo";
  const loop = await exec("set_transport", { loop: true, loopStart: clip.start, loopEnd: clip.start + clip.length });
  if (!loop?.ok) return loop?.error ?? "Couldn't loop the beat";
  return null;
}
