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
  const editSelectionTrackIds = useProTools((state) => state.editSelectionTrackIds);
  const trackViews = useProTools((state) => state.trackViews);
  const automationLanesVisible = useProTools((state) => state.automationLanesVisible);
  const trackHeightScale = useProTools((state) => state.trackHeightScale);
  const geometry = useMemo(() => {
    const tracks = snapshot.tracks.filter((track) => !track.isGroup && !track.isReturn);
    const fallbackTrackId = trackEditLinked
      ? selectedTrackId ?? editSelectionTrackId
      : editSelectionTrackId ?? selectedTrackId;
    const requestedTrackIds = editSelectionTrackIds.length > 0
      ? editSelectionTrackIds
      : fallbackTrackId ? [fallbackTrackId] : [];
    const requested = new Set(requestedTrackIds);
    const trackIds = tracks.filter((track) => requested.has(track.id)).map((track) => track.id);
    if (trackIds.length === 0) return null;
    const selected = new Set(trackIds);
    const absoluteBands: { top: number; height: number }[] = [];
    let bandTop: number | null = null;
    let bandHeight = 0;
    let top = 0;
    for (const track of tracks) {
      const height = proToolsTrackRowHeight(
        track,
        trackViews[track.id],
        Boolean(automationLanesVisible[track.id]),
        trackHeightScale,
      );
      if (selected.has(track.id)) {
        bandTop ??= top;
        bandHeight += height;
      } else if (bandTop !== null) {
        absoluteBands.push({ top: bandTop, height: bandHeight });
        bandTop = null;
        bandHeight = 0;
      }
      top += height;
    }
    if (bandTop !== null) absoluteBands.push({ top: bandTop, height: bandHeight });
    const firstBand = absoluteBands[0];
    const lastBand = absoluteBands.at(-1);
    if (!firstBand || !lastBand) return null;
    const focusTrackId = editSelectionTrackId && selected.has(editSelectionTrackId)
      ? editSelectionTrackId
      : trackIds.at(-1) ?? null;
    return {
      trackId: focusTrackId,
      trackIds,
      top: firstBand.top,
      height: lastBand.top + lastBand.height - firstBand.top,
      bands: absoluteBands.map((band) => ({
        top: band.top - firstBand.top,
        height: band.height,
      })),
    };
  }, [
    automationLanesVisible,
    editSelectionTrackId,
    editSelectionTrackIds,
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
      data-track-ids={geometry?.trackIds.join(" ")}
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
      {(geometry?.bands ?? [null]).map((band, index) => (
        <div key={band ? `${band.top}-${band.height}` : "all"}
          className="pt-edit-selection-band"
          data-testid="pt-edit-selection-band"
          style={band ? { top: band.top, height: band.height } : { top: 0, bottom: 0 }}>
          {index === 0 && (
            <>
              <span className="pt-edit-selection-start" aria-hidden="true">EDIT IN</span>
              <span className="pt-edit-selection-end" aria-hidden="true">OUT</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
