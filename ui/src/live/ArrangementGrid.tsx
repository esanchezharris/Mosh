import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import {
  SNAP_DIVISIONS,
  meterAt,
  snapStep,
  tempoMapFrom,
  type SnapDiv,
} from "../time";
import { contentSeconds } from "../v2/timeline/geom";
import { arrangementGridLines } from "./arrangementGridModel";
import type { Snapshot } from "../types";

type GridMetrics = {
  readonly scrollLeft: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
};

const EMPTY_METRICS: GridMetrics = {
  scrollLeft: 0,
  viewportWidth: 0,
  viewportHeight: 0,
  contentHeight: 0,
};

const MIN_PAINT_SPACING_PX = 2;

export function ArrangementGrid({ snapshot }: { readonly snapshot: Snapshot }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<GridMetrics>(EMPTY_METRICS);
  const pxPerSec = useStore((state) => state.pxPerSec);
  const division = useStore((state) => state.snapAuto ? state.effectiveSnapDivision() : state.snapDivision);
  const triplet = useStore((state) => state.snapTriplet);
  const map = useMemo(() => tempoMapFrom(snapshot.session), [snapshot.session]);
  const contentWidth = contentSeconds(snapshot) * pxPerSec;
  const paintWidth = Math.max(contentWidth, metrics.viewportWidth);
  const paintHeight = Math.max(metrics.contentHeight, metrics.viewportHeight);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const content = host?.parentElement;
    const scroller = content?.closest<HTMLElement>(".live-lanes-scroll");
    if (!content || !scroller) return;

    const measure = () => {
      const next: GridMetrics = {
        scrollLeft: scroller.scrollLeft,
        viewportWidth: scroller.clientWidth,
        viewportHeight: scroller.clientHeight,
        contentHeight: content.clientHeight,
      };
      setMetrics((current) => (
        current.scrollLeft === next.scrollLeft
        && current.viewportWidth === next.viewportWidth
        && current.viewportHeight === next.viewportHeight
        && current.contentHeight === next.contentHeight
          ? current
          : next
      ));
    };

    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(content);
    return () => {
      scroller.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  const bufferWidth = metrics.viewportWidth;
  const fromSec = Math.max(0, (metrics.scrollLeft - bufferWidth) / pxPerSec);
  const toSec = Math.min(paintWidth / pxPerSec, (metrics.scrollLeft + metrics.viewportWidth + bufferWidth) / pxPerSec);
  const sampleTimes = [fromSec];
  for (const segment of map) {
    if (segment.startSec > fromSec && segment.startSec < toSec) sampleTimes.push(segment.startSec);
  }
  let paintDivision: SnapDiv = division;
  for (let index = SNAP_DIVISIONS.indexOf(division); index >= 0; index -= 1) {
    const candidate = SNAP_DIVISIONS[index];
    if (!candidate) continue;
    const multiplier = triplet ? 2 / 3 : 1;
    paintDivision = candidate;
    if (sampleTimes.every((sec) => snapStep(meterAt(map, sec), candidate) * multiplier * pxPerSec >= MIN_PAINT_SPACING_PX)) break;
  }
  const lines = arrangementGridLines(map, fromSec, toSec, paintDivision, triplet);

  return (
    <div
      ref={hostRef}
      className="live-arrangement-grid"
      data-testid="live-arrangement-grid"
      aria-hidden="true"
      style={{ width: paintWidth, height: paintHeight }}
    >
      {lines.map((line) => (
        <i
          key={`${line.kind}-${line.sec}`}
          className={`live-grid-line ${line.kind}`}
          data-testid="live-grid-line"
          data-grid-kind={line.kind}
          data-grid-seconds={line.sec}
          style={{ left: line.sec * pxPerSec }}
        />
      ))}
    </div>
  );
}
