// The MIDI editor's OWN grid, independent of the arrangement's.
//
// They were the same setting, which is wrong in both directions: choosing 1/16 to place
// hi-hats also re-gridded the arrangement, and setting the arrangement to bars made the
// note editor useless. Ableton keeps them separate for exactly this reason.
//
// Adaptive mode follows the zoom instead of a fixed division — the finest division whose
// lines are still far enough apart to aim at. That is what makes zooming in feel like it
// gives you more precision rather than just bigger rectangles.

import type { Meter, SnapDiv } from "../time";
import { snapStepBeats, SNAP_DIVISIONS } from "../time";

export type EditorGrid = {
  division: SnapDiv;
  /** Triplet feel: three notes in the space of two. */
  triplet: boolean;
  /** Follow the zoom rather than the fixed division. */
  adaptive: boolean;
};

export const GRID_DEFAULT: EditorGrid = { division: "1/16", triplet: false, adaptive: true };

/** Coarse → fine. What Cmd+1..4 selects from, and what adaptive picks from. Shared with
 *  the arrangement so the two grids speak the same vocabulary even though they are
 *  independent settings. */
export const GRID_DIVISIONS: readonly SnapDiv[] = SNAP_DIVISIONS;

/** Minimum pixels between grid lines for them to be worth aiming at. */
const MIN_LINE_PX = 14;

/** The finest division whose lines stay at least MIN_LINE_PX apart at this zoom. */
export function adaptiveDivision(m: Meter, beatPx: number, minPx = MIN_LINE_PX): SnapDiv {
  let best: SnapDiv = "bar";
  for (const d of GRID_DIVISIONS) {
    const px = snapStepBeats(m, d) * beatPx;
    if (px >= minPx) best = d;   // list is coarse→fine, so the last one that fits wins
  }
  return best;
}

/** Beats per grid step, honouring adaptive + triplet. */
export function effectiveStepBeats(m: Meter, g: EditorGrid, beatPx: number): number {
  const division = g.adaptive ? adaptiveDivision(m, beatPx) : g.division;
  const base = snapStepBeats(m, division);
  // A triplet fits three in the space of two, so each is 2/3 as long.
  return g.triplet ? base * (2 / 3) : base;
}

/** What the grid button shows. Adaptive names the division it actually resolved to. */
export function gridLabel(m: Meter, g: EditorGrid, beatPx: number): string {
  const division = g.adaptive ? adaptiveDivision(m, beatPx) : g.division;
  const name = `${division}${g.triplet ? "T" : ""}`;
  return g.adaptive ? `${name} (auto)` : name;
}
