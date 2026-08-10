// Zoom-to-fit (Live's X / "Zoom Back from Time Selection"): fit a span into the
// lanes viewport and scroll it into view. Shared by the X key (useLiveKeys) and the
// clip context menu — one geometry implementation, both entry points.

import { useStore } from "../store";
import { applyArrangementZoom, recordZoom } from "./zoomHistory";

export function zoomToFitSpan(span: { start: number; end: number }): boolean {
  if (!span || span.end - span.start < 1e-6) return false;
  const scroller = document.querySelector<HTMLElement>(".live-lanes-scroll");
  if (!scroller) return false;
  recordZoom();   // Live's zoom history: X returns to the view before the fit
  applyArrangementZoom(
    scroller,
    (scroller.clientWidth * 0.9) / (span.end - span.start), // store clamps 20..400
    (applied) => span.start * applied - scroller.clientWidth * 0.05,
  );
  return true;
}

/** The span X/menu acts on: the drawn time selection, else the selected clips'. */
export function currentFitSpan(): { start: number; end: number } | null {
  const s = useStore.getState();
  // The shellState timeRange is read by the caller (useLiveKeys/menu) — this helper
  // covers the selection fallback so both share it.
  const clips = (s.snapshot?.tracks ?? []).flatMap((t) => t.clips).filter((c) => s.selection.has(c.id));
  if (clips.length === 0) return null;
  const start = Math.min(...clips.map((c) => c.start));
  const end = Math.max(...clips.map((c) => c.start + c.length));
  return end - start > 1e-6 ? { start, end } : null;
}

/** The whole arrangement's content span (Z's no-selection fallback in Live), or
 *  null on an empty session. */
export function contentFitSpan(): { start: number; end: number } | null {
  const s = useStore.getState();
  const clips = (s.snapshot?.tracks ?? []).flatMap((t) => t.clips);
  if (clips.length === 0) return null;
  const end = Math.max(...clips.map((c) => c.start + c.length));
  const start = Math.min(...clips.map((c) => c.start));
  return end - start > 1e-6 ? { start, end } : null;
}
