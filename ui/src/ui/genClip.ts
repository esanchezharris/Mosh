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

/** Matches MoshOps::applyRenderInPlace's tolerance — the comparison that actually decides
 *  in-place apply vs the legacy "Neural Renders" lane landing. */
const SECTION_EPS = 1e-3;

/** Is this clip's render layer scoped to PART of the clip?
 *
 *  The snapshot always carries regionStart/regionEnd — a whole-clip layer reports the clip's
 *  own span — so this is a comparison, never a presence check. It is the gate for offering
 *  Bounce: bounce_layer_to_clip only does real work for a section render (on the whole-clip
 *  and MIDI-beneath paths cmdAcceptRender takes a no-op branch, so bounce just relabels). */
export function isSectionScoped(clip: Clip): boolean {
  const rl = clip.renderLayer;
  if (!rl || rl.regionStart === undefined || rl.regionEnd === undefined) return false;
  const cs = clip.start;
  const ce = clip.start + clip.length;
  return rl.regionStart > cs + SECTION_EPS || rl.regionEnd < ce - SECTION_EPS;
}
