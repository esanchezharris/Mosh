import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../store";
import type { AutoPoint } from "../types";
import {
  AUTOMATION_GRAPH_HEIGHT_PX,
  AUTOMATION_GRAPH_TOP_PX,
  automationLinePoints,
  automationSegmentPreview,
  normalizeAutomationSamples,
  type AutomationTarget,
} from "./automationEditing";
import { capturePointer, releasePointer } from "./pointerCapture";
import { useProTools } from "./proToolsState";

type PencilGesture = {
  readonly mode: "line" | "freehand";
  readonly element: HTMLButtonElement;
  readonly pointerId: number;
  readonly originalPoints: readonly AutoPoint[];
  readonly epoch: number;
  readonly previewToken: number;
  samples: AutoPoint[];
  valuePoints: readonly AutoPoint[];
};

type Options = {
  readonly trackId: string;
  readonly target: AutomationTarget | null;
  readonly points: readonly AutoPoint[];
  readonly pxPerSec: number;
  readonly graphTopPx?: number;
  readonly graphHeightPx?: number;
};

export function useProToolsAutomationPencil(options: Options) {
  const {
    trackId,
    target,
    points,
    pxPerSec,
    graphTopPx = AUTOMATION_GRAPH_TOP_PX,
    graphHeightPx = AUTOMATION_GRAPH_HEIGHT_PX,
  } = options;
  const exec = useStore((state) => state.exec);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const setHoveredIntent = useProTools((state) => state.setHoveredIntent);
  const [previewPoints, setPreviewPoints] = useState<readonly AutoPoint[] | null>(null);
  const gesture = useRef<PencilGesture | null>(null);
  const previewToken = useRef(0);

  const cancel = () => {
    previewToken.current += 1;
    const current = gesture.current;
    if (current) releasePointer(current.element, current.pointerId);
    gesture.current = null;
    setPreviewPoints(null);
  };

  useEffect(() => cancel(), [projectEpoch, trackId, target?.pluginIndex, target?.paramIndex]);
  useEffect(() => cancel(), [points]);
  useEffect(() => () => {
    const current = gesture.current;
    if (current) releasePointer(current.element, current.pointerId);
  }, []);

  const pointAt = (event: ReactPointerEvent<HTMLButtonElement>): AutoPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      t: Math.max(0, (event.clientX - rect.left) / pxPerSec),
      v: Math.min(1, Math.max(0,
        1 - (event.clientY - rect.top - graphTopPx) / graphHeightPx)),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.ctrlKey || !target) return false;
    const point = pointAt(event);
    gesture.current = {
      mode: event.metaKey ? "freehand" : "line",
      element: event.currentTarget,
      pointerId: event.pointerId,
      originalPoints: points,
      epoch: useStore.getState().projectEpoch,
      previewToken: ++previewToken.current,
      samples: [point],
      valuePoints: [point],
    };
    setHoveredIntent("pencil");
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    capturePointer(event.currentTarget, event.pointerId);
    return true;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    const sample = pointAt(event);
    current.samples.push(sample);
    current.valuePoints = current.mode === "line"
      ? automationLinePoints(current.samples[0], sample)
      : normalizeAutomationSamples(current.samples);
    setPreviewPoints(automationSegmentPreview(current.originalPoints, current.valuePoints));
    return true;
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId || !target) return false;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = null;
    releasePointer(event.currentTarget, event.pointerId);
    if (useStore.getState().projectEpoch !== current.epoch) {
      setPreviewPoints(null);
      return true;
    }
    const first = current.valuePoints[0];
    const last = current.valuePoints[current.valuePoints.length - 1];
    if (!first || !last) return true;
    const pending = current.valuePoints.length === 1
      ? exec("add_automation_point", {
        trackId,
        pluginIndex: target.pluginIndex,
        paramIndex: target.paramIndex,
        time: first.t,
        value: first.v,
      })
      : exec("write_automation_curve", {
        trackId,
        pluginIndex: target.pluginIndex,
        paramIndex: target.paramIndex,
        apply: "replace",
        replaceStart: first.t,
        replaceEnd: last.t,
        points: current.valuePoints,
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
    return true;
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    cancel();
    return true;
  };

  return { cancel, onPointerCancel, onPointerDown, onPointerMove, onPointerUp, previewPoints };
}
