// Empty-lane pointer gestures for the v2 arrangement: MARQUEE, DESELECT and TIME_SELECT.
//
// These three are declared in `ui/src/interaction/gestureTables.ts` (the `empty` region of
// every DAW preset) and, until this module, were implemented ONLY in the classic shell.
// v2 had no empty-lane pointer surface at all, so a producer on the shipped shell could
// not select more than one clip with the mouse, could not clear a selection by clicking
// away, and got nothing from the Range tool. `gestureReach.test.ts` is the guard that
// makes that class of gap visible; this closes its three entries.
//
// Ported from `ui/src/ui/Arrange.tsx`'s `onLanesDown/Move/Up` rather than imported: v2
// deliberately does not pull Arrange.tsx into its module graph (PR #500 pins that), and
// v2's lanes are a CSS grid of per-track rows, not classic's single lanes element — the
// measurement differs even though the rule does not. The RULE lives in `marqueeHit.ts`,
// which both could share.

import { useCallback, useRef, useState } from "react";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import { EditorAction as EA } from "../../interaction/actions";
import { resolveGesture } from "../../interaction/gestures";
import { liveGestureTable } from "../../interaction/config";
import { headW } from "../timeline/geom";
import { isDrag, marqueeHits, type ClipBox, type LaneBox, type MarqueeRect } from "./marqueeHit";

/** Measure lane rows and clips from the DOM, in the timeline grid's own coordinate space.
 *  Reading layout back rather than recomputing it keeps the hit-test honest when CSS
 *  changes a lane height — the alternative is a second copy of the grid maths that drifts. */
function measure(tl: HTMLElement): { lanes: LaneBox[]; clips: ClipBox[] } {
  const base = tl.getBoundingClientRect();
  const lanes: LaneBox[] = [];
  const clips: ClipBox[] = [];
  for (const el of Array.from(tl.querySelectorAll<HTMLElement>(".v2-lane[data-track-id]"))) {
    const trackId = el.dataset.trackId!;
    const r = el.getBoundingClientRect();
    lanes.push({ trackId, top: r.top - base.top, bottom: r.bottom - base.top });
    for (const c of Array.from(el.querySelectorAll<HTMLElement>("[data-clip-id]"))) {
      const cr = c.getBoundingClientRect();
      clips.push({
        id: c.dataset.clipId!,
        trackId,
        left: cr.left - base.left - headW(),
        right: cr.right - base.left - headW(),
      });
    }
  }
  return { lanes, clips };
}

export interface LaneMarquee {
  /** Non-null while a lasso is in flight; the overlay renders from this. */
  rect: MarqueeRect | null;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
}

export function useLaneMarquee(tlRef: React.RefObject<HTMLDivElement | null>): LaneMarquee {
  const [rect, setRect] = useState<MarqueeRect | null>(null);
  // The range-tool anchor, in seconds. Separate from `rect` because TIME_SELECT paints
  // the existing TimeRangeBand rather than a lasso box.
  const rangeAnchor = useRef<number | null>(null);

  const pointAt = (e: React.PointerEvent<HTMLDivElement>, tl: HTMLElement) => {
    const base = tl.getBoundingClientRect();
    return { x: e.clientX - base.left - headW(), y: e.clientY - base.top };
  };

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;                       // right-click opens a context menu
    const tl = tlRef.current;
    if (!tl) return;
    const target = e.target as HTMLElement;
    // Only EMPTY lane space. A clip handles its own pointerdown; the ruler, ribbon,
    // tempo and annotation rows own theirs; the trailing add-row is not a track.
    if (!target.closest(".v2-lane[data-track-id]")) return;
    if (target.closest("[data-clip-id]")) return;

    const { x, y } = pointAt(e, tl);
    const st = useStore.getState();
    // Resolve through the gesture TABLE rather than hardcoding `tool === "range"`.
    // Two reasons, both load-bearing: it is what makes the user's "Mouse gestures" DAW
    // setting real for this region (every preset agrees on empty-drag = MARQUEE and
    // empty-click = DESELECT; only Mosh adds the range-tool TIME_SELECT rule), and it is
    // what lets `gestureReach.test.ts` see that these actions are implemented at all —
    // an implementation that never names the action is invisible to that guard.
    const action = resolveGesture(liveGestureTable(), {
      region: "empty",
      gesture: "drag",
      mods: { shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey },
      tool: st.tool,
    });
    if (action === EA.TIME_SELECT) {
      // The Range tool's whole reason to exist. Before this it set store.tool and
      // nothing else, so pressing `3` changed a mode with no observable effect.
      const sec = st.snapTime(Math.max(0, x / st.pxPerSec));
      rangeAnchor.current = sec;
      // v2's time range lives in shellState, NOT the classic store: TimeRangeBand and
      // BarRuler both read useShell. Writing to useStore.timeRange here set a value
      // nothing renders — caught only by driving a real browser, because the pure and
      // jsdom layers never render the band at all.
      useShell.getState().setTimeRange({ start: sec, end: sec });
      useShell.getState().setTimeRangeDragging(true);
    } else if (action === EA.MARQUEE) {
      setRect({ x0: x, y0: y, x1: x, y1: y });
    } else {
      return;   // no rule for this preset+tool: leave the pointer alone entirely
    }
    tl.setPointerCapture?.(e.pointerId);
  }, [tlRef]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 0) return;   // stray hover after a lost capture
    const tl = tlRef.current;
    if (!tl) return;
    const { x, y } = pointAt(e, tl);
    if (rangeAnchor.current != null) {
      const st = useStore.getState();
      const sec = st.snapTime(Math.max(0, x / st.pxPerSec));
      useShell.getState().setTimeRange({
        start: Math.min(rangeAnchor.current, sec),
        end: Math.max(rangeAnchor.current, sec),
      });
      return;
    }
    setRect((r) => (r ? { ...r, x1: x, y1: y } : r));
  }, [tlRef]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const tl = tlRef.current;
    tl?.releasePointerCapture?.(e.pointerId);
    if (rangeAnchor.current != null) {
      rangeAnchor.current = null;
      useShell.getState().setTimeRangeDragging(false);
      const r = useShell.getState().timeRange;
      if (r && r.end - r.start < 1e-6) useShell.getState().setTimeRange(null);
      return;
    }
    const r = rect;
    setRect(null);
    if (!r || !tl) return;
    const st = useStore.getState();
    if (!isDrag(r)) {
      // A click on empty space, not a lasso. Committed on UP rather than DOWN on
      // purpose: clearing on down would wipe the selection at the start of every lasso,
      // so a marquee could never be additive later.
      const click = resolveGesture(liveGestureTable(), {
        region: "empty",
        gesture: "click",
        mods: { shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey },
        tool: st.tool,
      });
      if (click === EA.DESELECT) st.clearSelection();
      return;
    }
    const { lanes, clips } = measure(tl);
    // Shift/Cmd extends, matching the clip's own additive-select modifiers.
    st.select(marqueeHits(r, lanes, clips), e.shiftKey || e.metaKey);
  }, [rect, tlRef]);

  const onPointerCancel = useCallback(() => {
    // Abort, never commit: a cancelled drag must not select anything or leave a box stuck.
    rangeAnchor.current = null;
    setRect(null);
    useShell.getState().setTimeRangeDragging(false);
    const r = useShell.getState().timeRange;
    if (r && r.end - r.start < 1e-6) useShell.getState().setTimeRange(null);
  }, []);

  return { rect, onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
