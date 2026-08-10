import { useMemo } from "react";
import { useShell, type TimeRangeSel } from "../v2/shellState";
import { useProTools } from "./proToolsState";
import type { ProToolsEditSelectionTarget } from "./useProToolsEditSelection";

export type ProToolsTimelineSelectionModel = {
  readonly range: TimeRangeSel | null;
  readonly dragging: boolean;
  readonly setRange: (range: TimeRangeSel | null) => void;
  readonly setDragging: (dragging: boolean) => void;
  readonly target: ProToolsEditSelectionTarget;
};

export function useProToolsTimelineRange(): TimeRangeSel | null {
  const linked = useProTools((state) => state.timelineEditLinked);
  const timelineRange = useProTools((state) => state.timelineSelection);
  const editRange = useShell((state) => state.timeRange);
  return linked ? editRange : timelineRange;
}

export function useProToolsTimelineSelectionModel(): ProToolsTimelineSelectionModel {
  const linked = useProTools((state) => state.timelineEditLinked);
  const timelineRange = useProTools((state) => state.timelineSelection);
  const timelineDragging = useProTools((state) => state.timelineSelectionDragging);
  const setTimelineRange = useProTools((state) => state.setTimelineSelection);
  const setTimelineDragging = useProTools((state) => state.setTimelineSelectionDragging);
  const editRange = useShell((state) => state.timeRange);
  const editDragging = useShell((state) => state.timeRangeDragging);
  const setEditRange = useShell((state) => state.setTimeRange);
  const setEditDragging = useShell((state) => state.setTimeRangeDragging);
  const range = linked ? editRange : timelineRange;
  const dragging = linked ? editDragging : timelineDragging;
  const setRange = linked ? setEditRange : setTimelineRange;
  const setDragging = linked ? setEditDragging : setTimelineDragging;
  const target = useMemo<ProToolsEditSelectionTarget>(() => ({
    getRange: linked
      ? () => useShell.getState().timeRange
      : () => useProTools.getState().timelineSelection,
    setRange,
    setDragging,
  }), [linked, setDragging, setRange]);
  return { range, dragging, setRange, setDragging, target };
}

export function toggleProToolsTimelineEditLink(): void {
  const state = useProTools.getState();
  state.setTimelineEditLinked(!state.timelineEditLinked, useShell.getState().timeRange);
}
