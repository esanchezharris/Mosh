import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { isEditableTarget } from "../interaction/keymap";
import { useStore } from "../store";
import type { Clip } from "../types";
import { useShell } from "../v2/shellState";
import {
  nextPlaylistTakeIndex,
  promotedPlaylistClipId,
  resolvePlaylistCycleTarget,
  type PlaylistTakeCycleDirection,
} from "./playlistTakeCycle";

export function ProToolsCompRange({ clip }: { readonly clip: Clip }) {
  const pxPerSec = useStore((state) => state.pxPerSec);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const range = useShell((state) => state.timeRange);
  const dragging = useShell((state) => state.timeRangeDragging);
  const setRange = useShell((state) => state.setTimeRange);
  const [busyDirection, setBusyDirection] = useState<PlaylistTakeCycleDirection | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const epochRef = useRef(projectEpoch);
  const target = useMemo(() => resolvePlaylistCycleTarget(clip, range), [clip, range]);

  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => {
    if (epochRef.current === projectEpoch) return;
    epochRef.current = projectEpoch;
    inFlightRef.current = false;
    setBusyDirection(null);
    setRange(null);
  }, [projectEpoch, setRange]);
  useEscapeToClose(Boolean(target), useCallback(() => setRange(null), [setRange]));

  const cycle = useCallback(async (direction: PlaylistTakeCycleDirection) => {
    if (!target || inFlightRef.current) return;
    const epoch = useStore.getState().projectEpoch;
    const takeIndex = nextPlaylistTakeIndex(
      target.currentTakeIndex,
      target.takeCount,
      direction,
    );
    inFlightRef.current = true;
    setBusyDirection(direction);
    const result = await useStore.getState().exec("promote_take_region", {
      clipId: target.clipId,
      takeIndex,
      start: target.start,
      end: target.end,
    });
    if (useStore.getState().projectEpoch !== epoch) return;
    inFlightRef.current = false;
    if (mountedRef.current) setBusyDirection(null);
    if (!result.ok) {
      useStore.getState().setLastError(
        result.error ?? "The alternate take could not be placed in the main playlist.",
      );
      return;
    }
    const promotedClipId = promotedPlaylistClipId(result);
    if (!promotedClipId) {
      useStore.getState().setLastError("The promoted playlist segment was not returned.");
      return;
    }
    useStore.getState().select([promotedClipId]);
    useShell.getState().setSelectedClip(promotedClipId);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || !event.shiftKey
        || (!event.metaKey && !event.ctrlKey)
        || isEditableTarget(event.target)
        || isEditableTarget(document.activeElement)
        || !document.activeElement?.closest(".pt-timeline-scroll")) return;
      const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (direction === 0 || inFlightRef.current) return;
      event.preventDefault();
      void cycle(direction);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycle, target]);

  if (!target) return null;
  const currentLabel = `Take ${target.currentTakeIndex + 1} of ${target.takeCount}`;
  return (
    <div className="pt-comp-range" data-testid="pt-comp-range"
      data-dragging={dragging}
      style={{
        left: target.start * pxPerSec,
        width: Math.max(2, (target.end - target.start) * pxPerSec),
      }}>
      {!dragging && (
        <div className="pt-comp-range-toolbar" role="group"
          aria-label={`Alternate takes for ${clip.name}; target main playlist`}>
          <span className="pt-comp-target" data-testid="pt-comp-target">Target: Main</span>
          <button type="button" data-testid="pt-comp-previous"
            aria-label={`Previous alternate take; ${currentLabel}`}
            aria-keyshortcuts="Meta+Shift+ArrowUp Control+Shift+ArrowUp"
            disabled={busyDirection !== null}
            onClick={() => void cycle(-1)}>Previous</button>
          <output className="pt-comp-current" data-testid="pt-comp-current"
            aria-live="polite">{currentLabel}</output>
          <button type="button" data-testid="pt-comp-next"
            aria-label={`Next alternate take; ${currentLabel}`}
            aria-keyshortcuts="Meta+Shift+ArrowDown Control+Shift+ArrowDown"
            disabled={busyDirection !== null}
            onClick={() => void cycle(1)}>Next</button>
          <button type="button" className="pt-comp-clear"
            aria-label="Clear comp selection" onClick={() => setRange(null)}>Clear</button>
        </div>
      )}
    </div>
  );
}
