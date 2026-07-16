import type { Clip, Track } from "../types";
import { clipRectInRange, type ClipRect, type VisibleRange } from "./timelineGeometry";

export type LaneSurfaceKind = "drum" | "midi" | "wave";
export type DrumVoice = "KICK" | "SNARE" | "HI-HAT" | "PERC";
export type VisibleLaneClip = { readonly clip: Clip; readonly rect: ClipRect };

const DRUM_PITCHES = new Set([35, 36, 37, 38, 39, 40, 42, 44, 46, 45, 47, 48, 49, 50, 51, 52, 53, 55, 57]);

export function drumVoiceForPitch(pitch: number): DrumVoice {
  if (pitch === 35 || pitch === 36) return "KICK";
  if (pitch >= 37 && pitch <= 40) return "SNARE";
  if (pitch === 42 || pitch === 44 || pitch === 46) return "HI-HAT";
  return "PERC";
}

export function classifyLane(track: Pick<Track, "type" | "clips">): LaneSurfaceKind {
  if (track.type.toLowerCase().includes("drum")) return "drum";
  const visibleClips = track.clips.filter((clip) => !clip.hidden);
  const notes = visibleClips.flatMap((clip) => clip.notes ?? []);
  if (notes.length > 0 && notes.every((note) => DRUM_PITCHES.has(note.pitch))) return "drum";
  if (notes.length > 0 || visibleClips.some((clip) => clip.type === "midi") || /midi|instrument/i.test(track.type)) return "midi";
  return "wave";
}

export function visibleLaneClips(clips: readonly Clip[], range: VisibleRange): readonly VisibleLaneClip[] {
  const result: VisibleLaneClip[] = [];
  for (const clip of clips) {
    if (clip.hidden) continue;
    const rect = clipRectInRange(clip.start, clip.length, range);
    if (rect) result.push({ clip, rect });
  }
  return result;
}
