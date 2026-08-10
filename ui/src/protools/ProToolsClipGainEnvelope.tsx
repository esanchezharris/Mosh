import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Clip, ClipGainPoint } from "../types";
import { clipGainLinePercent } from "./clipGain";
import {
  CLIP_GAIN_ENVELOPE_MAX_DB,
  CLIP_GAIN_ENVELOPE_MIN_DB,
  CLIP_GAIN_ENVELOPE_STEP_DB,
  clipGainEnvelopePath,
  insertClipGainPoint,
  moveClipGainPoint,
  clipGainPointAfterDrag,
} from "./clipGainEnvelope";
import { capturePointer, releasePointer } from "./pointerCapture";
import { useProTools } from "./proToolsState";

type Props = {
  readonly clip: Clip;
  readonly selected: boolean;
  readonly staticGainDb: number;
};

type PointDrag = {
  readonly element: HTMLButtonElement;
  readonly pointerId: number;
  readonly index: number;
  readonly startX: number;
  readonly startY: number;
  readonly original: readonly ClipGainPoint[];
  readonly epoch: number;
  points: readonly ClipGainPoint[];
};

const samePoints = (left: readonly ClipGainPoint[], right: readonly ClipGainPoint[]) =>
  JSON.stringify(left) === JSON.stringify(right);

export function ProToolsClipGainEnvelope({ clip, selected, staticGainDb }: Props) {
  const exec = useStore((state) => state.exec);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const playhead = useStore((state) => state.transport.position);
  const smartToolEnabled = useProTools((state) => state.smartToolEnabled);
  const activeTool = useProTools((state) => state.activeTool);
  const nudgeValue = useProTools((state) => state.nudgeValue);
  const editable = selected && (smartToolEnabled || activeTool === "grabber");
  const snapshotPoints = clip.clipGainPoints ?? [];
  const [previewPoints, setPreviewPoints] = useState<readonly ClipGainPoint[] | null>(null);
  const envelopeRef = useRef<SVGSVGElement>(null);
  const drag = useRef<PointDrag | null>(null);
  const writeToken = useRef(0);
  const points = previewPoints ?? snapshotPoints;

  const cancelDraft = () => {
    const current = drag.current;
    if (current) releasePointer(current.element, current.pointerId);
    drag.current = null;
    setPreviewPoints(null);
  };

  useEffect(() => cancelDraft(), [clip.id, clip.clipGainPoints, projectEpoch]);
  useEffect(() => () => {
    const current = drag.current;
    if (current) releasePointer(current.element, current.pointerId);
  }, []);

  const write = (next: readonly ClipGainPoint[], previous: readonly ClipGainPoint[] = points) => {
    if (samePoints(next, previous)) return;
    const token = ++writeToken.current;
    setPreviewPoints(next);
    void exec("write_clip_gain_curve", { clipId: clip.id, points: next }).then(
      (result) => {
        if (!result.ok && writeToken.current === token) setPreviewPoints(null);
      },
      () => {
        if (writeToken.current === token) setPreviewPoints(null);
      },
    );
  };

  const addAt = (time: number) => write(insertClipGainPoint(points, time, clip.length));

  const onLinePointerDown = (event: React.PointerEvent<SVGPathElement>) => {
    if (!editable || event.button !== 0) return;
    const rect = envelopeRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    addAt((event.clientX - rect.left) / rect.width * clip.length);
  };

  const onPointPointerDown = (event: React.PointerEvent<HTMLButtonElement>, index: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    drag.current = {
      element: event.currentTarget,
      pointerId: event.pointerId,
      index,
      startX: event.clientX,
      startY: event.clientY,
      original: points,
      points,
      epoch: useStore.getState().projectEpoch,
    };
    capturePointer(event.currentTarget, event.pointerId);
  };

  const onPointPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const width = envelopeRef.current?.getBoundingClientRect().width ?? 0;
    current.points = clipGainPointAfterDrag(
      current.original,
      current.index,
      event.clientX - current.startX,
      event.clientY - current.startY,
      width,
      clip.length,
    );
    setPreviewPoints(current.points);
  };

  const onPointPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    releasePointer(current.element, current.pointerId);
    drag.current = null;
    if (useStore.getState().projectEpoch !== current.epoch) {
      setPreviewPoints(null);
      return;
    }
    if (!samePoints(current.points, current.original)) write(current.points, current.original);
  };

  const onPointKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape" && drag.current) {
      event.preventDefault();
      event.stopPropagation();
      cancelDraft();
      return;
    }
    let next: readonly ClipGainPoint[] | null = null;
    const point = points[index];
    if (!point) return;
    if (event.key === "Delete" || event.key === "Backspace")
      next = points.filter((_, pointIndex) => pointIndex !== index);
    else if (event.key === "ArrowUp" || event.key === "ArrowDown")
      next = moveClipGainPoint(points, index, point.t,
        point.gainDb + (event.key === "ArrowUp" ? CLIP_GAIN_ENVELOPE_STEP_DB : -CLIP_GAIN_ENVELOPE_STEP_DB),
        clip.length);
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight")
      next = moveClipGainPoint(points, index,
        point.t + (event.key === "ArrowRight" ? nudgeValue : -nudgeValue), point.gainDb, clip.length);
    if (!next || samePoints(next, points)) return;
    event.preventDefault();
    event.stopPropagation();
    write(next);
  };

  const path = clipGainEnvelopePath(points, clip.length, staticGainDb);
  const visiblePoints = points.map((point, index) => ({ point, index }))
    .filter(({ point }) => point.t >= 0 && point.t <= clip.length);
  const keyboardTime = playhead >= clip.start && playhead <= clip.start + clip.length
    ? playhead - clip.start : clip.length / 2;

  return (
    <>
      <svg ref={envelopeRef} className="pt-clip-gain-envelope"
        data-testid="pt-clip-gain-envelope" viewBox="0 0 100 100" preserveAspectRatio="none"
        aria-hidden="true">
        {points.length > 0 && <path className="pt-clip-gain-envelope-line" d={path} />}
        {editable && <path className="pt-clip-gain-envelope-hit" data-testid="pt-clip-gain-line-hit"
          d={path} onPointerDown={onLinePointerDown} />}
      </svg>
      {editable && visiblePoints.map(({ point, index }) => {
        const totalGain = staticGainDb + point.gainDb;
        return <button key={index} type="button" className="pt-clip-gain-point"
          data-testid="pt-clip-gain-point" role="slider" aria-orientation="vertical"
          aria-label={`${clip.name} clip gain breakpoint ${index + 1}`}
          aria-valuemin={CLIP_GAIN_ENVELOPE_MIN_DB} aria-valuemax={CLIP_GAIN_ENVELOPE_MAX_DB}
          aria-valuenow={point.gainDb}
          aria-valuetext={`${totalGain.toFixed(1)} dB clip gain (${point.gainDb >= 0 ? "+" : ""}${point.gainDb.toFixed(1)} dB dynamic)`}
          style={{ left: `${point.t / clip.length * 100}%`, top: `${clipGainLinePercent(totalGain)}%` }}
          onPointerDown={(event) => onPointPointerDown(event, index)}
          onPointerMove={onPointPointerMove} onPointerUp={onPointPointerUp}
          onPointerCancel={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            event.preventDefault();
            event.stopPropagation();
            cancelDraft();
          }}
          onKeyDown={(event) => onPointKeyDown(event, index)} />;
      })}
      {editable && <button type="button" className="pt-clip-gain-add"
        aria-label={`Add ${clip.name} clip gain breakpoint at playhead`}
        onClick={() => addAt(keyboardTime)}>+</button>}
    </>
  );
}
