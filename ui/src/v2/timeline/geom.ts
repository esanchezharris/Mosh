// Shared timeline geometry for the v2 shell. The x-axis is SECONDS (clip.start is in
// seconds); sections come in beats and are converted here. Kept tiny + pure so the
// ribbon, ruler, lanes and playhead all share one mapping.
//
// Header/lane pixel geometry is OWNED by shell.css (--v2-head-w / --v2-lane-h) and read
// at runtime via headW()/laneH(). Do NOT re-introduce hardcoded JS mirror constants:
// there used to be `HEAD_W = 212` / `LANE_H = 92` here, and when the cream redesign moved
// the tokens to 168/64 the JS half silently drifted and painted the playhead 44px late.
// Reading the CSS custom property is what keeps the one source of truth honest.

import { meterFrom, beatSeconds, type Meter } from "../../time";
import type { Snapshot } from "../../types";

/** Read a pixel-valued CSS custom property off the nearest `.v2-shell` (fallback: the
 *  document root), so JS-positioned overlays share ONE geometry source with the CSS grid.
 *  `el` is any node inside the shell — pass a ref's current node. */
export function cssPx(name: string, el: Element | null, fallback: number): number {
  if (typeof window === "undefined" || typeof document === "undefined") return fallback;
  const scope =
    (el?.closest?.(".v2-shell") as Element | null) ??
    document.querySelector(".v2-shell") ??
    document.documentElement;
  const n = parseFloat(getComputedStyle(scope).getPropertyValue(name));
  return Number.isFinite(n) ? n : fallback;
}

/** Header-column width in px — mirrors `--v2-head-w`. Fallback matches the current token. */
export function headW(el: Element | null): number {
  return cssPx("--v2-head-w", el, 168);
}

/** Lane-row height in px — mirrors `--v2-lane-h`. Fallback matches the current token. */
export function laneH(el: Element | null): number {
  return cssPx("--v2-lane-h", el, 64);
}

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
