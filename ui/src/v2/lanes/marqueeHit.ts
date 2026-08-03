// Pure geometry for marquee (lasso) selection. No React, no store, no DOM — the
// component measures, this decides. Kept separate so the rule "which clips does this
// rectangle select?" is unit-testable without mounting a timeline, the same split as
// `pianoRollGeom.ts` and `drumGrid.ts`.
//
// Coordinate space: x is CONTENT pixels (seconds * pxPerSec, i.e. already past the
// sticky header column and already scroll-corrected); y is pixels relative to the
// timeline grid's top. Both are whatever the caller measured — this module never
// touches getBoundingClientRect.

export interface MarqueeRect { x0: number; y0: number; x1: number; y1: number }

/** A lane's vertical extent, as measured from the DOM. */
export interface LaneBox { trackId: string; top: number; bottom: number }

/** A clip's horizontal extent in the same content-pixel space. */
export interface ClipBox { id: string; trackId: string; left: number; right: number }

export interface Bounds { xMin: number; xMax: number; yMin: number; yMax: number }

/** Drag-direction-independent bounds: a right-to-left or bottom-to-top drag selects
 *  the same clips as the opposite one. */
export function boundsOf(r: MarqueeRect): Bounds {
  return {
    xMin: Math.min(r.x0, r.x1),
    xMax: Math.max(r.x0, r.x1),
    yMin: Math.min(r.y0, r.y1),
    yMax: Math.max(r.y0, r.y1),
  };
}

/** Below this the gesture was a click, not a drag — the caller treats it as DESELECT.
 *  4px is the usual slop for "the mouse moved while the button was down". */
export const MARQUEE_MIN_DRAG_PX = 4;

export function isDrag(r: MarqueeRect): boolean {
  return Math.abs(r.x1 - r.x0) >= MARQUEE_MIN_DRAG_PX
    || Math.abs(r.y1 - r.y0) >= MARQUEE_MIN_DRAG_PX;
}

/**
 * Clips the rectangle selects: TOUCH semantics (any overlap), not enclosure.
 *
 * Touch is what Live, Reaper, Pro Tools and FL all do — a lasso that only caught clips
 * it fully contained would make it impossible to grab a long clip without dragging past
 * both its ends, which on a zoomed-in arrangement can be several screens apart.
 * That is the 2-of-4 agreed behaviour, so it is what Mosh implements.
 *
 * Zero-width and zero-height clips still count when the rectangle crosses them, so a
 * marquee over a very short clip at high zoom-out cannot silently miss it.
 */
export function marqueeHits(
  rect: MarqueeRect,
  lanes: readonly LaneBox[],
  clips: readonly ClipBox[],
): string[] {
  const b = boundsOf(rect);
  const touchedTracks = new Set(
    lanes.filter((l) => l.bottom >= b.yMin && l.top <= b.yMax).map((l) => l.trackId),
  );
  return clips
    .filter((c) => touchedTracks.has(c.trackId) && c.right >= b.xMin && c.left <= b.xMax)
    .map((c) => c.id);
}
