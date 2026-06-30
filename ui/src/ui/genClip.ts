import type { Clip, Track } from "../types";

// The clip a track's generative drawer targets. Generative runs on ANY clip type — a
// MIDI/drum clip is auto-bounced to audio by the backend before the model — so this no
// longer filters to wave clips. Prefer the SELECTED clip when it's on this track, else
// the track's first clip; undefined only when the track has no clips at all.
// HIDDEN beneath-render clips (Phase 2) are never a target — they're the audio a re-imagine
// produces, not a clip to re-imagine — so they're excluded from both the selection and the
// fallback.
export function pickGenClip(track: Track, selectedClipId?: string): Clip | undefined {
  const clips = track.clips.filter((c) => !c.hidden);
  return (selectedClipId ? clips.find((c) => c.id === selectedClipId) : undefined) ?? clips[0];
}
