import { useEffect } from "react";
import { isEditableTarget } from "../interaction/keymap";
import { useStore, type State } from "../store";
import type { Snapshot } from "../types";
import { useProTools, type ProToolsEditMode } from "./proToolsState";
import { applyHorizontalZoom, applyHorizontalZoomStep } from "./proToolsZoom";
import type { ProToolsTool } from "./smartTool";
import { nextTabPosition } from "./tabNavigation";
import { nextCommonProToolsTrackView } from "./trackViews";

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

type ReadonlyPeaks = Readonly<Record<string, readonly (readonly [number, number])[]>>;

function ownsTabToTransientNavigation(element: Element | null): boolean {
  if (element === document.body) return true;
  return element?.closest(".pt-timeline-scroll, [data-clip-id]") !== null;
}

function ownsEditKeyboardFocus(element: Element | null): boolean {
  return element?.closest(".pt-timeline-scroll, [data-clip-id]") !== null;
}

export function transientCandidates(snapshot: Snapshot | null, peaks: ReadonlyPeaks): readonly number[] {
  if (!snapshot) return [];
  const candidates: number[] = [];
  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      if (clip.type !== "wave") continue;
      const buckets = peaks[clip.id];
      if (!buckets || buckets.length === 0) continue;
      for (let index = 0; index < buckets.length; index += 1) {
        const bucket = buckets[index];
        if (!bucket) continue;
        const previous = index === 0 ? 0 : peaksAmplitude(buckets[index - 1]);
        if (peaksAmplitude(bucket) >= 0.65 && previous < 0.45) {
          candidates.push(clip.start + (index / buckets.length) * clip.length);
        }
      }
    }
  }
  return candidates;
}

function peaksAmplitude(bucket: readonly [number, number] | undefined): number {
  return bucket ? Math.max(Math.abs(bucket[0]), Math.abs(bucket[1])) : 0;
}

export function useProToolsKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented
        || isEditableTarget(event.target)
        || isEditableTarget(document.activeElement)) return;

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
        proTools.setActiveTool(tool);
        if (proTools.smartToolEnabled) proTools.toggleSmartTool();
        return;
      }

      const noModifiers = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (noModifiers && ownsEditKeyboardFocus(document.activeElement)) {
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
        const clipBoundaries = store.snapshot?.tracks.flatMap((track) =>
          track.clips.flatMap((clip) => [clip.start, clip.start + clip.length])) ?? [];
        const next = nextTabPosition({
          position: store.transport.position,
          tabToTransient: useProTools.getState().tabToTransient,
          transientCandidates: transientCandidates(store.snapshot, store.peaks),
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
  }, []);
}
