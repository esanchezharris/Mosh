// Shared timeline geometry for the v2 shell. The x-axis is SECONDS (clip.start is in
// seconds); sections come in beats and are converted here. Kept tiny + pure so the
// ribbon, ruler, lanes and playhead all share one mapping.

import { meterFrom, beatSeconds, type Meter } from "../../time";
import type { Snapshot } from "../../types";

// Fallback for headW() when the stylesheet isn't in play (jsdom tests, or a render
// before .v2-shell is in the DOM). Matches --v2-head-w in shell.css.
const HEAD_W_FALLBACK = 278;

let cachedHeadW = 0;

/** Header-column width in px, read from the live --v2-head-w token on .v2-shell so
 *  JS-positioned overlays (playhead, zoom-to-fit) can never drift from the CSS grid.
 *  A successful read is cached (the token is static per session); a failed read
 *  returns the fallback WITHOUT caching, so a pre-mount render self-corrects. */
export function headW(): number {
  if (cachedHeadW > 0) return cachedHeadW;
  const el = typeof document !== "undefined" ? document.querySelector(".v2-shell") : null;
  const v = el ? parseFloat(getComputedStyle(el).getPropertyValue("--v2-head-w")) : NaN;
  if (Number.isFinite(v) && v > 0) cachedHeadW = v;
  return cachedHeadW > 0 ? cachedHeadW : HEAD_W_FALLBACK;
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
