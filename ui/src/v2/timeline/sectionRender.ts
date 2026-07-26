// Resolving a time-range selection to a SECTION-SCOPED render target.
//
// create_render_layer has accepted regionStart/regionEnd since it was written, but nothing in
// any shell ever sent them — the args were agent-only, so a section-scoped render was a shape
// the product could describe and never make. That is what kept bounce_layer_to_clip a no-op
// relabel: it does real work ONLY for a sub-region render (MoshOps::applyRenderInPlace bails
// on one, so it lands on the "Neural Renders" lane instead of swapping the clip's source).
//
// The time-range band is the natural home — the producer has already said which span they
// mean. This is the pure part, kept out of the component so the rules are testable without a
// DOM: which clip the span refers to, and whether it is genuinely a sub-region.

import type { Track } from "../../types";

// isSectionScoped lives in the shared ui/ layer (genClip.ts) because the DRAWER needs it too,
// and ui/ must not import from v2/ — the dependency runs one way.
export { isSectionScoped } from "../../ui/genClip";

/** Matches MoshOps::applyRenderInPlace's tolerance, which is what actually decides
 *  in-place-apply vs the lane landing. Keeping the same epsilon means the UI cannot offer a
 *  "section" the engine would then treat as a whole clip. */
const EPS = 1e-3;

/** The create_render_layer args for a section render. Indexable because it is passed
 *  straight to exec(), whose args are Record<string, unknown>. */
export interface SectionTarget {
  clipId: string;
  regionStart: number;
  regionEnd: number;
  [k: string]: unknown;
}

/** The clip a span refers to, or null when the span cannot become a section render.
 *
 *  Deliberately scoped to the SELECTED track rather than every overlapping clip: a range
 *  selection spans all lanes (that is what makes ripple delete meaningful), so without this
 *  the button would have to guess which of several clips the producer meant. */
export function sectionTargetFor(
  tracks: readonly Track[],
  selectedTrackId: string | null,
  range: { start: number; end: number } | null,
): SectionTarget | null {
  if (!range || !selectedTrackId) return null;
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  if (end - start <= EPS) return null;

  const track = tracks.find((t) => t.id === selectedTrackId);
  if (!track) return null;

  for (const clip of track.clips) {
    const cs = clip.start;
    const ce = clip.start + clip.length;
    const rs = Math.max(start, cs);
    const re = Math.min(end, ce);
    if (re - rs <= EPS) continue;                    // no real overlap with this clip

    // A span that covers the whole clip is not a section — the drawer's own Re-imagine is
    // the control for that, and the engine would apply it in place anyway.
    if (rs <= cs + EPS && re >= ce - EPS) return null;

    // create_render_layer refuses a second layer on the same clip, so offering the button
    // would produce a guaranteed error toast.
    if (clip.hasRenderLayer) return null;

    return { clipId: clip.id, regionStart: rs, regionEnd: re };
  }
  return null;
}
