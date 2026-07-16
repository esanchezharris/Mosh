export type LaneLayout = {
  readonly mode: "fill-all" | "accordion";
  readonly expandedTrackIds: readonly string[];
  readonly heightsPx: readonly number[];
  readonly usedHeightPx: number;
};

const COMPACT_HEIGHT_PX = 60;
const MIN_EDITOR_HEIGHT_PX = 116;
const MAX_EDITOR_HEIGHT_PX = 190;
const LANE_GAP_PX = 8;

export function computeLaneLayout(
  trackIds: readonly string[],
  availableHeightPx: number,
  focusIndex: number,
): LaneLayout {
  const count = trackIds.length;
  if (count === 0) {
    return { mode: "fill-all", expandedTrackIds: [], heightsPx: [], usedHeightPx: 0 };
  }

  const gapsPx = Math.max(0, count - 1) * LANE_GAP_PX;
  const contentHeightPx = Math.max(0, availableHeightPx - gapsPx);
  if (count * MIN_EDITOR_HEIGHT_PX + gapsPx <= availableHeightPx) {
    const laneHeightPx = Math.min(MAX_EDITOR_HEIGHT_PX, Math.floor(contentHeightPx / count));
    const heightsPx = trackIds.map(() => laneHeightPx);
    return {
      mode: "fill-all",
      expandedTrackIds: [...trackIds],
      heightsPx,
      usedHeightPx: laneHeightPx * count + gapsPx,
    };
  }

  const focusedIndex = Math.max(0, Math.min(count - 1, focusIndex));
  const compactTotalPx = Math.max(0, count - 1) * COMPACT_HEIGHT_PX;
  const editorHeightPx = Math.min(
    MAX_EDITOR_HEIGHT_PX,
    Math.max(MIN_EDITOR_HEIGHT_PX, availableHeightPx - gapsPx - compactTotalPx),
  );
  const heightsPx = trackIds.map((_, index) => index === focusedIndex ? editorHeightPx : COMPACT_HEIGHT_PX);
  return {
    mode: "accordion",
    expandedTrackIds: [trackIds[focusedIndex]],
    heightsPx,
    usedHeightPx: heightsPx.reduce((sum, height) => sum + height, 0) + gapsPx,
  };
}
