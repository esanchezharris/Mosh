import { useCallback } from "react";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useStore } from "../store";
import { useShell } from "../v2/shellState";

const formatSecond = (seconds: number): string => `${seconds.toFixed(3)} s`;

export function ProToolsEditSelectionOverlay() {
  const pxPerSecond = useStore((state) => state.pxPerSec);
  const range = useShell((state) => state.timeRange);
  const dragging = useShell((state) => state.timeRangeDragging);
  const setRange = useShell((state) => state.setTimeRange);
  const active = Boolean(range && range.end > range.start);
  useEscapeToClose(active, useCallback(() => setRange(null), [setRange]));

  if (!range || range.end <= range.start) return null;
  return (
    <div className="pt-edit-selection" data-testid="pt-edit-selection"
      data-dragging={dragging}
      role="status"
      aria-label={`Edit selection ${formatSecond(range.start)} to ${formatSecond(range.end)}`}
      style={{
        left: range.start * pxPerSecond,
        width: Math.max(2, (range.end - range.start) * pxPerSecond),
      }}>
      <span className="pt-edit-selection-start" aria-hidden="true">EDIT IN</span>
      <span className="pt-edit-selection-end" aria-hidden="true">OUT</span>
    </div>
  );
}
