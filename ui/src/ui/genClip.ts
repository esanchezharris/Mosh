import type { Clip, Track } from "../types";

// The clip a track's generative drawer targets. Generative runs on ANY clip type — a
// MIDI/drum clip is auto-bounced to audio by the backend before the model — so this no
// longer filters to wave clips. Prefer the SELECTED clip when it's on this track, else
// the track's first clip; undefined only when the track has no clips at all.
export function pickGenClip(track: Track, selectedClipId?: string): Clip | undefined {
  return (selectedClipId ? track.clips.find((c) => c.id === selectedClipId) : undefined) ?? track.clips[0];
}
