import { useCallback, useMemo } from "react";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { useShell } from "../v2/shellState";
import { useProTools } from "./proToolsState";
import { proToolsTrackRowHeight } from "./trackViews";

const formatSecond = (seconds: number): string => `${seconds.toFixed(3)} s`;

export function ProToolsEditSelectionOverlay({ snapshot }: { readonly snapshot: Snapshot }) {
  const pxPerSecond = useStore((state) => state.pxPerSec);
  const selectedTrackId = useStore((state) => state.selectedTrackId);
  const range = useShell((state) => state.timeRange);
  const dragging = useShell((state) => state.timeRangeDragging);
  const setRange = useShell((state) => state.setTimeRange);
  const trackEditLinked = useProTools((state) => state.trackEditLinked);
  const editSelectionTrackId = useProTools((state) => state.editSelectionTrackId);
  const trackViews = useProTools((state) => state.trackViews);
  const automationLanesVisible = useProTools((state) => state.automationLanesVisible);
  const trackHeightScale = useProTools((state) => state.trackHeightScale);
  const geometry = useMemo(() => {
    const tracks = snapshot.tracks.filter((track) => !track.isGroup && !track.isReturn);
    const requestedTrackId = trackEditLinked
      ? selectedTrackId ?? editSelectionTrackId
      : editSelectionTrackId ?? selectedTrackId;
    let trackId: string | null = null;
    if (requestedTrackId && tracks.some((track) => track.id === requestedTrackId)) {
      trackId = requestedTrackId;
    } else if (selectedTrackId && tracks.some((track) => track.id === selectedTrackId)) {
      trackId = selectedTrackId;
    }
    if (!trackId) return null;
    let top = 0;
    for (const track of tracks) {
      const height = proToolsTrackRowHeight(
        track,
        trackViews[track.id],
        Boolean(automationLanesVisible[track.id]),
        trackHeightScale,
      );
      if (track.id === trackId) return { trackId, top, height };
      top += height;
    }
    return null;
  }, [
    automationLanesVisible,
    editSelectionTrackId,
    selectedTrackId,
    snapshot.tracks,
    trackEditLinked,
    trackHeightScale,
    trackViews,
  ]);
  const active = Boolean(range && range.end > range.start);
  useEscapeToClose(active, useCallback(() => setRange(null), [setRange]));

  if (!range || range.end <= range.start) return null;
  return (
    <div className="pt-edit-selection" data-testid="pt-edit-selection"
      data-track-id={geometry?.trackId}
      data-dragging={dragging}
      role="status"
      aria-label={`Edit selection ${formatSecond(range.start)} to ${formatSecond(range.end)}`}
      style={{
        left: range.start * pxPerSecond,
        width: Math.max(2, (range.end - range.start) * pxPerSecond),
        ...(geometry ? {
          top: `calc(var(--pt-track-title-h) + ${geometry.top}px)`,
          bottom: "auto",
          height: geometry.height,
        } : {}),
      }}>
      <span className="pt-edit-selection-start" aria-hidden="true">EDIT IN</span>
      <span className="pt-edit-selection-end" aria-hidden="true">OUT</span>
    </div>
  );
}
