import { useEffect, useRef, useState } from "react";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { useStore } from "../store";
import type { Clip, ClipGainPoint } from "../types";
import {
  CLIP_GAIN_MAX_DB,
  CLIP_GAIN_MIN_DB,
  clampClipGain,
  clipGainAfterVerticalDrag,
  clipGainFromKey,
  clipGainLinePercent,
} from "./clipGain";
import { capturePointer, releasePointer } from "./pointerCapture";
import { ProToolsClipGainEnvelope } from "./ProToolsClipGainEnvelope";

type ProToolsClipGainProps = {
  readonly clip: Clip;
  readonly onPreviewGainChange: (gainDb: number | null) => void;
  readonly onPreviewPointsChange: (points: readonly ClipGainPoint[] | null) => void;
};

type GainOverlayStyle = React.CSSProperties & {
  "--pt-clip-gain-y": string;
};

type GainDrag = {
  readonly pointerId: number;
  readonly startY: number;
  readonly initialDb: number;
  readonly epoch: number;
  valueDb: number;
};

export function ProToolsClipGain({ clip, onPreviewGainChange,
  onPreviewPointsChange }: ProToolsClipGainProps) {
  const pxPerSec = useStore((state) => state.pxPerSec);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const selected = useStore((state) => state.selection.has(clip.id));
  const exec = useStore((state) => state.exec);
  const snapshotGain = clampClipGain(clip.gainDb ?? 0);
  const [previewGain, setPreviewGain] = useState<number | null>(null);
  const handleRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<GainDrag | null>(null);
  const escapeDispose = useRef<(() => void) | null>(null);
  const gainDb = previewGain ?? snapshotGain;
  const overlayStyle: GainOverlayStyle = {
    left: clip.start * pxPerSec,
    width: Math.max(4, clip.length * pxPerSec),
    "--pt-clip-gain-y": `${clipGainLinePercent(gainDb)}%`,
  };

  const clearDraft = () => {
    const current = drag.current;
    if (current && handleRef.current) releasePointer(handleRef.current, current.pointerId);
    drag.current = null;
    escapeDispose.current?.();
    escapeDispose.current = null;
    setPreviewGain(null);
    onPreviewGainChange(null);
  };

  useEffect(() => {
    clearDraft();
  }, [clip.id, clip.gainDb, projectEpoch]);

  useEffect(() => () => escapeDispose.current?.(), []);

  const preview = (next: number) => {
    setPreviewGain(next);
    onPreviewGainChange(next);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      initialDb: gainDb,
      valueDb: gainDb,
      epoch: useStore.getState().projectEpoch,
    };
    capturePointer(event.currentTarget, event.pointerId);
    escapeDispose.current?.();
    escapeDispose.current = pushEscapeHandler(clearDraft);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLSpanElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    current.valueDb = clipGainAfterVerticalDrag(current.initialDb, event.clientY - current.startY);
    preview(current.valueDb);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLSpanElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = null;
    escapeDispose.current?.();
    escapeDispose.current = null;
    releasePointer(event.currentTarget, event.pointerId);
    if (useStore.getState().projectEpoch !== current.epoch) {
      setPreviewGain(null);
      onPreviewGainChange(null);
      return;
    }
    if (current.valueDb === current.initialDb) {
      setPreviewGain(null);
      onPreviewGainChange(null);
      return;
    }
    void exec("set_clip_gain", { clipId: clip.id, gainDb: current.valueDb });
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLSpanElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    clearDraft();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape" && drag.current) {
      event.preventDefault();
      event.stopPropagation();
      clearDraft();
      return;
    }
    const next = clipGainFromKey(gainDb, event.key);
    if (next === null || next === gainDb) return;
    event.preventDefault();
    event.stopPropagation();
    preview(next);
    void exec("set_clip_gain", { clipId: clip.id, gainDb: next });
  };

  return (
    <span className={`pt-clip-gain${selected ? " is-selected" : ""}`}
      data-testid="pt-clip-gain" style={overlayStyle}>
      <span className="pt-clip-gain-line" data-testid="pt-clip-gain-line" aria-hidden="true" />
      <ProToolsClipGainEnvelope clip={clip} selected={selected} staticGainDb={gainDb}
        onPreviewPointsChange={onPreviewPointsChange} />
      {selected && (
        <>
          <span ref={handleRef} className="pt-clip-gain-handle" data-testid="pt-clip-gain-handle"
            role="slider" tabIndex={0} aria-label={`${clip.name} clip gain`}
            aria-orientation="vertical" aria-valuemin={CLIP_GAIN_MIN_DB} aria-valuemax={CLIP_GAIN_MAX_DB}
            aria-valuenow={gainDb} aria-valuetext={`${gainDb.toFixed(1)} dB`}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onKeyDown={onKeyDown} />
          <span className="pt-clip-gain-value" aria-hidden="true">{gainDb.toFixed(1)} dB</span>
        </>
      )}
    </span>
  );
}
