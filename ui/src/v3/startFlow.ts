import type { LoopState, Plugin, Snapshot, Track } from "../types";
import type { MicrophonePermissionStatus } from "../bridge";
import { isLeadCandidate, pickLeadTrack } from "./BoothView";

// The first-run checklist's rules (StartChecklist.tsx), React-free so every gate is
// unit-tested on its own.
//
// The checklist keeps CHOICES (which tracks the template made, whether the tempo was
// confirmed, what was skipped or dismissed) and reads FACTS from the snapshot on every
// render. The snapshot decides whether an item's button is enabled and whether it shows
// done. So an undo, a reload or a phone that drops out changes what the checklist SAYS.

/** The three things a first-time rapper sets up, in order. */
export const CHECK_ITEMS = [
  { key: "beat", label: "Beat" },
  { key: "voice", label: "Voice" },
  { key: "phone", label: "Phone" },
] as const;
export type CheckKey = (typeof CHECK_ITEMS)[number]["key"];
export type CheckChoice = "todo" | "done" | "skipped";

/** What the checklist remembers across launches (startMemory.ts persists it). */
export interface ChecklistProgress {
  beat: CheckChoice;
  voice: CheckChoice;
  phone: CheckChoice;
  dismissed: boolean;
}
export const EMPTY_PROGRESS: ChecklistProgress = { beat: "todo", voice: "todo", phone: "todo", dismissed: false };

/** Every item is done or skipped. */
export function checklistSettled(p: ChecklistProgress): boolean {
  return CHECK_ITEMS.every((item) => p[item.key] !== "todo");
}
/** Whether the checklist shows by itself at launch: not once it is settled or dismissed. */
export function checklistOpensAtLaunch(p: ChecklistProgress): boolean {
  return !p.dismissed && !checklistSettled(p);
}
/** The item to open first: the earliest one still to do, or null when none is. */
export function firstOpenItem(p: ChecklistProgress): CheckKey | null {
  return CHECK_ITEMS.find((item) => p[item.key] === "todo")?.key ?? null;
}

export const PRESET_IDS = { clean: "mosh.clean-lead", tuned: "mosh.tuned-lead" } as const;
/** How many stages each bundled chain inserts (resources/presets/track-chain/*.json). */
export const PRESET_STAGES = { clean: 2, tuned: 3 } as const;

export interface StartIds {
  /** The beat's track ("Beat"; "Backing" in songs made before the three-track template). */
  backingTrackId: string | null;
  leadTrackId: string | null;
  /** The phone remote's Takes lane, once the remote has been set up on the Lead. */
  takesTrackId: string | null;
}

/** The names the beat's track goes by: the template's "Beat", and "Backing" from songs
 *  made before it was renamed. */
export function isBeatTrackName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "beat" || n === "backing";
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

/** The beat's track in a song that is already open: a plain audio track named Beat (or
 *  Backing) that is not the loop's Lead or Takes. Never "the first audio track": that is
 *  usually the vocal. */
export function pickBackingTrack(tracks: readonly Track[], loop: LoopState | null | undefined): Track | undefined {
  return tracks.find((t) => isBeatTrackName(t.name)
    && t.type !== "drum" && t.type !== "midi" && !t.isGroup && !t.isReturn
    && t.id !== loop?.leadTrackId && t.id !== loop?.takesTrackId);
}

const VOCAL_NAME = /\b(vocal|vocals|vox|voice|lead|rap|verse)\b/i;

/** Which Lead an already-open song uses: the loop's own; else a vocal-named track; else an
 *  armed or EMPTY candidate. Never the beat: not the Beat track, and not a track that
 *  only holds clips with nothing marking it as a voice (a dropped beat is usually also the
 *  SELECTED track, so "selected first" would pick it). The template's "Ad-libs" is not
 *  vocal-named on purpose, so "Lead vocal" wins. Undefined means "no vocal track here". */
export function pickContinueLead(snapshot: Snapshot, selectedTrackId: string | null | undefined): Track | undefined {
  const loop = snapshot.loop;
  const engaged = trackById(snapshot, loop?.engaged ? loop.leadTrackId : null);
  if (engaged) return engaged;
  const backing = pickBackingTrack(snapshot.tracks, loop);
  const candidates = snapshot.tracks.filter((t) => t.id !== backing?.id
    && !isBeatTrackName(t.name) && isLeadCandidate(t, loop));
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

/** The tracks the checklist works on: what the template reported (while those tracks
 *  still exist), else what the open song offers. The Takes lane only counts while the
 *  phone remote is set up on this Lead. */
export function resolveIds(snapshot: Snapshot | null | undefined, remembered: StartIds): StartIds {
  if (!snapshot) return { backingTrackId: null, leadTrackId: null, takesTrackId: null };
  const loop = snapshot.loop;
  const lead = trackById(snapshot, remembered.leadTrackId) ?? pickContinueLead(snapshot, null);
  const beat = trackById(snapshot, remembered.backingTrackId) ?? pickBackingTrack(snapshot.tracks, loop);
  const takes = lead && loop?.engaged && loop.leadTrackId === lead.id ? trackById(snapshot, loop.takesTrackId) : undefined;
  return {
    backingTrackId: beat && beat.id !== lead?.id ? beat.id : null,
    leadTrackId: lead?.id ?? null,
    takesTrackId: takes?.id ?? null,
  };
}

/** The track the microphone records onto and is heard through: the Takes lane once the
 *  phone remote is set up, otherwise the Lead itself. */
export function micLaneOf(snapshot: Snapshot | null | undefined, ids: StartIds): Track | undefined {
  return trackById(snapshot, ids.takesTrackId) ?? trackById(snapshot, ids.leadTrackId);
}

export interface VoiceInput {
  snapshot: Snapshot | null | undefined;
  ids: StartIds;
  mic: MicState;
  /** The build ships no vocal presets, or the rapper kept their own chain. */
  chainNotRequired: boolean;
}

/** The first reason the voice is not ready, as the label the disabled "Sounds right"
 *  button carries, or null when everything is in place. Headphones are deliberately NOT
 *  here: they are a warning, never a block. */
export function voiceBlocker({ snapshot, ids, mic, chainNotRequired }: VoiceInput): string | null {
  const lead = trackById(snapshot, ids.leadTrackId);
  if (!lead) return "Set up a song first";
  const session = snapshot?.session as { audioReady?: boolean; audioDeviceError?: string } | undefined;
  if ((snapshot?.loop?.blockReason ?? "") !== "" || session?.audioReady === false || !!session?.audioDeviceError) {
    return "Recording is unavailable on this Mac";
  }
  if (mic === "denied" || mic === "restricted" || mic === "timed-out") return "Fix the microphone first";
  const lane = micLaneOf(snapshot, ids);
  if (!lane?.armed) return "Fix the microphone first";
  if (!chainNotRequired) {
    const leadPreset = voicePresetOf(lead);
    if (leadPreset !== "clean" && leadPreset !== "tuned") return "Finish your voice";
    if (lane.id !== lead.id && voicePresetOf(lane) !== leadPreset) return "Finish your voice";
  }
  return null;
}

/** How each item reads right now. The beat is a FACT about the open song (an undone tempo
 *  brings it back); voice and phone are what the rapper confirmed, held while the facts
 *  still agree. "skipped" only shows while the item is not actually done. */
export function itemStates(input: {
  snapshot: Snapshot | null | undefined;
  ids: StartIds;
  beat: BeatLocal;
  progress: ChecklistProgress;
  voiceReady: boolean;
  phoneConnected: boolean;
}): Record<CheckKey, CheckChoice> {
  const { snapshot, ids, beat, progress, voiceReady, phoneConnected } = input;
  const beatFact = beatDone(snapshot, ids, { ...beat, skipped: false });
  return {
    beat: beatFact ? "done" : progress.beat === "skipped" ? "skipped" : "todo",
    voice: progress.voice === "done" && voiceReady ? "done" : progress.voice === "skipped" ? "skipped" : "todo",
    phone: phoneConnected || progress.phone === "done" ? "done" : progress.phone === "skipped" ? "skipped" : "todo",
  };
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
