// Pure geometry for the piano-roll grid. Kept out of the component (same rationale as
// pianoRollScroll.ts) so the clamping-prone arithmetic is testable without a layout engine.

/**
 * How many beats the grid must span.
 *
 * The grid used to be sized from the CLIP alone (`ceil(clipBeats) + 4`), so a short clip
 * produced a grid narrower than its scroll container and the panel's own background
 * showed through beside it — the "empty right third". The fix is to take whichever is
 * longer: enough beats to cover the viewport, or the clip plus a runway.
 *
 * Rounded up to whole BARS so the grid never ends mid-bar (a half-drawn bar reads as a
 * rendering glitch). `viewportW` is 0 before the ResizeObserver has measured, which
 * simply falls back to the clip rule — CSS `min-width: 100%` covers that first paint.
 */
export function gridBeatsFor(opts: {
  clipBeats: number;
  beatsPerBar: number;
  beatPx: number;
  viewportW: number;
}): number {
  const bpb = Math.max(1, Math.floor(opts.beatsPerBar) || 1);
  const tail = bpb * 2;
  // Two bars is also the FLOOR for a clip's own span, so an almost-empty clip still
  // opens onto a usable canvas rather than a sliver.
  const clipBeats = Math.max(bpb * 2, Number.isFinite(opts.clipBeats) ? opts.clipBeats : 0);
  const fill = opts.beatPx > 0 && Number.isFinite(opts.viewportW) ? opts.viewportW / opts.beatPx : 0;
  const raw = Math.max(fill, clipBeats + tail);
  return Math.ceil(raw / bpb) * bpb;
}

export const BEAT_PX_MIN = 12;
export const BEAT_PX_MAX = 160;

/**
 * Snap a note-DRAW start DOWN to the grid line at or below the pointer.
 *
 * Why this is not Math.round: round-to-nearest moves the start up to HALF a grid
 * step away from the click — at a 1-beat grid the note can begin a half beat from
 * where you pointed, and AHEAD of it. Every reference DAW's pencil floors the
 * draw start (Live, Logic, FL): you point at the bar the note starts in, it
 * starts at that line. Round stays correct for MOVE gestures (preserve the
 * relative feel of the thing you grabbed); entry is the case that must floor.
 *
 * The epsilon keeps a click that lands a hair left of a line (floating-point dust
 * from px → beats) ON that line instead of dropping a whole step below it.
 */
export function snapDownBeat(beat: number, stepBeats: number): number {
  if (!Number.isFinite(beat) || !Number.isFinite(stepBeats) || stepBeats <= 0) return beat;
  return Math.floor((beat + 1e-6) / stepBeats) * stepBeats;
}

/** Clamp a zoom level to the usable range. */
export function clampBeatPx(v: number): number {
  if (!Number.isFinite(v)) return BEAT_PX_MIN;
  return Math.max(BEAT_PX_MIN, Math.min(BEAT_PX_MAX, v));
}

/**
 * Zoom about a fixed point. Returns the new zoom AND the scrollLeft that keeps whatever
 * was under `anchorX` (a pixel offset into the scroll VIEWPORT) under it afterwards —
 * without that, zooming walks the music out from under the pointer.
 */
export function zoomAnchored(opts: {
  beatPx: number;
  factor: number;
  scrollLeft: number;
  anchorX: number;
}): { beatPx: number; scrollLeft: number } {
  const next = clampBeatPx(opts.beatPx * opts.factor);
  const beatUnderAnchor = (opts.scrollLeft + opts.anchorX) / opts.beatPx;
  const scrollLeft = Math.max(0, beatUnderAnchor * next - opts.anchorX);
  return { beatPx: next, scrollLeft };
}

/**
 * How many BARS to skip between printed ruler numbers, so labels never collide.
 * At 42px/beat in 4/4 a bar is 168px and every bar is labelled; zoomed out to 12px/beat
 * a bar is 48px and labels would overlap, so they thin to every 2nd, 4th, 8th…
 */
export function rulerStride(barWidthPx: number, minLabelGapPx = 44): number {
  if (!Number.isFinite(barWidthPx) || barWidthPx <= 0) return 1;
  let stride = 1;
  while (barWidthPx * stride < minLabelGapPx) stride *= 2;
  return stride;
}
