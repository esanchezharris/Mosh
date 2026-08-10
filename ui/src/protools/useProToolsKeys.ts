import { useEffect, useRef } from "react";
import { isEditableTarget } from "../interaction/keymap";
import { useStore, type State } from "../store";
import { handleProToolsFadesShortcut } from "./proToolsFadeShortcut";
import { useProTools, type ProToolsEditMode } from "./proToolsState";
import { applyHorizontalZoom, applyHorizontalZoomStep } from "./proToolsZoom";
import type { ProToolsTool } from "./smartTool";
import { nextTabPosition } from "./tabNavigation";
import { nextCommonProToolsTrackView } from "./trackViews";
import { toggleProToolsTimelineEditLink } from "./proToolsTimelineSelection";
import {
  toggleProToolsTrackEditLink,
} from "./proToolsTrackEditSelection";
import {
  handleProToolsEditTrackNavigation,
  ownsProToolsEditKeyboardFocus,
} from "./proToolsEditTrackNavigation";
import { handleProToolsTrackControlShortcut } from "./proToolsTrackControls";
import {
  adjacentMemoryLocation,
  memoryLocationAtNumber,
  numberedMemoryLocations,
} from "./memoryLocations";
import { transientCandidates } from "./proToolsTransientCandidates";
import { proToolsShownTracks } from "./proToolsTrackVisibility";

const EDIT_MODE_KEYS: Readonly<Partial<Record<string, ProToolsEditMode>>> = {
  F1: "shuffle",
  F2: "slip",
  F3: "spot",
  F4: "grid",
};

const EDIT_TOOL_KEYS: Readonly<Partial<Record<string, ProToolsTool>>> = {
  F5: "zoomer",
  F6: "trimmer",
  F7: "selector",
  F8: "grabber",
  F9: "scrubber",
  F10: "pencil",
};

function ownsTabToTransientNavigation(element: Element | null): boolean {
  if (element === document.body) return true;
  return element?.closest(".pt-timeline-scroll, [data-clip-id]") !== null;
}

export function useProToolsKeys(onOpenFades?: () => void): void {
  const memorySequence = useRef<{ digits: string; startedAt: number } | null>(null);
  const lastRecalledLocation = useRef<number | null>(null);
  const memoryEpoch = useRef(useStore.getState().projectEpoch);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented
        || isEditableTarget(event.target)
        || isEditableTarget(document.activeElement)) return;

      const currentEpoch = useStore.getState().projectEpoch;
      if (currentEpoch !== memoryEpoch.current) {
        memoryEpoch.current = currentEpoch;
        memorySequence.current = null;
        lastRecalledLocation.current = null;
      }

      const mode = EDIT_MODE_KEYS[event.key];
      if (mode && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        useProTools.getState().setEditMode(mode);
        return;
      }

      const tool = EDIT_TOOL_KEYS[event.key];
      if (tool && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        const proTools = useProTools.getState();
        if (tool === "zoomer" && !proTools.smartToolEnabled && proTools.activeTool === "zoomer") {
          proTools.toggleSingleZoom();
          return;
        }
        proTools.setActiveTool(tool);
        if (proTools.smartToolEnabled) proTools.toggleSmartTool();
        return;
      }

      if (handleProToolsFadesShortcut(event, onOpenFades)) return;

      if (event.code === "Slash" && event.shiftKey
        && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        toggleProToolsTimelineEditLink();
        return;
      }

      if (event.code === "KeyT" && event.shiftKey
        && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        toggleProToolsTrackEditLink();
        return;
      }

      if (handleProToolsTrackControlShortcut(event)) return;

      if (handleProToolsEditTrackNavigation(event)) return;

      if ((event.code === "Slash" || event.code === "NumpadDivide")
        && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const start = document.getElementById("pt-selection-start");
        if (!(start instanceof HTMLInputElement)) return;
        event.preventDefault();
        start.focus();
        start.select();
        return;
      }

      const noModifiers = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      const now = performance.now();
      if (memorySequence.current && now - memorySequence.current.startedAt > 1_500) {
        memorySequence.current = null;
      }
      const seekMemoryLocation = (seconds: number) => {
        lastRecalledLocation.current = seconds;
        void useStore.getState().exec("set_transport", { position: seconds });
      };
      if (noModifiers && event.code === "NumpadEnter") {
        event.preventDefault();
        useProTools.getState().requestNewMemoryLocation(useStore.getState().transport.position);
        memorySequence.current = null;
        return;
      }
      if (noModifiers && event.code === "NumpadDecimal") {
        event.preventDefault();
        const sequence = memorySequence.current;
        if (!sequence) {
          memorySequence.current = { digits: "", startedAt: now };
          return;
        }
        memorySequence.current = null;
        if (sequence.digits) {
          const snapshot = useStore.getState().snapshot;
          if (!snapshot) return;
          const location = memoryLocationAtNumber(
            numberedMemoryLocations(snapshot),
            Number(sequence.digits),
          );
          if (location) seekMemoryLocation(location.seconds);
        } else if (lastRecalledLocation.current !== null) {
          seekMemoryLocation(lastRecalledLocation.current);
        }
        return;
      }
      const memoryDigit = /^Numpad\d$/.test(event.code) ? event.code.slice(-1) : null;
      if (noModifiers && memorySequence.current && memoryDigit !== null) {
        event.preventDefault();
        memorySequence.current = {
          digits: `${memorySequence.current.digits}${memoryDigit}`.slice(0, 4),
          startedAt: now,
        };
        return;
      }
      if (noModifiers && memorySequence.current
        && (event.code === "NumpadAdd" || event.code === "NumpadSubtract")) {
        event.preventDefault();
        memorySequence.current = null;
        const store = useStore.getState();
        if (!store.snapshot) return;
        const location = adjacentMemoryLocation(
          numberedMemoryLocations(store.snapshot),
          store.transport.position,
          event.code === "NumpadAdd" ? 1 : -1,
        );
        if (location) seekMemoryLocation(location.seconds);
        return;
      }

      if (noModifiers && ownsProToolsEditKeyboardFocus(document.activeElement)) {
        const zoomKey = event.key.toLowerCase();
        if (zoomKey === "r" || zoomKey === "t") {
          event.preventDefault();
          applyHorizontalZoomStep(zoomKey === "t" ? 1 : -1);
          return;
        }
        const presetIndex = /^[1-5]$/.test(event.key) ? Number(event.key) - 1 : -1;
        if (presetIndex >= 0) {
          event.preventDefault();
          applyHorizontalZoom(useProTools.getState().horizontalZoomPresets[presetIndex] ?? 80);
          return;
        }
      }

      if ((event.key === "-" || event.code === "NumpadSubtract")
        && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const store = useStore.getState();
        const track = store.snapshot?.tracks.find((candidate) => candidate.id === store.selectedTrackId);
        if (!track) return;
        event.preventDefault();
        const proTools = useProTools.getState();
        proTools.setTrackView(track.id, nextCommonProToolsTrackView(track, proTools.trackViews[track.id]));
        return;
      }

      if (event.key === "Tab" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (!ownsTabToTransientNavigation(document.activeElement)) return;
        const store = useStore.getState();
        const trackVisibility = useProTools.getState().trackVisibility;
        const clipBoundaries = store.snapshot
          ? proToolsShownTracks(store.snapshot.tracks, trackVisibility).flatMap((track) =>
            track.clips.flatMap((clip) => [clip.start, clip.start + clip.length]))
          : [];
        const next = nextTabPosition({
          position: store.transport.position,
          tabToTransient: useProTools.getState().tabToTransient,
          transientCandidates: transientCandidates(store.snapshot, store.peaks, trackVisibility),
          clipBoundaries,
        });
        if (next === null) return;
        event.preventDefault();
        void store.exec("set_transport", { position: next });
        return;
      }

      let direction: -1 | 0 | 1 = 0;
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        if (event.key === "-" || event.key === "_") direction = -1;
        if (event.key === "+" || event.key === "=") direction = 1;
      }
      if (direction === 0) return;
      const store = useStore.getState();
      const snapshot = store.snapshot;
      if (!snapshot) return;
      const epoch = store.projectEpoch;
      const amount = useProTools.getState().nudgeValue * direction;
      const edits = snapshot.tracks
        .flatMap((track) => track.clips)
        .filter((clip) => store.selection.has(clip.id))
        .map((clip) => ({ clipId: clip.id, start: Math.max(0, clip.start + amount) }));
      if (edits.length === 0) return;
      event.preventDefault();
      const applyEdits = async (exec: State["exec"]): Promise<void> => {
        for (const edit of edits) {
          if (useStore.getState().projectEpoch !== epoch) return;
          await exec("move_clip", edit);
        }
      };
      if (edits.length === 1) void applyEdits(store.exec);
      else void store.runAtomic("nudge clips", applyEdits);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenFades]);
}
