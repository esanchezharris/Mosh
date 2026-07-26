// The bar-number ruler. Draws bar lines + numbers from the canonical tempo map
// (time.ts gridLines) and seeks on click. Shares the seconds x-axis with the lanes.
//
// UIREACH-TIMERANGE — shift-drag defines a time-range SPAN (bar-snapped both edges),
// held UI-local in shellState and rendered as a cross-lane band by TimeRangeBand. This
// is the only way a mouse-only v2 user can reach delete_time_range: the command has
// existed since ARR-011 with full mock/native parity, but no shell — classic included —
// ever wired an actual delete action to the range it can already draw (classic's
// Arrange.tsx range tool paints the band and nothing else; see its own "on demand"
// comment). Plain click still seeks — decided at POINTERDOWN, not by racing a click
// handler afterwards, so a held Shift never has to out-run a stray seek. That mirrors
// classic's onRulerDown, which resolves seek-vs-loop-region the same way at the same
// event for the same reason.
//
// WHY snapTimeMap, NEVER geom.ts's flat helpers: geom.ts derives every position from
// session.tempo alone — one number, the tempo at time zero — which is only correct
// while the tempo never changes. A project can now hold real tempo changes (the tempo
// lane, TempoRibbon.tsx), so a range edge snapped on the flat assumption drifts off the
// bar grid the moment a change exists upstream of it. time.ts's piecewise tempoMapFrom/
// snapTimeMap is the same machinery BarRuler's own bar lines and TempoRibbon already
// use — see BarRuler.test.ts for the guard that fails if this regresses to geom.ts.

import { useRef } from "react";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { Snapshot } from "../../types";
import { tempoMapFrom, snapTimeMap, gridLines, type TempoMap } from "../../time";
import { contentSeconds } from "./geom";

const capturePointer = (el: Element, id: number) => { try { (el as HTMLElement).setPointerCapture(id); } catch { /* no-op */ } };
const releasePointer = (el: Element, id: number) => { try { (el as HTMLElement).releasePointerCapture(id); } catch { /* no-op */ } };

/** Pixel-x within the ruler -> bar-snapped seconds, via the PIECEWISE tempo map.
 *  Exported so BarRuler.test.ts can pin this against the flat geom.ts helpers without
 *  driving a full pointer gesture through jsdom. */
export function snappedSecAt(map: TempoMap, pxPerSec: number, clientX: number, rectLeft: number): number {
  const raw = Math.max(0, (clientX - rectLeft) / Math.max(1e-6, pxPerSec));
  return snapTimeMap(map, raw, "bar");
}

export function BarRuler({ snapshot, width }: { snapshot: Snapshot; width: number }) {
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const setTimeRange = useShell((s) => s.setTimeRange);
  const setTimeRangeDragging = useShell((s) => s.setTimeRangeDragging);
  const map = tempoMapFrom(snapshot.session);
  const total = contentSeconds(snapshot);
  const { bars } = gridLines(map, 0, total);
  // Label every bar when zoomed in, else thin out so numbers don't collide.
  const stride = pxPerSec >= 60 ? 1 : pxPerSec >= 32 ? 2 : 4;

  // Anchor of an in-progress range drag (seconds, already bar-snapped). null between
  // gestures, and while a plain (non-shift) press is just seeking.
  const anchor = useRef<number | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.shiftKey) {
      const sec = snappedSecAt(map, pxPerSec, e.clientX, rect.left);
      anchor.current = sec;
      setTimeRangeDragging(true);
      setTimeRange({ start: sec, end: sec });
      capturePointer(e.currentTarget, e.pointerId);
      return;
    }
    // Plain press: seek immediately, exactly like classic's onRulerDown — deciding at
    // pointerdown means there is no click-vs-drag race to referee afterwards.
    const sec = Math.max(0, (e.clientX - rect.left) / pxPerSec);
    void exec("set_transport", { position: sec });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (anchor.current == null || e.buttons === 0) return; // stray hover after a lost/cancelled capture
    const rect = e.currentTarget.getBoundingClientRect();
    const sec = snappedSecAt(map, pxPerSec, e.clientX, rect.left);
    setTimeRange({ start: Math.min(anchor.current, sec), end: Math.max(anchor.current, sec) });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (anchor.current == null) return;
    anchor.current = null;
    setTimeRangeDragging(false);
    releasePointer(e.currentTarget, e.pointerId);
    // A shift-press with no real movement leaves a zero-width span — treat it as no
    // selection at all, matching classic's identical range-tool idiom.
    const r = useShell.getState().timeRange;
    if (r && r.end - r.start < 1e-6) setTimeRange(null);
  };

  return (
    <div
      className="v2-ruler" style={{ width }} data-testid="v2-ruler"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={endDrag} onPointerCancel={endDrag}
      title="Click to seek — shift-drag to select a time range"
    >
      {bars.map((b, i) => (
        <div key={b.label} className="v2-ruler-bar" style={{ left: b.sec * pxPerSec }}>
          {i % stride === 0 && <span className="v2-ruler-num">{b.label}</span>}
        </div>
      ))}
    </div>
  );
}
