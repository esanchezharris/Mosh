// The detail dock's splitter geometry (ui/src/live/DetailDock.tsx). Pure so the
// clamp is unit-testable without a DOM.

/** Smallest CLIP-panel height (WIDGETS.md §1: the clip panel's min clamp is 226pt;
 *  a SHORT drag past it holds at 226, a long one dismisses the view — see
 *  DOCK_DISMISS_PX). */
export const DOCK_MIN = 226;
/** How far past the min a drag release must go to dismiss the clip view entirely
 *  (Live's drag-to-close), rather than clamping to the min. */
export const DOCK_DISMISS_PX = 48;
/** The dock may never eat more than this fraction of the shell — the arrangement
 *  must keep a usable share no matter how short the window gets. */
export const DOCK_MAX_FRAC = 0.7;

/** Clamp a requested dock height against the live shell's current height. */
export function clampDockHeight(px: number, shellHeight: number): number {
  // A shell shorter than MIN/FRAC would make max < min; the min wins then (a dock
  // you can still read beats a clamp that contradicts itself).
  const max = Math.max(DOCK_MIN, Math.floor(shellHeight * DOCK_MAX_FRAC));
  return Math.min(Math.max(Math.round(px), DOCK_MIN), max);
}

/** The device panel's fixed height (WIDGETS §1 — its top edge does not drag).
 *  Mirrors --live-device-h in live.css; the dock's flexBasis math needs the number. */
export const DEVICE_PANEL_H = 212;

/** True when a drag release at `px` should dismiss the view instead of clamping
 *  (a deliberate pull well past the floor, not a brush against it). */
export function dockDragDismisses(px: number): boolean {
  return px < DOCK_MIN - DOCK_DISMISS_PX;
}
