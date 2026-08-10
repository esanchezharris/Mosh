import type { ProToolsRuler } from "./proToolsState";
import { useProToolsTimelineSelectionModel } from "./proToolsTimelineSelection";

type Props = {
  readonly visibleRulers: readonly ProToolsRuler[];
  readonly pxPerSecond: number;
  readonly recordArmed: boolean;
};

export function ProToolsRulerSelectionOverlay({
  visibleRulers,
  pxPerSecond,
  recordArmed,
}: Props) {
  const { range, dragging } = useProToolsTimelineSelectionModel();
  const barsBeatsIndex = visibleRulers.indexOf("barsBeats");
  const firstTimebaseIndex = visibleRulers.findIndex((ruler) => ruler !== "markers");
  const mainRulerIndex = barsBeatsIndex >= 0 ? barsBeatsIndex : firstTimebaseIndex;

  if (!range || range.end <= range.start || mainRulerIndex < 0) return null;
  return (
    <div className={`pt-ruler-selection${recordArmed ? " is-record-armed" : ""}`}
      data-testid="pt-ruler-selection"
      data-dragging={dragging}
      aria-hidden="true"
      style={{
        top: `calc(${mainRulerIndex} * var(--pt-ruler-row-h))`,
        left: range.start * pxPerSecond,
        width: Math.max(2, (range.end - range.start) * pxPerSecond),
      }}>
      <span className="pt-ruler-selection-start" />
      <span className="pt-ruler-selection-end" />
    </div>
  );
}
