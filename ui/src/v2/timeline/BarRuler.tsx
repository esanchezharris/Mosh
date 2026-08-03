// The bar-number ruler. Draws bar lines + numbers from the canonical tempo map
// (time.ts gridLines) and seeks on click. Shares the seconds x-axis with the lanes.
//
// UIREACH-TIMERANGE — shift-drag defines a time-range SPAN (grid-snapped edges),
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
// GESTURE-REACH — seek and the range drag resolve through the gesture TABLE
// (`interaction/gestureTables.ts` RULER_RULES) rather than an `if (e.shiftKey)`. Every
// preset ships the SAME ruler rules, so this changes no behaviour today; what it buys is
// that the ruler stops being the one region the user's "Mouse gestures" setting cannot
// reach, and that `gestureReach.test.ts` can assert the region resolves at all instead of
// carrying it as a written exception. If a preset ever wants a different ruler idiom, it
// becomes a table edit rather than a code edit.
//
// The one honest mapping: the table's LOOP_REGION opens v2's range BAND, which is a
// superset — its toolbar turns the span into a loop, a delete, a close-gap delete or a
// re-imagine. Classic's LOOP_REGION sets the loop directly. Same gesture, richer result.
//
// WHY snapTimeMap, NEVER geom.ts's flat helpers: geom.ts derives every position from
// session.tempo alone — one number, the tempo at time zero — which is only correct
// while the tempo never changes. A project can now hold real tempo changes (the tempo
// lane, TempoRibbon.tsx), so a range edge snapped on the flat assumption drifts off the
// bar grid the moment a change exists upstream of it. time.ts's piecewise tempoMapFrom/
// snapTimeMap is the same machinery BarRuler's own bar lines and TempoRibbon already
// use — see BarRuler.test.ts for the guard that fails if this regresses to geom.ts.

import { useEffect, useRef } from "react";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { Snapshot } from "../../types";
import { tempoMapFrom, snapTimeMap, gridLines, type SnapDiv, type TempoMap } from "../../time";
import { contentSeconds } from "./geom";
import { usePointerScrub } from "./usePointerScrub";
import { EditorAction as EA } from "../../interaction/actions";
import { resolveGesture } from "../../interaction/gestures";
import { liveGestureTable } from "../../interaction/config";

const capturePointer = (element: HTMLElement, pointerId: number) => {
  if (typeof element.setPointerCapture !== "function") return;
  try {
    element.setPointerCapture(pointerId);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
};

const releasePointer = (element: HTMLElement, pointerId: number) => {
  if (typeof element.releasePointerCapture !== "function") return;
  try {
    element.releasePointerCapture(pointerId);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
};

/** Pixel-x within the ruler -> active-grid seconds, via the PIECEWISE tempo map.
 *  Exported so BarRuler.test.ts can pin this against the flat geom.ts helpers without
 *  driving a full pointer gesture through jsdom. */
export function snappedSecAt(
  map: TempoMap,
  pxPerSec: number,
  clientX: number,
  rectLeft: number,
  division: SnapDiv = "bar",
  snap = true,
  bypass = false,
): number {
  const raw = Math.max(0, (clientX - rectLeft) / Math.max(1e-6, pxPerSec));
  return snap && !bypass ? snapTimeMap(map, raw, division) : raw;
}

export function BarRuler({ snapshot, width }: { snapshot: Snapshot; width: number }) {
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const snap = useStore((s) => s.snap);
  const snapDivision = useStore((s) => s.snapDivision);
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
  const rangePointer = useRef<number | null>(null);
  const rangeElement = useRef<HTMLDivElement | null>(null);
  const scrub = usePointerScrub((position) => {
    void exec("set_transport", { position });
  });
  useEffect(() => () => {
    const pointerId = rangePointer.current;
    if (pointerId == null) return;
    if (rangeElement.current) releasePointer(rangeElement.current, pointerId);
    anchor.current = null;
    rangePointer.current = null;
    rangeElement.current = null;
    setTimeRangeDragging(false);
    const r = useShell.getState().timeRange;
    if (r && r.end - r.start < 1e-6) setTimeRange(null);
  }, [setTimeRange, setTimeRangeDragging]);
  const positionAt = (element: HTMLDivElement, clientX: number) => {
    const rect = element.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / pxPerSec);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (rangePointer.current != null || scrub.isActive()) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mods = { shift: e.shiftKey, alt: e.altKey, meta: e.metaKey || e.ctrlKey };
    const tool = useStore.getState().tool;
    const dragAction = resolveGesture(liveGestureTable(), { region: "ruler", gesture: "drag", mods, tool });
    if (dragAction === EA.LOOP_REGION) {
      const sec = snappedSecAt(map, pxPerSec, e.clientX, rect.left, snapDivision, snap, e.altKey);
      anchor.current = sec;
      rangePointer.current = e.pointerId;
      rangeElement.current = e.currentTarget;
      setTimeRangeDragging(true);
      setTimeRange({ start: sec, end: sec });
      capturePointer(e.currentTarget, e.pointerId);
      return;
    }
    // Plain press: SEEK. v2 additionally SCRUBS while held (#517 — a held drag used to
    // emit a single seek), which the table has no rule for because a scrub is a
    // continuous refinement of the same seek, not a second action.
    if (resolveGesture(liveGestureTable(), { region: "ruler", gesture: "click", mods, tool }) !== EA.SEEK) return;
    scrub.begin(e.currentTarget, e.pointerId, positionAt(e.currentTarget, e.clientX));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (anchor.current != null) {
      if (rangePointer.current !== e.pointerId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const sec = snappedSecAt(map, pxPerSec, e.clientX, rect.left, snapDivision, snap, e.altKey);
      setTimeRange({ start: Math.min(anchor.current, sec), end: Math.max(anchor.current, sec) });
      return;
    }
    scrub.move(
      e.pointerId,
      positionAt(e.currentTarget, e.clientX),
    );
  };

  const endRangeDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (anchor.current == null || rangePointer.current !== e.pointerId) return false;
    anchor.current = null;
    rangePointer.current = null;
    rangeElement.current = null;
    setTimeRangeDragging(false);
    releasePointer(e.currentTarget, e.pointerId);
    // A shift-press with no real movement leaves a zero-width span — treat it as no
    // selection at all, matching classic's identical range-tool idiom.
    const r = useShell.getState().timeRange;
    if (r && r.end - r.start < 1e-6) setTimeRange(null);
    return true;
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (anchor.current != null) {
      endRangeDrag(e);
      return;
    }
    scrub.end(e.currentTarget, e.pointerId, positionAt(e.currentTarget, e.clientX));
  };
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (anchor.current != null) {
      endRangeDrag(e);
      return;
    }
    scrub.cancel(e.currentTarget, e.pointerId);
  };

  return (
    <div
      className="v2-ruler" style={{ width }} data-testid="v2-ruler"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      title="Click or drag to scrub — Shift-drag selects a snapped time range; hold Option to bypass snap"
    >
      {bars.map((b, i) => (
        <div key={b.label} className="v2-ruler-bar" style={{ left: b.sec * pxPerSec }}>
          {i % stride === 0 && <span className="v2-ruler-num">{b.label}</span>}
        </div>
      ))}
    </div>
  );
}
