import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useStore } from "../store";
import type { TimeRangeSel } from "../v2/shellState";
import { capturePointer, releasePointer } from "./pointerCapture";
import { proToolsSelectionSecondAt } from "./proToolsEditSelection";
import { useProTools, type ProToolsRuler } from "./proToolsState";
import { useProToolsTimelineSelectionModel } from "./proToolsTimelineSelection";
import type { ProToolsEditSelectionTarget } from "./useProToolsEditSelection";
import { timelineSeconds } from "./layout";

type Props = {
  readonly visibleRulers: readonly ProToolsRuler[];
  readonly pxPerSecond: number;
  readonly recordArmed: boolean;
};

type SelectionEdge = "start" | "end";

type MarkerDrag = {
  readonly pointerId: number;
  readonly element: HTMLElement;
  readonly edge: SelectionEdge;
  readonly epoch: number;
  readonly previousRange: TimeRangeSel;
  readonly target: ProToolsEditSelectionTarget;
};

type MarkerSurface = {
  readonly enabled: boolean;
  readonly range: TimeRangeSel;
  readonly target: ProToolsEditSelectionTarget;
  readonly totalSeconds: number;
  readonly minimumDuration: number;
  readonly nudgeValue: number;
  readonly positionAt: (element: HTMLElement, clientX: number, bypassSnap: boolean) => number;
};

type MarkerProps = {
  readonly edge: SelectionEdge;
  readonly surface: MarkerSurface;
};

type AdjustedRangeOptions = {
  readonly range: TimeRangeSel;
  readonly edge: SelectionEdge;
  readonly position: number;
  readonly minimumDuration: number;
};

function adjustedRange(options: AdjustedRangeOptions): TimeRangeSel {
  if (options.edge === "start") {
    return {
      start: Math.min(options.position, options.range.end - options.minimumDuration),
      end: options.range.end,
    };
  }
  return {
    start: options.range.start,
    end: Math.max(options.position, options.range.start + options.minimumDuration),
  };
}

function ProToolsSelectionMarker({ edge, surface }: MarkerProps) {
  const projectEpoch = useStore((state) => state.projectEpoch);
  const dragRef = useRef<MarkerDrag | null>(null);
  const value = surface.range[edge];
  const label = `Timeline selection ${edge}`;

  const moveTo = useCallback((position: number, drag?: MarkerDrag): void => {
    const target = drag?.target ?? surface.target;
    const range = drag?.previousRange ?? target.getRange();
    if (!range || range.end <= range.start) return;
    const bounded = Math.max(0, Math.min(surface.totalSeconds, position));
    target.setRange(adjustedRange({
      range,
      edge,
      position: bounded,
      minimumDuration: surface.minimumDuration,
    }));
  }, [edge, surface]);

  const finishDrag = useCallback((restore: boolean): void => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    releasePointer(drag.element, drag.pointerId);
    drag.target.setDragging(false);
    if (restore) {
      drag.target.setRange(useStore.getState().projectEpoch === drag.epoch
        ? drag.previousRange
        : null);
    }
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (!surface.enabled || event.button !== 0 || dragRef.current) return;
    const previousRange = surface.target.getRange();
    if (!previousRange || previousRange.end <= previousRange.start) return;
    dragRef.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      edge,
      epoch: useStore.getState().projectEpoch,
      previousRange,
      target: surface.target,
    };
    capturePointer(event.currentTarget, event.pointerId);
    surface.target.setDragging(true);
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (useStore.getState().projectEpoch === drag.epoch) {
      moveTo(surface.positionAt(drag.element, event.clientX, event.altKey), drag);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (useStore.getState().projectEpoch === drag.epoch) {
      moveTo(surface.positionAt(drag.element, event.clientX, event.altKey), drag);
    }
    finishDrag(useStore.getState().projectEpoch !== drag.epoch);
    event.preventDefault();
    event.stopPropagation();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!surface.enabled || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const range = surface.target.getRange();
    if (!range) return;
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? surface.totalSeconds
        : value + (event.key === "ArrowRight" ? surface.nudgeValue : -surface.nudgeValue);
    event.preventDefault();
    event.stopPropagation();
    surface.target.setDragging(false);
    moveTo(next);
  };

  useEffect(() => {
    const drag = dragRef.current;
    if (!drag || drag.epoch === projectEpoch) return;
    finishDrag(true);
  }, [finishDrag, projectEpoch]);

  useEffect(() => () => finishDrag(true), [finishDrag]);

  return (
    <span className={`pt-ruler-selection-${edge}${surface.enabled ? "" : " is-disabled"}`}
      data-testid={`pt-timeline-selection-${edge}`}
      role="slider"
      aria-label={label}
      aria-disabled={!surface.enabled}
      aria-valuemin={edge === "start" ? 0 : surface.range.start}
      aria-valuemax={edge === "start" ? surface.range.end : surface.totalSeconds}
      aria-valuenow={value}
      aria-valuetext={`${value.toFixed(3)} seconds`}
      aria-keyshortcuts="ArrowLeft ArrowRight Home End"
      tabIndex={surface.enabled ? 0 : -1}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        finishDrag(true);
        event.preventDefault();
        event.stopPropagation();
      }}
      onLostPointerCapture={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        finishDrag(true);
      }} />
  );
}

export function ProToolsRulerSelectionOverlay({
  visibleRulers,
  pxPerSecond,
  recordArmed,
}: Props) {
  const snapshot = useStore((state) => state.snapshot);
  const editMode = useProTools((state) => state.editMode);
  const activeTool = useProTools((state) => state.activeTool);
  const smartToolEnabled = useProTools((state) => state.smartToolEnabled);
  const nudgeValue = useProTools((state) => state.nudgeValue);
  const { range, dragging, target } = useProToolsTimelineSelectionModel();
  const barsBeatsIndex = visibleRulers.indexOf("barsBeats");
  const firstTimebaseIndex = visibleRulers.findIndex((ruler) => ruler !== "markers");
  const mainRulerIndex = barsBeatsIndex >= 0 ? barsBeatsIndex : firstTimebaseIndex;
  const totalSeconds = snapshot ? timelineSeconds(snapshot) : 0;
  const minimumDuration = Math.min(
    range ? range.end - range.start : 0,
    1 / Math.max(1, pxPerSecond),
  );
  const positionAt = useCallback((
    element: HTMLElement,
    clientX: number,
    bypassSnap: boolean,
  ): number => {
    const field = element.closest<HTMLElement>(".pt-ruler-field");
    if (!field || !snapshot) return 0;
    const state = useStore.getState();
    return proToolsSelectionSecondAt({
      clientX,
      rectLeft: field.getBoundingClientRect().left,
      pxPerSecond,
      totalSeconds,
      editMode,
      bypassSnap,
      session: snapshot.session,
      snapDivision: state.effectiveSnapDivision(),
      snapTriplet: state.snapTriplet,
    });
  }, [editMode, pxPerSecond, snapshot, totalSeconds]);

  if (!snapshot || !range || range.end <= range.start || mainRulerIndex < 0) return null;
  const surface: MarkerSurface = {
    enabled: smartToolEnabled || activeTool === "grabber",
    range,
    target,
    totalSeconds,
    minimumDuration,
    nudgeValue,
    positionAt,
  };
  return (
    <div className={`pt-ruler-selection${recordArmed ? " is-record-armed" : ""}`}
      data-testid="pt-ruler-selection"
      data-dragging={dragging}
      role="group"
      aria-label="Timeline selection boundaries"
      style={{
        top: `calc(${mainRulerIndex} * var(--pt-ruler-row-h))`,
        left: range.start * pxPerSecond,
        width: Math.max(2, (range.end - range.start) * pxPerSecond),
      }}>
      <ProToolsSelectionMarker edge="start" surface={surface} />
      <ProToolsSelectionMarker edge="end" surface={surface} />
    </div>
  );
}
