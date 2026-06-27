// Shared timeline geometry for the v2 shell. The x-axis is SECONDS (clip.start is in
// seconds); sections come in beats and are converted here. Kept tiny + pure so the
// ribbon, ruler, lanes and playhead all share one mapping. Constants mirror shell.css
// (--v2-head-w / --v2-lane-h) so JS-positioned overlays line up with the CSS grid.

import { meterFrom, beatSeconds, type Meter } from "../../time";
import type { Snapshot } from "../../types";

export const HEAD_W = 212; // must match --v2-head-w in shell.css
export const LANE_H = 92;  // must match --v2-lane-h in shell.css

export function meterOf(snap: Snapshot): Meter {
  return meterFrom(snap.session);
}

export function beatToSec(snap: Snapshot, beat: number): number {
  return beat * beatSeconds(meterFrom(snap.session));
}

/** Inverse of beatToSec — used by the ribbon to turn a pointer x (→ seconds) into beats. */
export function secToBeat(snap: Snapshot, sec: number): number {
  return sec / beatSeconds(meterFrom(snap.session));
}

/** Beats per bar for the snapshot's meter (the time-sig numerator). */
export function beatsPerBar(snap: Snapshot): number {
  return meterFrom(snap.session).num;
}

/** Total timeline length in seconds: project length, last clip end, last section end,
 *  with a small tail and a sane minimum so an empty session still shows a grid. */
export function contentSeconds(snap: Snapshot): number {
  let max = snap.session.length ?? 0;
  for (const t of snap.tracks) for (const c of t.clips) max = Math.max(max, c.start + c.length);
  const bs = beatSeconds(meterFrom(snap.session));
  for (const s of snap.sections ?? []) max = Math.max(max, s.endBeat * bs);
  return Math.max(max + 4, 32);
}
