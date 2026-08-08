// Live 12's zoom history (X = Zoom Back): a stack of view states the arrangement
// returns to, one per X press. The pure stack lives here; the recording seam is
// `recordZoom()` at each zoom mutation point (⌘+/⌘−, ruler drag-zoom, fit-to-span)
// and `popZoom()` in the X handler. Live-shell scope: capture is a no-op when the
// live lanes scroller isn't mounted (other shells never see the stack).
//
// Coalescing: a burst of rapid changes (a ruler drag, repeated ⌘+ taps) is ONE
// history entry — the view from BEFORE the burst. A record more than 300ms after
// the previous one starts a new entry. The stack caps at 50 (Live's order of
// magnitude; beyond that zoom-back stops being meaningful).

import { useStore } from "../store";

export type ZoomView = { pxPerSec: number; scrollLeft: number };

export const ZOOM_HISTORY_CAP = 50;
export const ZOOM_COALESCE_MS = 300;

/** The zoom-history stack as a value (dependency-injected for tests). */
export function pushZoom(
  stack: readonly ZoomView[],
  view: ZoomView,
  nowMs: number,
  lastRecordAtMs: number | null,
): { stack: ZoomView[]; pushed: boolean } {
  if (lastRecordAtMs != null && nowMs - lastRecordAtMs <= ZOOM_COALESCE_MS && stack.length > 0)
    return { stack: [...stack], pushed: false };   // same burst — keep the burst-start entry
  const next = [...stack, view];
  return { stack: next.length > ZOOM_HISTORY_CAP ? next.slice(next.length - ZOOM_HISTORY_CAP) : next, pushed: true };
}

export function popZoom(stack: readonly ZoomView[]): { stack: ZoomView[]; view: ZoomView | null } {
  if (stack.length === 0) return { stack: [], view: null };
  return { stack: stack.slice(0, stack.length - 1), view: stack[stack.length - 1] };
}

/** The live lanes' current view, or null off the live shell (no stack writes there). */
export function captureView(): ZoomView | null {
  const scroller = document.querySelector<HTMLElement>(".live-lanes-scroll");
  if (!scroller) return null;
  return { pxPerSec: useStore.getState().pxPerSec ?? 80, scrollLeft: scroller.scrollLeft };
}

// ── module-level instance (the live shell's one stack) ────────────────────────
let stack: ZoomView[] = [];
let lastRecordAt: number | null = null;

/** Record the CURRENT view before a zoom change (call at every zoom mutation point). */
export function recordZoom(nowMs: number = Date.now()): void {
  const view = captureView();
  if (!view) return;
  const r = pushZoom(stack, view, nowMs, lastRecordAt);
  stack = r.stack;
  lastRecordAt = nowMs;
}

/** Pop the previous view and restore it (Live's X). Returns false when the stack
 *  is empty — X is a no-op there, matching Live. */
export function popZoomView(): boolean {
  const r = popZoom(stack);
  if (!r.view) return false;
  stack = r.stack;
  lastRecordAt = null;   // a restore is a new gesture, not part of any burst
  const scroller = document.querySelector<HTMLElement>(".live-lanes-scroll");
  useStore.getState().setPxPerSec(r.view.pxPerSec);
  if (scroller) scroller.scrollLeft = r.view.scrollLeft;
  return true;
}

/** Test hook: reset the module stack between specs. */
export function clearZoomHistory(): void {
  stack = [];
  lastRecordAt = null;
}

/** Test hook: read the module stack's depth. */
export function zoomHistoryDepth(): number {
  return stack.length;
}
