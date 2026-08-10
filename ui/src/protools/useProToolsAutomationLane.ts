import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useStore } from "../store";
import type { AutoPoint } from "../types";
import {
  AUTOMATION_GRAPH_HEIGHT_PX,
  AUTOMATION_GRAPH_TOP_PX,
  automationPointIsSelected,
  automationPointsEqual,
  automationRange,
  automationReplacementBounds,
  nudgeAutomationPoints,
  trimAutomationPoints,
  type AutomationRange,
  type AutomationTarget,
} from "./automationEditing";
import { capturePointer, releasePointer } from "./pointerCapture";
import { classifyProToolsIntent } from "./smartTool";
import { useProTools } from "./proToolsState";
import { useProToolsAutomationClipboard } from "./useProToolsAutomationClipboard";
import { useProToolsAutomationPencil } from "./useProToolsAutomationPencil";

type SelectGesture = {
  readonly kind: "select";
  readonly element: HTMLButtonElement;
  readonly pointerId: number;
  readonly anchorTime: number;
  readonly previousRange: AutomationRange | null;
  readonly epoch: number;
};

type TrimGesture = {
  readonly kind: "trim";
  readonly element: HTMLButtonElement;
  readonly pointerId: number;
  readonly startY: number;
  readonly originalPoints: readonly AutoPoint[];
  readonly epoch: number;
  readonly previewToken: number;
  valuePoints: readonly AutoPoint[];
};

type Options = {
  readonly trackId: string;
  readonly target: AutomationTarget | null;
  readonly snapshotPoints: readonly AutoPoint[];
  readonly pxPerSec: number;
  readonly position: number;
};

export function useProToolsAutomationLane(options: Options) {
  const { trackId, target, snapshotPoints, pxPerSec, position } = options;
  const exec = useStore((state) => state.exec);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const smartToolEnabled = useProTools((state) => state.smartToolEnabled);
  const activeTool = useProTools((state) => state.activeTool);
  const nudgeValue = useProTools((state) => state.nudgeValue);
  const setHoveredIntent = useProTools((state) => state.setHoveredIntent);
  const [selection, setSelection] = useState<AutomationRange | null>(null);
  const [previewPoints, setPreviewPoints] = useState<readonly AutoPoint[] | null>(null);
  const [trimReadout, setTrimReadout] = useState<number | null>(null);
  const gesture = useRef<SelectGesture | TrimGesture | null>(null);
  const previewToken = useRef(0);
  const basePoints = previewPoints ?? snapshotPoints;
  const pencil = useProToolsAutomationPencil({ trackId, target, points: basePoints, pxPerSec });
  const renderedPoints = pencil.previewPoints ?? basePoints;
  const clipboard = useProToolsAutomationClipboard({
    trackId,
    target,
    points: renderedPoints,
    selection,
    position,
  });

  const releaseGesture = () => {
    const current = gesture.current;
    if (current) releasePointer(current.element, current.pointerId);
    gesture.current = null;
    setTrimReadout(null);
  };

  const cancelGesture = () => {
    previewToken.current += 1;
    const current = gesture.current;
    if (current?.kind === "select") setSelection(current.previousRange);
    releaseGesture();
    pencil.cancel();
    setPreviewPoints(null);
  };

  useEffect(() => {
    cancelGesture();
    setSelection(null);
  }, [projectEpoch, trackId, target?.pluginIndex, target?.paramIndex]);

  useEffect(() => {
    cancelGesture();
    setPreviewPoints(null);
  }, [snapshotPoints]);

  useEffect(() => () => {
    const current = gesture.current;
    if (current) releasePointer(current.element, current.pointerId);
  }, []);

  const intentAt = (event: ReactPointerEvent<HTMLButtonElement>, kind: "click" | "drag") => {
    const rect = event.currentTarget.getBoundingClientRect();
    return classifyProToolsIntent({
      media: "automation",
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      edgeGrabPx: 0,
      meta: event.metaKey || event.ctrlKey,
      gesture: kind,
      smartToolEnabled,
      activeTool,
    });
  };

  const timeAt = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, (event.clientX - rect.left) / pxPerSec);
  };

  const addBreakpoint = (time: number, value: number) => {
    if (!target) return;
    void exec("add_automation_point", {
      trackId,
      pluginIndex: target.pluginIndex,
      paramIndex: target.paramIndex,
      time,
      value,
    });
  };

  const writeCurve = (
    points: readonly AutoPoint[],
    replacedPoints: readonly AutoPoint[],
    optimisticToken?: number,
  ) => {
    if (!target) return;
    const bounds = automationReplacementBounds(replacedPoints, points);
    if (!bounds) return;
    const pending = exec("write_automation_curve", {
      trackId,
      pluginIndex: target.pluginIndex,
      paramIndex: target.paramIndex,
      apply: "replace",
      replaceStart: bounds.start,
      replaceEnd: bounds.end,
      points,
    });
    if (optimisticToken === undefined) return;
    void pending.then(
      (result) => {
        if (!result.ok && previewToken.current === optimisticToken) {
          setPreviewPoints(null);
        }
      },
      () => {
        if (previewToken.current === optimisticToken) setPreviewPoints(null);
      },
    );
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !target || pencil.onPointerDown(event)) return;
    const intent = intentAt(event, event.metaKey || event.ctrlKey ? "click" : "drag");
    setHoveredIntent(intent);
    if (intent === "breakpoint") {
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      const value = Math.min(1, Math.max(0,
        1 - (event.clientY - rect.top - AUTOMATION_GRAPH_TOP_PX) / AUTOMATION_GRAPH_HEIGHT_PX));
      addBreakpoint(timeAt(event), value);
      return;
    }
    if (intent === "selector") {
      const anchorTime = timeAt(event);
      gesture.current = {
        kind: "select",
        element: event.currentTarget,
        pointerId: event.pointerId,
        anchorTime,
        previousRange: selection,
        epoch: useStore.getState().projectEpoch,
      };
      setSelection(automationRange(anchorTime, anchorTime));
    } else if (intent === "trimmer" && selection
      && renderedPoints.some((point) => automationPointIsSelected(point, selection))) {
      gesture.current = {
        kind: "trim",
        element: event.currentTarget,
        pointerId: event.pointerId,
        startY: event.clientY,
        originalPoints: renderedPoints,
        valuePoints: renderedPoints,
        epoch: useStore.getState().projectEpoch,
        previewToken: ++previewToken.current,
      };
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    capturePointer(event.currentTarget, event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pencil.onPointerMove(event)) return;
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) {
      setHoveredIntent(intentAt(event, "drag"));
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (current.kind === "select") {
      setSelection(automationRange(current.anchorTime, timeAt(event)));
      return;
    }
    if (!selection) return;
    const deltaValue = (current.startY - event.clientY) / AUTOMATION_GRAPH_HEIGHT_PX;
    current.valuePoints = trimAutomationPoints(current.originalPoints, selection, deltaValue);
    setPreviewPoints(current.valuePoints);
    setTrimReadout(deltaValue);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pencil.onPointerUp(event)) return;
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    releaseGesture();
    if (useStore.getState().projectEpoch !== current.epoch) {
      setPreviewPoints(null);
      return;
    }
    if (current.kind === "trim"
      && !automationPointsEqual(current.valuePoints, current.originalPoints)) {
      writeCurve(current.valuePoints, current.originalPoints, current.previewToken);
    }
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pencil.onPointerCancel(event)) return;
    if (gesture.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    cancelGesture();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelGesture();
      setSelection(null);
      return;
    }
    if (clipboard.onKeyDown(event)) return;
    const direction = event.key === "+" || event.code === "NumpadAdd" ? 1
      : event.key === "-" || event.code === "NumpadSubtract" ? -1 : 0;
    if (direction !== 0 && selection) {
      const nudged = nudgeAutomationPoints(renderedPoints, selection, nudgeValue * direction);
      if (!automationPointsEqual(nudged, renderedPoints)) {
        event.preventDefault();
        writeCurve(nudged, renderedPoints);
      }
      return;
    }
    if ((event.key !== "Enter" && event.key !== " ") || !target) return;
    event.preventDefault();
    setHoveredIntent("breakpoint");
    addBreakpoint(position, 0.5);
  };

  return {
    clipboard,
    onEditKeyDown: clipboard.onKeyDown,
    onKeyDown,
    onPointerCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    renderedPoints,
    selection,
    setHoveredIntent,
    trimReadout,
  };
}
