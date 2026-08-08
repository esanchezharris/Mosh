// Pure control-bar helpers for the live shell — the loop toggle's argument shaping.
// Kept store-free so the behaviour is unit-testable without React or the bridge.

import type { Transport } from "../types";

/** Args for the control-bar loop toggle.
 *
 *  Toggling OFF is always `{ loop: false }`. Toggling ON re-arms the existing range —
 *  except when the loop has collapsed to a point (loopEnd <= loopStart, the state a
 *  fresh session boots in), where Live's idiom is that the loop is always a RANGE,
 *  never a point: we default to the first four bars so the toggle can never arm an
 *  invisible zero-length loop the producer then has to hunt for. */
export function loopToggleArgs(t: Transport, barSec: number): Record<string, unknown> {
  if (t.looping) return { loop: false };
  const hasRange = t.loopEnd - t.loopStart > 1e-6;
  return hasRange
    ? { loop: true, loopStart: t.loopStart, loopEnd: t.loopEnd }
    : { loop: true, loopStart: 0, loopEnd: 4 * Math.max(0.1, barSec) };
}
