import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../store";
import type { Clip } from "../types";
import { normalizePlaylistCompRange, playlistSecondsAtClientX } from "./playlistComping";

type PlaylistCompSelection = {
  readonly clipId: string;
  readonly takeIndex: number;
  readonly label: string;
  readonly start: number;
  readonly end: number;
};

type PlaylistTarget = {
  readonly clip: Clip;
  readonly takeIndex: number;
  readonly label: string;
  readonly current: boolean;
};

type PlaylistCompDrag = Omit<PlaylistTarget, "current"> & {
  readonly pointerId: number;
  readonly rectLeft: number;
  readonly anchor: number;
  readonly epoch: number;
};

type UsePlaylistCompingOptions = {
  readonly pxPerSec: number;
  readonly projectEpoch: number;
  readonly selectTake: (clipId: string, takeIndex: number) => Promise<void>;
  readonly setLastError: (message: string | null) => void;
};

function capturePointer(target: HTMLElement, pointerId: number) {
  if (!target.setPointerCapture) return;
  try {
    target.setPointerCapture(pointerId);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}

function releasePointer(target: HTMLElement, pointerId: number) {
  if (!target.releasePointerCapture) return;
  try {
    target.releasePointerCapture(pointerId);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}

function selectionFromPointer(drag: PlaylistCompDrag, clientX: number, pxPerSec: number) {
  const head = playlistSecondsAtClientX(
    clientX,
    drag.rectLeft,
    drag.clip.start,
    drag.clip.length,
    pxPerSec,
  );
  const range = normalizePlaylistCompRange(
    drag.anchor,
    head,
    drag.clip.start,
    drag.clip.length,
  );
  return range ? {
    clipId: drag.clip.id,
    takeIndex: drag.takeIndex,
    label: drag.label,
    ...range,
  } : null;
}

export function usePlaylistComping(options: UsePlaylistCompingOptions) {
  const [selection, setSelection] = useState<PlaylistCompSelection | null>(null);
  const [promoting, setPromoting] = useState(false);
  const dragRef = useRef<PlaylistCompDrag | null>(null);
  const suppressClickRef = useRef<{ readonly clipId: string; readonly takeIndex: number } | null>(null);

  useEffect(() => {
    dragRef.current = null;
    suppressClickRef.current = null;
    setSelection(null);
    setPromoting(false);
  }, [options.projectEpoch]);

  const begin = (event: ReactPointerEvent<HTMLButtonElement>, target: PlaylistTarget) => {
    event.stopPropagation();
    if (target.current || event.button !== 0) return;
    const rectLeft = event.currentTarget.getBoundingClientRect().left;
    dragRef.current = {
      pointerId: event.pointerId,
      clip: target.clip,
      takeIndex: target.takeIndex,
      label: target.label,
      rectLeft,
      anchor: playlistSecondsAtClientX(
        event.clientX,
        rectLeft,
        target.clip.start,
        target.clip.length,
        options.pxPerSec,
      ),
      epoch: options.projectEpoch,
    };
    suppressClickRef.current = null;
    setSelection(null);
    capturePointer(event.currentTarget, event.pointerId);
  };

  const update = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (useStore.getState().projectEpoch !== drag.epoch) {
      dragRef.current = null;
      setSelection(null);
      return;
    }
    setSelection(selectionFromPointer(drag, event.clientX, options.pxPerSec));
  };

  const end = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    releasePointer(event.currentTarget, event.pointerId);
    dragRef.current = null;
    if (useStore.getState().projectEpoch !== drag.epoch) {
      setSelection(null);
      return;
    }
    const next = selectionFromPointer(drag, event.clientX, options.pxPerSec);
    setSelection(next);
    suppressClickRef.current = next
      ? { clipId: drag.clip.id, takeIndex: drag.takeIndex }
      : null;
  };

  const cancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    releasePointer(event.currentTarget, event.pointerId);
    dragRef.current = null;
    suppressClickRef.current = null;
    setSelection(null);
  };

  const click = (target: PlaylistTarget) => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = null;
    if (suppressed?.clipId === target.clip.id && suppressed.takeIndex === target.takeIndex) return;
    if (!target.current) void options.selectTake(target.clip.id, target.takeIndex);
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, target: PlaylistTarget) => {
    if (event.key === "Escape" && selection) {
      event.preventDefault();
      event.stopPropagation();
      setSelection(null);
      return;
    }
    if (target.current || !event.shiftKey || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    event.stopPropagation();
    setSelection({
      clipId: target.clip.id,
      takeIndex: target.takeIndex,
      label: target.label,
      start: target.clip.start,
      end: target.clip.start + target.clip.length,
    });
  };

  const promote = async () => {
    if (!selection || promoting) return;
    const epoch = useStore.getState().projectEpoch;
    setPromoting(true);
    const result = await useStore.getState().exec("promote_take_region", {
      clipId: selection.clipId,
      takeIndex: selection.takeIndex,
      start: selection.start,
      end: selection.end,
    });
    if (useStore.getState().projectEpoch !== epoch) return;
    setPromoting(false);
    if (!result.ok) {
      options.setLastError(result.error ?? "The playlist range could not be promoted.");
      return;
    }
    setSelection(null);
  };

  return { selection, promoting, begin, update, end, cancel, click, keyDown, promote };
}
