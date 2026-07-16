import { playheadX, type VisibleRange } from "./timelineGeometry";

export type LaneGeometry = {
  head: HTMLDivElement | null;
  contentLeftPx: number;
  contentWidthPx: number;
  expanded: boolean;
};

export function updateLanePlayheads(
  geometries: Iterable<LaneGeometry>,
  positionSec: number,
  range: VisibleRange,
): void {
  for (const geometry of geometries) {
    if (!geometry.expanded || !geometry.head) continue;
    const contentX = playheadX(positionSec, range, geometry.contentWidthPx);
    const x = contentX === null ? null : geometry.contentLeftPx + contentX;
    geometry.head.style.visibility = x === null ? "hidden" : "visible";
    if (x !== null) geometry.head.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
  }
}

export function startLanePlayheadLoop(
  geometries: () => Iterable<LaneGeometry>,
  positionSec: () => number,
  range: () => VisibleRange,
): () => void {
  let frame = 0;
  const tick = () => {
    updateLanePlayheads(geometries(), positionSec(), range());
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}
