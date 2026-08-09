import { useCallback, useEffect, useRef } from "react";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { ProToolsClipList } from "./ProToolsClipList";
import { ProToolsRulers } from "./ProToolsRulers";
import { ProToolsTimeline } from "./ProToolsTimeline";
import { ProToolsTrackHeaders } from "./ProToolsTrackHeaders";
import { timelineSeconds } from "./layout";
import { useProTools } from "./proToolsState";

const capturePointer = (element: HTMLElement, pointerId: number): void => {
  if (typeof element.setPointerCapture !== "function") return;
  try {
    element.setPointerCapture(pointerId);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
};

const releasePointer = (element: HTMLElement, pointerId: number): void => {
  if (typeof element.releasePointerCapture !== "function") return;
  try {
    element.releasePointerCapture(pointerId);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
};

export function ProToolsArrangement({ snapshot }: { snapshot: Snapshot }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const trackHeaderWidth = useProTools((s) => s.trackHeaderWidth);
  const setTrackHeaderWidth = useProTools((s) => s.setTrackHeaderWidth);
  const rulersVisible = useProTools((s) => s.rulersVisible);
  const clipListOpen = useProTools((s) => s.clipListOpen);
  const setClipListOpen = useProTools((s) => s.setClipListOpen);
  const contentWidth = Math.max(960, timelineSeconds(snapshot) * pxPerSec);
  const timelineRef = useRef<HTMLDivElement>(null);
  const rulerFieldRef = useRef<HTMLDivElement>(null);
  const headerPaneRef = useRef<HTMLDivElement>(null);
  const resize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const compactQuery = window.matchMedia("(max-width: 760px)");
    const closeOnCompact = () => {
      if (compactQuery.matches) setClipListOpen(false);
    };
    closeOnCompact();
    compactQuery.addEventListener("change", closeOnCompact);
    return () => compactQuery.removeEventListener("change", closeOnCompact);
  }, [setClipListOpen]);

  const syncScroll = useCallback(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    if (rulerFieldRef.current)
      rulerFieldRef.current.style.transform = `translate3d(${-timeline.scrollLeft}px, 0, 0)`;
    const rows = headerPaneRef.current?.querySelector<HTMLElement>(".pt-track-list-rows");
    if (rows) rows.style.transform = `translate3d(0, ${-timeline.scrollTop}px, 0)`;
  }, []);

  return (
    <section className="pt-edit-window" data-testid="pt-edit-window"
      style={{ "--pt-track-head-w": `${trackHeaderWidth}px` } as React.CSSProperties}>
      <div className="pt-arrangement-main">
        <ProToolsRulers snapshot={snapshot} rulersVisible={rulersVisible}
          contentWidth={contentWidth} fieldRef={rulerFieldRef}
          getScrollLeft={() => timelineRef.current?.scrollLeft ?? 0} />
        <div className="pt-edit-body">
          <div ref={headerPaneRef} className="pt-track-header-pane">
            <ProToolsTrackHeaders snapshot={snapshot} />
          </div>
          <ProToolsTimeline snapshot={snapshot} contentWidth={contentWidth}
            scrollRef={timelineRef} onScroll={syncScroll} />
          <div className="pt-track-head-resizer" data-testid="pt-track-head-resizer"
            role="separator" aria-orientation="vertical" aria-label="Resize track headers"
            aria-valuemin={128} aria-valuemax={280} aria-valuenow={trackHeaderWidth}
            tabIndex={0}
            onDoubleClick={() => setTrackHeaderWidth(160)}
            onPointerDown={(e) => {
              resize.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startWidth: trackHeaderWidth,
              };
              capturePointer(e.currentTarget, e.pointerId);
            }}
            onPointerMove={(e) => {
              const current = resize.current;
              if (!current || current.pointerId !== e.pointerId) return;
              setTrackHeaderWidth(current.startWidth + e.clientX - current.startX);
            }}
            onPointerUp={(e) => {
              resize.current = null;
              releasePointer(e.currentTarget, e.pointerId);
            }}
            onPointerCancel={(e) => {
              resize.current = null;
              releasePointer(e.currentTarget, e.pointerId);
            }}
            onKeyDown={(e) => {
              const delta = e.key === "ArrowRight" ? 8 : e.key === "ArrowLeft" ? -8 : 0;
              if (!delta) return;
              e.preventDefault(); e.stopPropagation();
              setTrackHeaderWidth(trackHeaderWidth + delta);
            }} />
        </div>
      </div>
      <ProToolsClipList snapshot={snapshot} open={clipListOpen} onOpenChange={setClipListOpen} />
    </section>
  );
}
