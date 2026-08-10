import type { Clip, Track } from "../types";

export function proToolsOverlappingAudioClip(clip: Clip, track: Track): Clip | null {
  const clipEnd = clip.start + clip.length;
  return track.clips.find((candidate) => (
    candidate.id !== clip.id
    && candidate.type === "wave"
    && candidate.hidden !== true
    && candidate.start < clipEnd
    && candidate.start + candidate.length > clip.start
  )) ?? null;
}
