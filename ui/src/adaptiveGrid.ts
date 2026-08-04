// CAP-CLP-002 — the ADAPTIVE grid: pick the snap division from the current zoom.
//
// Why it is not a new `SnapDiv` member. "auto" is not a division — it is a POLICY for
// choosing one. Adding it to the union would force every consumer that converts a
// division into seconds (`snapStep`, `QUARTERS`, the ruler, the piano roll) to handle a
// value that has no length, and each of those would need its own fallback. Instead the
// policy lives here, the store holds one boolean, and everything downstream keeps
// receiving a real division.
//
// The rule: pick the FINEST division whose grid step is still wide enough to aim at.
// Zoomed out, that lands on bars; zoomed in, on 1/32 — which is what a producer means by
// "the grid follows me". Every reference DAW does this (Live's adaptive zoom, Reaper's
// "Grid line spacing adapts to zoom", Pro Tools' relative grid), so it is well past the
// 2-of-4 bar for agreed behaviour.

import { snapStep, SNAP_DIVISIONS, type Meter, type SnapDiv } from "./time";

/** Minimum on-screen width for one grid step, in px. Below this the lines are closer
 *  together than a pointer can be aimed, so a finer grid stops being a grid and starts
 *  being noise. 12px is a little over a typical trackpad's practical precision. */
export const MIN_GRID_PX = 12;

/**
 * The division to snap to at this zoom.
 * `SNAP_DIVISIONS` runs coarse → fine, so scanning from the fine end and taking the first
 * that clears the threshold yields the finest usable grid. If none clears it (absurdly
 * zoomed out), the coarsest is still the right answer — never no grid at all.
 */
export function adaptiveDivision(m: Meter, pxPerSec: number): SnapDiv {
  if (!Number.isFinite(pxPerSec) || pxPerSec <= 0) return "bar";
  for (let i = SNAP_DIVISIONS.length - 1; i >= 0; i--) {
    const d = SNAP_DIVISIONS[i]!;
    if (snapStep(m, d) * pxPerSec >= MIN_GRID_PX) return d;
  }
  return SNAP_DIVISIONS[0]!;
}
