import type { Snapshot } from "../types";

// V3 parity brief row 11 — the arrangement's horizontal geometry, in the shared store's
// pxPerSec (the same scale v2 and Pro Tools zoom). Pure so the mapping is unit-testable.

export type TimeBox = { start: number; length: number };

/** Beats in the session at its tempo (the lane grid's cell count). */
export function sessionBeatCount(session: Snapshot["session"]): number {
  const tempo = session.tempo ?? 120;
  const length = session.length ?? 32;
  return Math.max(4, Math.ceil((length * tempo) / 60));
}

/** Beats a clip spans at the session tempo (the clip's own content grid). */
export function clipBeatCount(lengthSec: number, tempo: number | undefined): number {
  return Math.max(1, Math.round((lengthSec * (tempo ?? 120)) / 60));
}

/** The lane's content width: the whole session at this zoom, never narrower than the viewport. */
export function laneContentPx(session: Snapshot["session"], pxPerSec: number, viewportPx: number): number {
  const length = Math.max(1e-6, session.length ?? 32);
  return Math.max(viewportPx, Math.ceil(length * pxPerSec));
}

/** A clip's box on the lane. A width floor keeps a very short clip grabbable. */
export function clipBox(box: TimeBox, pxPerSec: number): { left: number; width: number } {
  return { left: box.start * pxPerSec, width: Math.max(6, box.length * pxPerSec) };
}
