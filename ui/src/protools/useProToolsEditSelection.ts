import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useStore } from "../store";
import { useShell, type TimeRangeSel } from "../v2/shellState";
import { capturePointer, releasePointer } from "./pointerCapture";
import { normalizedProToolsSelection } from "./proToolsEditSelection";

const DRAG_THRESHOLD_PX = 3;
const RANGE_EPSILON = 1e-6;

type EditSelectionDrag = {
  readonly pointerId: number;
  readonly element: HTMLElement;
  readonly startClientX: number;
  readonly anchor: number;
  readonly latest: number;
  readonly moved: boolean;
  readonly epoch: number;
  readonly previousRange: TimeRangeSel | null;
  readonly target: ProToolsEditSelectionTarget;
};

export type ProToolsEditSelectionTarget = {
  readonly getRange: () => TimeRangeSel | null;
  readonly setRange: (range: TimeRangeSel | null) => void;
  readonly setDragging: (dragging: boolean) => void;
};

type Options = {
  readonly enabled: boolean;
  readonly positionAt: (element: HTMLElement, clientX: number, bypassSnap: boolean) => number;
  readonly onPlaceCursor: (position: number) => void;
  readonly target?: ProToolsEditSelectionTarget;
};

type Handlers = {
  readonly begin: (event: ReactPointerEvent<HTMLElement>) => boolean;
  readonly move: (event: ReactPointerEvent<HTMLElement>) => boolean;
  readonly finish: (event: ReactPointerEvent<HTMLElement>) => boolean;
  readonly cancel: (event: ReactPointerEvent<HTMLElement>) => boolean;
  readonly consumePointerClick: (event: ReactMouseEvent<HTMLElement>) => boolean;
};

export function useProToolsEditSelection({
  enabled,
  positionAt,
  onPlaceCursor,
  target,
}: Options): Handlers {
  const projectEpoch = useStore((state) => state.projectEpoch);
  const setEditRange = useShell((state) => state.setTimeRange);
  const setEditDragging = useShell((state) => state.setTimeRangeDragging);
  const defaultTarget = useMemo<ProToolsEditSelectionTarget>(() => ({
    getRange: () => useShell.getState().timeRange,
    setRange: setEditRange,
    setDragging: setEditDragging,
  }), [setEditDragging, setEditRange]);
  const selectionTarget = target ?? defaultTarget;
  const dragRef = useRef<EditSelectionDrag | null>(null);
  const suppressPointerClickRef = useRef(false);

  const release = useCallback((drag: EditSelectionDrag): void => {
    releasePointer(drag.element, drag.pointerId);
  }, []);

  const begin = useCallback((event: ReactPointerEvent<HTMLElement>): boolean => {
    if (!enabled || event.button !== 0 || dragRef.current) return false;
    const anchor = positionAt(event.currentTarget, event.clientX, event.altKey);
    dragRef.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      startClientX: event.clientX,
      anchor,
      latest: anchor,
      moved: false,
      epoch: useStore.getState().projectEpoch,
      previousRange: selectionTarget.getRange(),
      target: selectionTarget,
    };
    suppressPointerClickRef.current = false;
    capturePointer(event.currentTarget, event.pointerId);
    return true;
  }, [enabled, positionAt, selectionTarget]);

  const move = useCallback((event: ReactPointerEvent<HTMLElement>): boolean => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return false;
    if (useStore.getState().projectEpoch !== drag.epoch) return true;
    const latest = positionAt(drag.element, event.clientX, event.altKey);
    const moved = drag.moved || Math.abs(event.clientX - drag.startClientX) >= DRAG_THRESHOLD_PX;
    dragRef.current = { ...drag, latest, moved };
    if (!moved) return true;
    drag.target.setDragging(true);
    drag.target.setRange(normalizedProToolsSelection(drag.anchor, latest));
    return true;
  }, [positionAt]);

  const finish = useCallback((event: ReactPointerEvent<HTMLElement>): boolean => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return false;
    dragRef.current = null;
    suppressPointerClickRef.current = true;
    release(drag);
    drag.target.setDragging(false);
    if (useStore.getState().projectEpoch !== drag.epoch) {
      drag.target.setRange(null);
      return true;
    }
    const latest = positionAt(drag.element, event.clientX, event.altKey);
    if (!drag.moved) {
      drag.target.setRange(null);
      onPlaceCursor(latest);
      return true;
    }
    const range = normalizedProToolsSelection(drag.anchor, latest);
    drag.target.setRange(range.end - range.start >= RANGE_EPSILON ? range : null);
    return true;
  }, [onPlaceCursor, positionAt, release]);

  const cancel = useCallback((event: ReactPointerEvent<HTMLElement>): boolean => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return false;
    dragRef.current = null;
    suppressPointerClickRef.current = true;
    release(drag);
    drag.target.setDragging(false);
    drag.target.setRange(useStore.getState().projectEpoch === drag.epoch ? drag.previousRange : null);
    return true;
  }, [release]);

  const consumePointerClick = useCallback((event: ReactMouseEvent<HTMLElement>): boolean => {
    if (!suppressPointerClickRef.current || event.detail === 0) return false;
    suppressPointerClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }, []);

  useEffect(() => {
    const drag = dragRef.current;
    if (!drag || drag.epoch === projectEpoch) return;
    dragRef.current = null;
    suppressPointerClickRef.current = true;
    release(drag);
    drag.target.setDragging(false);
    drag.target.setRange(null);
  }, [projectEpoch, release]);

  useEffect(() => () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    release(drag);
    drag.target.setDragging(false);
    if (useStore.getState().projectEpoch === drag.epoch) drag.target.setRange(drag.previousRange);
  }, [release]);

  return { begin, move, finish, cancel, consumePointerClick };
}
