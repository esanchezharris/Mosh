import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useStore } from "../store";
import type { AutoPoint } from "../types";
import {
  AUTOMATION_GRAPH_HEIGHT_PX,
  AUTOMATION_GRAPH_TOP_PX,
  automationPointIsSelected,
  moveAutomationPoint,
  orderedAutomationPoints,
  replaceAutomationPoint,
  type AutomationRange,
  type AutomationTarget,
  type IndexedAutomationPoint,
} from "./automationEditing";
import { capturePointer, releasePointer } from "./pointerCapture";

type Props = {
  readonly trackId: string;
  readonly target: AutomationTarget | null;
  readonly points: readonly AutoPoint[];
  readonly selection: AutomationRange | null;
  readonly pxPerSec: number;
  readonly width: number;
};

type PointGesture = {
  readonly element: HTMLButtonElement;
  readonly pointerId: number;
  readonly pointIndex: number;
  readonly startX: number;
  readonly startY: number;
  readonly original: AutoPoint;
  readonly originalPoints: readonly AutoPoint[];
  readonly epoch: number;
  readonly previewToken: number;
  value: AutoPoint;
};

function pointTop(value: number): number {
  return AUTOMATION_GRAPH_TOP_PX + (1 - value) * AUTOMATION_GRAPH_HEIGHT_PX;
}

export function ProToolsAutomationCurve(props: Props) {
  const { trackId, target, points, selection, pxPerSec, width } = props;
  const exec = useStore((state) => state.exec);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const [previewPoints, setPreviewPoints] = useState<readonly AutoPoint[] | null>(null);
  const gesture = useRef<PointGesture | null>(null);
  const previewToken = useRef(0);
  const renderedPoints = previewPoints ?? points;
  const orderedPoints = orderedAutomationPoints(renderedPoints);

  const cancelGesture = () => {
    previewToken.current += 1;
    const current = gesture.current;
    if (current) releasePointer(current.element, current.pointerId);
    gesture.current = null;
    setPreviewPoints(null);
  };

  useEffect(() => {
    cancelGesture();
  }, [projectEpoch, trackId, target?.pluginIndex, target?.paramIndex]);

  useEffect(() => {
    cancelGesture();
  }, [points]);

  useEffect(() => () => {
    const current = gesture.current;
    if (current) releasePointer(current.element, current.pointerId);
  }, []);

  const removePoint = (pointIndex: number) => {
    if (!target) return;
    void exec("remove_automation_point", {
      trackId,
      pluginIndex: target.pluginIndex,
      paramIndex: target.paramIndex,
      pointIndex,
    });
  };

  const onPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    point: IndexedAutomationPoint,
  ) => {
    if (event.button !== 0 || !target) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.altKey) {
      removePoint(point.pointIndex);
      return;
    }
    event.currentTarget.focus();
    gesture.current = {
      element: event.currentTarget,
      pointerId: event.pointerId,
      pointIndex: point.pointIndex,
      startX: event.clientX,
      startY: event.clientY,
      original: point,
      originalPoints: renderedPoints,
      value: point,
      epoch: useStore.getState().projectEpoch,
      previewToken: ++previewToken.current,
    };
    capturePointer(event.currentTarget, event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    current.value = moveAutomationPoint({
      point: current.original,
      deltaX: event.clientX - current.startX,
      deltaY: event.clientY - current.startY,
      pxPerSec,
    });
    setPreviewPoints(replaceAutomationPoint(
      current.originalPoints,
      current.pointIndex,
      current.value,
    ));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId || !target) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = null;
    releasePointer(event.currentTarget, event.pointerId);
    if (useStore.getState().projectEpoch !== current.epoch) {
      setPreviewPoints(null);
      return;
    }
    if (current.value.t === current.original.t && current.value.v === current.original.v) {
      setPreviewPoints(null);
      return;
    }
    const pending = exec("set_automation_point", {
      trackId,
      pluginIndex: target.pluginIndex,
      paramIndex: target.paramIndex,
      pointIndex: current.pointIndex,
      time: current.value.t,
      value: current.value.v,
    });
    void pending.then(
      (result) => {
        if (!result.ok && previewToken.current === current.previewToken) {
          setPreviewPoints(null);
        }
      },
      () => {
        if (previewToken.current === current.previewToken) setPreviewPoints(null);
      },
    );
  };

  const onKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    point: IndexedAutomationPoint,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelGesture();
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    event.stopPropagation();
    removePoint(point.pointIndex);
  };

  const path = orderedPoints.map((point, index) => {
    const x = Math.max(0, point.t * pxPerSec);
    const y = pointTop(point.v);
    return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");

  return (
    <>
      <svg className="pt-automation-curve" width={width} height="100%" aria-hidden="true">
        {path && <path className="pt-automation-path" d={path} />}
      </svg>
      {target && orderedPoints.map((point) => {
        const pointStyle: CSSProperties = {
          left: point.t * pxPerSec,
          top: pointTop(point.v),
        };
        const selected = automationPointIsSelected(point, selection);
        return (
          <button key={point.pointIndex} type="button" className="pt-automation-point"
            data-testid={`pt-automation-point-${point.pointIndex}`} data-selected={selected}
            aria-pressed={selected} aria-keyshortcuts="Delete Backspace Escape" style={pointStyle}
            aria-label={`${target.paramName} automation point ${point.pointIndex + 1}, ${point.t.toFixed(3)} seconds, ${Math.round(point.v * 100)} percent`}
            onPointerDown={(event) => onPointerDown(event, point)}
            onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onPointerCancel={(event) => {
              if (gesture.current?.pointerId !== event.pointerId) return;
              event.preventDefault();
              event.stopPropagation();
              cancelGesture();
            }}
            onKeyDown={(event) => onKeyDown(event, point)} />
        );
      })}
    </>
  );
}
