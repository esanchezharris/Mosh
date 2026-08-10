import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { proToolsEditableLaneTarget, proToolsLaneTarget } from "./proToolsLaneTarget";
import { useProTools } from "./proToolsState";
import {
  scopeProToolsEditSelectionToTrack,
  scopeProToolsEditSelectionToTracks,
} from "./proToolsTrackEditSelection";

type SelectionDrag = {
  readonly pointerId: number;
  readonly epoch: number;
  readonly anchorTrackId: string;
  readonly previousEditTrackId: string | null;
  readonly previousEditTrackIds: readonly string[];
  readonly previousTrackSelectionIds: readonly string[];
  readonly previousSelectedTrackId: string | null;
};

type SelectionHandlers = {
  readonly onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerMoveCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerUpCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancelCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
};

function trackAtY(lanes: readonly HTMLElement[], clientY: number): HTMLElement | null {
  const first = lanes[0];
  const last = lanes.at(-1);
  if (!first || !last) return null;
  if (clientY <= first.getBoundingClientRect().top) return first;
  if (clientY >= last.getBoundingClientRect().bottom) return last;
  return lanes.find((lane) => {
    const rect = lane.getBoundingClientRect();
    return clientY >= rect.top && clientY <= rect.bottom;
  }) ?? null;
}

export function useProToolsMultiTrackSelection(): SelectionHandlers {
  const projectEpoch = useStore((state) => state.projectEpoch);
  const smartToolEnabled = useProTools((state) => state.smartToolEnabled);
  const activeTool = useProTools((state) => state.activeTool);
  const drag = useRef<SelectionDrag | null>(null);
  const selectorEnabled = smartToolEnabled || activeTool === "selector";

  useEffect(() => {
    drag.current = null;
  }, [projectEpoch]);

  const onPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const lane = proToolsLaneTarget(event.target);
    const trackId = lane?.dataset.trackId;
    if (!trackId) return;
    const proTools = useProTools.getState();
    const prior: SelectionDrag = {
      pointerId: event.pointerId,
      epoch: useStore.getState().projectEpoch,
      anchorTrackId: trackId,
      previousEditTrackId: proTools.editSelectionTrackId,
      previousEditTrackIds: [...proTools.editSelectionTrackIds],
      previousTrackSelectionIds: [...proTools.trackSelectionIds],
      previousSelectedTrackId: useStore.getState().selectedTrackId,
    };
    scopeProToolsEditSelectionToTrack(trackId);
    drag.current = selectorEnabled && proToolsEditableLaneTarget(event.target) ? prior : null;
  };

  const onPointerMoveCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || !(event.buttons & 1)) return;
    if (current.epoch !== useStore.getState().projectEpoch) {
      drag.current = null;
      return;
    }
    const lanes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      ".pt-timeline-content .pt-lane[data-track-id]",
    ));
    const focusLane = trackAtY(lanes, event.clientY);
    const focusTrackId = focusLane?.dataset.trackId;
    const anchorIndex = lanes.findIndex((lane) => lane.dataset.trackId === current.anchorTrackId);
    const focusIndex = focusLane ? lanes.indexOf(focusLane) : -1;
    if (!focusTrackId || anchorIndex < 0 || focusIndex < 0) return;
    const start = Math.min(anchorIndex, focusIndex);
    const end = Math.max(anchorIndex, focusIndex);
    const trackIds = lanes.slice(start, end + 1)
      .map((lane) => lane.dataset.trackId)
      .filter((trackId): trackId is string => Boolean(trackId));
    scopeProToolsEditSelectionToTracks(trackIds, focusTrackId);
  };

  const onPointerUpCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  const onPointerCancelCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (current.epoch !== useStore.getState().projectEpoch) return;
    const proTools = useProTools.getState();
    proTools.setEditSelectionTracks(current.previousEditTrackIds, current.previousEditTrackId);
    proTools.setTrackSelectionIds(current.previousTrackSelectionIds);
    useStore.getState().setSelectedTrack(current.previousSelectedTrackId);
  };

  return {
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
  };
}
