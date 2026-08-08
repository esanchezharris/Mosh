// The live shell's two arrangement rulers — Live 12's bar ruler above the lanes and
// elapsed-time ruler below them — share the gestures that v2's BarRuler deliberately
// does NOT have (its held plain drag SCRUBS). Live's idiom:
//   click          = position the playhead (seek)
//   vertical drag  = zoom, anchored at the drag point (down = zoom in, up = out)
//   Shift-drag     = time-range span (the shared RULER_RULES' LOOP_REGION)
// The click and shift-drag resolve through the SAME gesture table as every surface
// (liveGestureTable — RULER_RULES); the vertical zoom is this shell's refinement of
// the plain ruler drag, which the table maps to SEEK (v2's scrub) — documented in
// docs/live-clone/PARITY.md. Bar math is time.ts's gridLines, same as BarRuler's.

import { useRef } from "react";
import { useStore } from "../store";
import { useShell } from "../v2/shellState";
import { tempoMapFrom, gridLines, meterAt, snapStep, snapTimeMap } from "../time";
import { contentSeconds } from "../v2/timeline/geom";
import { EditorAction as EA } from "../interaction/actions";
import { resolveGesture } from "../interaction/gestures";
import { liveGestureTable } from "../interaction/config";
import { timeRulerTicks } from "./timeRuler";
import type { Snapshot } from "../types";

type RulerDrag = {
  pointerId: number;
  mode: "maybe" | "zoom" | "range";
  downY: number;
  anchorSec: number;        // time under the pointer-down (zoom anchor / click seek target)
  anchorOffsetX: number;    // pointer-down x within the ruler viewport (anchor stays put)
  startPps: number;         // pxPerSec at pointer-down — zoom factors multiply THIS
};

export function LiveRuler({ snapshot, width, onZoom, variant = "bars" }: {
  snapshot: Snapshot;
  width: number;
  variant?: "bars" | "time";
  /** Zoom to `nextPps`, keeping anchorSec stationary at anchorOffsetX in the viewport. */
  onZoom: (anchorSec: number, anchorOffsetX: number, nextPps: number) => void;
}) {
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const snap = useStore((s) => s.snap);
  const snapDivision = useStore((s) => s.snapDivision);
  const map = tempoMapFrom(snapshot.session);
  const rawTotal = contentSeconds(snapshot);
  const total = Number.isFinite(rawTotal) ? Math.max(0, rawTotal) : 0;
  const { bars } = gridLines(map, 0, total);
  // Label every bar when zoomed in, else thin out so numbers don't collide (BarRuler's rule).
  const stride = pxPerSec >= 60 ? 1 : pxPerSec >= 32 ? 2 : 4;

  const drag = useRef<RulerDrag | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    const mods = { shift: e.shiftKey, alt: e.altKey, meta: e.metaKey || e.ctrlKey };
    const tool = useStore.getState().tool;
    const table = liveGestureTable();
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = Math.max(0, (e.clientX - rect.left) / pxPerSec);

    // Shift-drag → the time-range span (same shared span the lanes paint).
    if (resolveGesture(table, { region: "ruler", gesture: "drag", mods, tool }) === EA.LOOP_REGION) {
      const sec = snap && !e.altKey ? snapTimeMap(map, raw, snapDivision) : raw;
      drag.current = { pointerId: e.pointerId, mode: "range", downY: e.clientY,
                       anchorSec: sec, anchorOffsetX: 0, startPps: pxPerSec };
      useShell.getState().setTimeRange({ start: sec, end: sec });
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
      return;
    }
    if (resolveGesture(table, { region: "ruler", gesture: "click", mods, tool }) !== EA.SEEK) return;
    const viewport = e.currentTarget.closest<HTMLElement>(".live-ruler-clip, .live-time-ruler-clip");
    const viewportRect = viewport?.getBoundingClientRect() ?? rect;
    drag.current = { pointerId: e.pointerId, mode: "maybe", downY: e.clientY,
                     anchorSec: raw, anchorOffsetX: e.clientX - viewportRect.left, startPps: pxPerSec };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.mode === "range") {
      const rect = e.currentTarget.getBoundingClientRect();
      const raw = Math.max(0, (e.clientX - rect.left) / pxPerSec);
      const cur = snap && !e.altKey ? snapTimeMap(map, raw, snapDivision) : raw;
      useShell.getState().setTimeRange({ start: Math.min(d.anchorSec, cur), end: Math.max(d.anchorSec, cur) });
      return;
    }
    // 4px of vertical travel promotes the press to a zoom drag (Live's ruler pull);
    // horizontal wobble without vertical travel stays a click.
    if (d.mode === "maybe" && Math.abs(e.clientY - d.downY) > 4) d.mode = "zoom";
    if (d.mode === "zoom")
      onZoom(d.anchorSec, d.anchorOffsetX, d.startPps * Math.exp((e.clientY - d.downY) * 0.004));
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    if (d.mode === "maybe") void exec("set_transport", { position: d.anchorSec });
    if (d.mode === "range") {
      const r = useShell.getState().timeRange;
      if (r && r.end - r.start < 1e-6) useShell.getState().setTimeRange(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const livePosition = useStore.getState().transport.position;
    const rawPosition = Number.isFinite(livePosition)
      ? livePosition
      : (snapshot.transport.position ?? 0);
    const position = Math.max(0, Math.min(total, rawPosition));
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      const step = snap ? snapStep(meterAt(map, position), snapDivision) : 1;
      const next = e.key === "Home" ? 0
        : e.key === "End" ? total
        : Math.max(0, Math.min(total, position + (e.key === "ArrowRight" ? step : -step)));
      void exec("set_transport", { position: next });
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      const viewport = e.currentTarget.closest<HTMLElement>(".live-ruler-clip, .live-time-ruler-clip");
      const anchorOffsetX = viewport
        ? Math.max(0, Math.min(viewport.clientWidth, position * pxPerSec - viewport.scrollLeft))
        : 0;
      onZoom(position, anchorOffsetX, pxPerSec * (e.key === "ArrowUp" ? 1.25 : 0.8));
    }
  };

  return (
    <div
      className={`v2-ruler live-ruler${variant === "time" ? " live-time-ruler" : ""}`}
      style={{ width }}
      data-testid={variant === "time" ? "live-time-ruler" : "live-ruler"}
      role="region"
      tabIndex={0}
      aria-label={variant === "time" ? "Arrangement elapsed-time ruler" : "Arrangement bar ruler"}
      aria-keyshortcuts="ArrowLeft ArrowRight Home End ArrowUp ArrowDown"
      title="Click to place the playhead · drag up/down to zoom · Shift-drag selects a time range · keyboard: ←/→ seek, Home/End, ↑/↓ zoom"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    >
      {variant === "bars"
        ? bars.map((b, i) => (
            <div key={b.label} className="v2-ruler-bar" style={{ left: b.sec * pxPerSec }}>
              {i % stride === 0 && <span className="v2-ruler-num">{b.label}</span>}
            </div>
          ))
        : timeRulerTicks(total, pxPerSec).map((tick) => (
            <div key={tick.seconds} className="live-time-tick" style={{ left: tick.seconds * pxPerSec }}>
              <span className="live-time-label">{tick.label}</span>
            </div>
          ))}
    </div>
  );
}
