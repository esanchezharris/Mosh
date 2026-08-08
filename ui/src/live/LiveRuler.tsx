// The live shell's bar ruler — Live 12's beat-time-ruler gestures, which v2's shared
// BarRuler deliberately does NOT have (its held plain drag SCRUBS). Live's idiom:
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
import { tempoMapFrom, gridLines, snapTimeMap } from "../time";
import { contentSeconds } from "../v2/timeline/geom";
import { EditorAction as EA } from "../interaction/actions";
import { resolveGesture } from "../interaction/gestures";
import { liveGestureTable } from "../interaction/config";
import type { Snapshot } from "../types";

type RulerDrag = {
  pointerId: number;
  mode: "maybe" | "zoom" | "range";
  downY: number;
  anchorSec: number;        // time under the pointer-down (zoom anchor / click seek target)
  anchorOffsetX: number;    // pointer-down x within the ruler viewport (anchor stays put)
  startPps: number;         // pxPerSec at pointer-down — zoom factors multiply THIS
};

export function LiveRuler({ snapshot, width, onZoom }: {
  snapshot: Snapshot;
  width: number;
  /** Zoom to `nextPps`, keeping anchorSec stationary at anchorOffsetX in the viewport. */
  onZoom: (anchorSec: number, anchorOffsetX: number, nextPps: number) => void;
}) {
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const snap = useStore((s) => s.snap);
  const snapDivision = useStore((s) => s.snapDivision);
  const map = tempoMapFrom(snapshot.session);
  const total = contentSeconds(snapshot);
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
    drag.current = { pointerId: e.pointerId, mode: "maybe", downY: e.clientY,
                     anchorSec: raw, anchorOffsetX: e.clientX - rect.left, startPps: pxPerSec };
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

  return (
    <div
      className="v2-ruler live-ruler"
      style={{ width }}
      data-testid="live-ruler"
      title="Click to place the playhead · drag up/down to zoom · Shift-drag selects a time range"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    >
      {bars.map((b, i) => (
        <div key={b.label} className="v2-ruler-bar" style={{ left: b.sec * pxPerSec }}>
          {i % stride === 0 && <span className="v2-ruler-num">{b.label}</span>}
        </div>
      ))}
    </div>
  );
}
