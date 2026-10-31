import type { LoopState, Plugin, Snapshot, Track } from "../types";
import type { MicrophonePermissionStatus } from "../bridge";
import { isLeadCandidate, pickLeadTrack } from "./BoothView";

// The Start page's step machine, React-free so every gate is unit-tested on its own.
//
// The page keeps CHOICES locally (which step, which tracks it set up, whether the tempo
// was confirmed, whether the phone was skipped) and reads FACTS from the snapshot on every
// render. The step only moves on a click or a documented auto-advance; the snapshot
// decides whether a step's button is enabled and whether its pip shows done. So an undo,
// a reload or a phone that drops out changes what the page SAYS, never where it is.

export type StartStep = "welcome" | "song" | "beat" | "voice" | "ready" | "phone";

/** The four pips. "Record" is lit once the singer reaches the ready card. */
export const PIPS = [
  { key: "beat", label: "Beat" },
  { key: "voice", label: "Voice" },
  { key: "phone", label: "Phone" },
  { key: "record", label: "Record" },
] as const;
export type PipKey = (typeof PIPS)[number]["key"];

export const PRESET_IDS = { clean: "mosh.clean-lead", tuned: "mosh.tuned-lead" } as const;
/** How many stages each bundled chain inserts (resources/presets/track-chain/*.json). */
export const PRESET_STAGES = { clean: 2, tuned: 3 } as const;

export interface StartIds {
  backingTrackId: string | null;
  leadTrackId: string | null;
  takesTrackId: string | null;
}

export interface BeatLocal {
  /** The beat this flow imported, when it imported one. */
  clipId: string | null;
  /** The singer pressed "Use N BPM" (or continue mode found a beat already in place). */
  confirmed: boolean;
  skipped: boolean;
  /** The tempo "Use N BPM" set. While it is known, the beat is only done if the session is
   *  still at it: ⌘Z of the tempo must bring the Use button back, not leave a stale ✓. */
  confirmedBpm?: number | null;
  /** A beat that was already on Backing when the singer pressed Continue: done as found,
   *  without requiring this page's loop range. */
  adopted?: boolean;
}

export interface PhoneLocal {
  everConnected: boolean;
  skipped: boolean;
}

/** What the singer's voice goes through, read from the stages the presets tagged. */
export type VoicePreset = "clean" | "tuned" | "lost-tuner" | "stacked" | "mixed" | "none";

/** Classify a track's chain by the Mosh preset stages on it. Exact stage counts: after
 *  #794, projects saved while AutoTune was dropped on relaunch can bring back SEVERAL
 *  tuned groups (the owner's six-AutoTune lane), and that must not read as healthy. */
export function voicePresetOf(track: Track | undefined): VoicePreset {
  const plugins: Plugin[] = track?.plugins ?? [];
  const clean = plugins.filter((p) => p.preset?.id === PRESET_IDS.clean).length;
  const tuned = plugins.filter((p) => p.preset?.id === PRESET_IDS.tuned);
  if (clean > 0 && tuned.length > 0) return "mixed";
  if (tuned.length > 0) {
    const tuners = tuned.filter((p) => p.type === "moshAutoTune").length;
    if (tuners === 0) return "lost-tuner";
    if (tuned.length > PRESET_STAGES.tuned || tuners > 1) return "stacked";
    return "tuned";
  }
  if (clean > PRESET_STAGES.clean) return "stacked";
  if (clean > 0) return "clean";
  return "none";
}

/** True when the track carries effects that are not a Mosh vocal preset (the producer's
 *  own chain, which the page must not stack a default on top of). */
export function hasOwnChain(track: Track | undefined): boolean {
  return (track?.plugins ?? []).some((p) => !p.isInstrument && !p.preset);
}

export function trackById(snapshot: Snapshot | null | undefined, id: string | null | undefined): Track | undefined {
  return id ? snapshot?.tracks.find((t) => t.id === id) : undefined;
}

/** The beat's track for continue mode: a plain audio track named Backing that is not the
 *  loop's Lead or Takes. Never "the first audio track": that is usually the vocal. */
export function pickBackingTrack(tracks: readonly Track[], loop: LoopState | null | undefined): Track | undefined {
  return tracks.find((t) => t.name.trim().toLowerCase() === "backing"
    && t.type !== "drum" && t.type !== "midi" && !t.isGroup && !t.isReturn
    && t.id !== loop?.leadTrackId && t.id !== loop?.takesTrackId);
}

const VOCAL_NAME = /\b(vocal|vocals|vox|voice|lead|rap|verse)\b/i;

/** Which Lead continue mode sets up: the loop's own; else a vocal-named track; else an
 *  armed or EMPTY candidate. Never the beat: not the Backing track, and not a track that
 *  only holds clips with nothing marking it as a voice (a dropped beat is usually also the
 *  SELECTED track, so the Booth's "selected first" rule would pick it). Undefined means
 *  "make a Vocal track". */
export function pickContinueLead(snapshot: Snapshot, selectedTrackId: string | null | undefined): Track | undefined {
  const loop = snapshot.loop;
  const engaged = trackById(snapshot, loop?.engaged ? loop.leadTrackId : null);
  if (engaged) return engaged;
  const backing = pickBackingTrack(snapshot.tracks, loop);
  const candidates = snapshot.tracks.filter((t) => t.id !== backing?.id
    && t.name.trim().toLowerCase() !== "backing" && isLeadCandidate(t, loop));
  const vocal = candidates.find((t) => VOCAL_NAME.test(t.name));
  if (vocal) return vocal;
  const safe = candidates.filter((t) => t.armed || t.clips.length === 0);
  return pickLeadTrack(safe, selectedTrackId, loop);
}

/** Which preset a broken chain should be repaired TO: Tuned only when the lane carries a
 *  Tuned stage; a doubled Clean chain is repaired to Clean, never "upgraded". */
export function repairTarget(track: Track | undefined): "clean" | "tuned" {
  return (track?.plugins ?? []).some((p) => p.preset?.id === PRESET_IDS.tuned) ? "tuned" : "clean";
}

/** The beat's tempo is still what the singer confirmed (or no tempo was recorded). */
export function tempoStillConfirmed(snapshot: Snapshot | null | undefined, beat: BeatLocal): boolean {
  if (!beat.confirmed) return false;
  if (beat.confirmedBpm == null) return true;
  const tempo = snapshot?.session.tempo;
  return typeof tempo === "number" && Math.abs(tempo - beat.confirmedBpm) < 0.05;
}

/** The beat clip the Beat step is about: the one this flow imported if it still exists,
 *  else the first audio clip already on the Backing track (continue mode). */
export function beatClipOf(snapshot: Snapshot | null | undefined, ids: StartIds, beat: BeatLocal) {
  const backing = trackById(snapshot, ids.backingTrackId);
  const clips = backing?.clips ?? [];
  return clips.find((c) => c.id === beat.clipId && c.type !== "midi")
    ?? clips.find((c) => c.type !== "midi");
}

/** The loop range covers the clip (what "Use N BPM" sets). */
export function loopCoversClip(snapshot: Snapshot | null | undefined, clip: { start: number; length: number } | undefined): boolean {
  const t = snapshot?.transport;
  if (!t || !clip) return false;
  const eps = 1e-3;
  return t.loopStart <= clip.start + eps && t.loopEnd >= clip.start + clip.length - eps;
}

export function songReady(snapshot: Snapshot | null | undefined, ids: StartIds): boolean {
  const loop = snapshot?.loop;
  return !!loop?.engaged && !!ids.leadTrackId && !!ids.takesTrackId
    && loop.leadTrackId === ids.leadTrackId && loop.takesTrackId === ids.takesTrackId
    && !!trackById(snapshot, ids.leadTrackId) && !!trackById(snapshot, ids.takesTrackId);
}

export function beatDone(snapshot: Snapshot | null | undefined, ids: StartIds, beat: BeatLocal): boolean {
  if (beat.skipped) return true;
  if (snapshot?.tracks.some((t) => t.type === "drum" && t.clips.length > 0)) return true;
  const clip = beatClipOf(snapshot, ids, beat);
  if (!clip || !tempoStillConfirmed(snapshot, beat)) return false;
  return beat.adopted === true || loopCoversClip(snapshot, clip);
}

export type MicState = MicrophonePermissionStatus | "unknown";

export interface ReadyInput {
  snapshot: Snapshot | null | undefined;
  ids: StartIds;
  mic: MicState;
  /** The build ships no vocal presets, or the singer kept their own chain. */
  chainNotRequired: boolean;
}

/** The first reason the singer is not ready, as the label the disabled "I'm ready" button
 *  carries, or null when everything is in place. Headphones are deliberately NOT here:
 *  they are a warning, never a block. */
export function readyBlocker({ snapshot, ids, mic, chainNotRequired }: ReadyInput): string | null {
  const loop = snapshot?.loop;
  if (!songReady(snapshot, ids)) return "Setting up…";
  const session = snapshot?.session as { audioReady?: boolean; audioDeviceError?: string } | undefined;
  if ((loop?.blockReason ?? "") !== "" || session?.audioReady === false || !!session?.audioDeviceError) {
    return "Recording is unavailable on this Mac";
  }
  if (mic === "denied" || mic === "restricted" || mic === "timed-out") return "Fix the microphone first";
  const takes = trackById(snapshot, ids.takesTrackId);
  if (!takes?.armed) return "Fix the microphone first";
  if (!chainNotRequired) {
    const lead = voicePresetOf(trackById(snapshot, ids.leadTrackId));
    const lane = voicePresetOf(takes);
    if (lead !== lane || (lead !== "clean" && lead !== "tuned")) return "Finish your voice";
  }
  return null;
}

export interface PipInput {
  step: StartStep;
  snapshot: Snapshot | null | undefined;
  ids: StartIds;
  beat: BeatLocal;
  phone: PhoneLocal;
  voiceReady: boolean;
}

export type PipState = "done" | "current" | "todo";

/** Done/current/todo for each pip, from facts + choices. */
export function pipStates({ step, snapshot, ids, beat, phone, voiceReady }: PipInput): Record<PipKey, PipState> {
  const current: PipKey | null =
    step === "beat" ? "beat"
      : step === "voice" ? "voice"
        : step === "phone" ? "phone"
          : step === "ready" ? "record"
            : null;
  const done: Record<PipKey, boolean> = {
    beat: beatDone(snapshot, ids, beat),
    voice: voiceReady,
    phone: phone.everConnected || phone.skipped,
    record: false,
  };
  // A pip is only "done" once the singer has moved past it: a Voice check lit while they
  // are still choosing a beat reads as a step they skipped.
  const at = current === null ? -1 : PIPS.findIndex((p) => p.key === current);
  const out = {} as Record<PipKey, PipState>;
  PIPS.forEach((pip, i) => {
    out[pip.key] = pip.key === current ? "current" : (i < at && done[pip.key]) ? "done" : "todo";
  });
  return out;
}

/** Where re-entering the page lands: Welcome for an empty session, otherwise the first
 *  step whose facts are not in place yet. */
export function firstIncomplete(snapshot: Snapshot | null | undefined, ids: StartIds, beat: BeatLocal,
  voiceReady: boolean): StartStep {
  if (!snapshot || snapshot.tracks.length === 0) return "welcome";
  if (!songReady(snapshot, ids)) return "welcome";
  if (!beatDone(snapshot, ids, beat)) return "beat";
  if (!voiceReady) return "voice";
  return "ready";
}

// ── Tuned Lead's key: the AutoTune menu labels vs set_key's names ──────────────────────

export const AUTOTUNE_KEYS = ["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"] as const;
export const AUTOTUNE_SCALES = ["Chromatic", "Major", "Minor"] as const;
export type AutoTuneScale = (typeof AUTOTUNE_SCALES)[number];

/** set_key's arguments for an AutoTune Key/Scale choice, or null when nothing should be
 *  written (Chromatic: "keep it loose" names no key). set_key validates its tonic by exact
 *  name and its mode in lowercase, so "C#/Db" + "Major" becomes {tonic:"C#", mode:"major"}. */
export function setKeyArgs(keyLabel: string, scale: AutoTuneScale): { tonic: string; mode: "major" | "minor" } | null {
  if (scale === "Chromatic") return null;
  const tonic = keyLabel.split("/")[0]?.trim();
  if (!tonic || !(AUTOTUNE_KEYS as readonly string[]).includes(keyLabel)) return null;
  return { tonic, mode: scale === "Major" ? "major" : "minor" };
}
