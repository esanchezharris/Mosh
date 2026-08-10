import { useRef, useState } from "react";
import { useStore } from "../store";
import type { Clip, Track } from "../types";
import { capturePointer, releasePointer } from "./pointerCapture";
import { proToolsOverlappingAudioClip } from "./proToolsCrossfade";
import { proToolsFadeCurveFromType, proToolsFadePath } from "./proToolsFades";
import { useProTools } from "./proToolsState";

type Side = "in" | "out";

export function ProToolsFadeHandles({ clip, track }: { readonly clip: Clip; readonly track: Track }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const exec = useStore((s) => s.exec);
  const setHoveredIntent = useProTools((s) => s.setHoveredIntent);
  const [preview, setPreview] = useState<{ side: Side; seconds: number } | null>(null);
  const drag = useRef<{
    pointerId: number; startX: number; side: Side; initial: number; value: number; epoch: number;
  } | null>(null);
  const fadeIn = preview?.side === "in" ? preview.seconds : (clip.fadeInSec ?? 0);
  const fadeOut = preview?.side === "out" ? preview.seconds : (clip.fadeOutSec ?? 0);
  const overlappingClip = proToolsOverlappingAudioClip(clip, track);
  const outgoingClip = overlappingClip && clip.start <= overlappingClip.start ? clip : overlappingClip;
  const incomingClip = overlappingClip && outgoingClip?.id === clip.id ? overlappingClip : clip;
  const representedOverlap = outgoingClip && incomingClip
    ? Math.min(outgoingClip.start + outgoingClip.length, incomingClip.start + incomingClip.length)
      - Math.max(outgoingClip.start, incomingClip.start)
    : 0;
  const explicitCrossfade = overlappingClip !== null
    && outgoingClip?.id === clip.id
    && representedOverlap > 1e-6
    && Math.abs((outgoingClip.fadeOutSec ?? 0) - representedOverlap) <= 1e-6
    && Math.abs((incomingClip.fadeInSec ?? 0) - representedOverlap) <= 1e-6;
  const crossfadeNeighbor = clip.autoCrossfade === true || explicitCrossfade
    ? overlappingClip
    : null;
  const crossfadeMode = explicitCrossfade ? "explicit" : "auto";
  const crossfadeInCurve = explicitCrossfade
    ? proToolsFadeCurveFromType(incomingClip.fadeInType)
    : "sCurve";
  const crossfadeOutCurve = explicitCrossfade
    ? proToolsFadeCurveFromType(outgoingClip.fadeOutType)
    : "sCurve";
  const crossfadeStart = crossfadeNeighbor
    ? Math.max(clip.start, crossfadeNeighbor.start)
    : 0;
  const crossfadeEnd = crossfadeNeighbor
    ? Math.min(clip.start + clip.length, crossfadeNeighbor.start + crossfadeNeighbor.length)
    : 0;

  const commit = (side: Side, seconds: number) => {
    const args = side === "in" ? { fadeInSec: seconds } : { fadeOutSec: seconds };
    void exec("set_clip_fade", { clipId: clip.id, ...args });
  };

  const begin = (side: Side) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const initial = side === "in" ? (clip.fadeInSec ?? 0) : (clip.fadeOutSec ?? 0);
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      side,
      initial,
      value: initial,
      epoch: useStore.getState().projectEpoch,
    };
    setHoveredIntent(side === "in" ? "fade-in" : "fade-out");
    capturePointer(e.currentTarget, e.pointerId);
  };

  const move = (e: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== e.pointerId) return;
    const direction = current.side === "in" ? 1 : -1;
    const seconds = Math.min(clip.length, Math.max(0,
      current.initial + direction * (e.clientX - current.startX) / pxPerSec));
    current.value = seconds;
    setPreview({ side: current.side, seconds });
  };

  const finish = (e: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== e.pointerId) return;
    drag.current = null;
    releasePointer(e.currentTarget, e.pointerId);
    const value = current.value;
    setPreview(null);
    if (useStore.getState().projectEpoch === current.epoch && value !== current.initial)
      commit(current.side, value);
  };

  const cancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== e.pointerId) return;
    drag.current = null;
    releasePointer(e.currentTarget, e.pointerId);
    setPreview(null);
  };

  const keyAdjust = (side: Side) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const direction = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!direction) return;
    e.preventDefault();
    e.stopPropagation();
    const current = side === "in" ? fadeIn : fadeOut;
    commit(side, Math.min(clip.length, Math.max(0, current + direction * 0.01)));
  };

  return (
    <div className="pt-fades" style={{ left: clip.start * pxPerSec, width: Math.max(4, clip.length * pxPerSec) }}>
      {crossfadeNeighbor && (
        <div className="pt-crossfade-region" data-testid="pt-crossfade-region"
          data-crossfade-mode={crossfadeMode}
          style={{
            left: (crossfadeStart - clip.start) * pxPerSec,
            width: (crossfadeEnd - crossfadeStart) * pxPerSec,
          }}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path className="in" d={proToolsFadePath(crossfadeInCurve, "in")} />
            <path className="out" d={proToolsFadePath(crossfadeOutCurve, "out")} />
          </svg>
        </div>
      )}
      <div className="pt-fade-line in" style={{ width: fadeIn * pxPerSec }} aria-hidden="true">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d={proToolsFadePath(proToolsFadeCurveFromType(clip.fadeInType), "in")} />
        </svg>
      </div>
      <div className="pt-fade-line out" style={{ width: fadeOut * pxPerSec }} aria-hidden="true">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d={proToolsFadePath(proToolsFadeCurveFromType(clip.fadeOutType), "out")} />
        </svg>
      </div>
      {(["in", "out"] as const).map((side) => (
        <button key={side} type="button" className={`pt-fade-handle ${side}`}
          aria-label={`${side === "in" ? "Fade in" : "Fade out"} ${clip.name}`}
          onPointerEnter={() => setHoveredIntent(side === "in" ? "fade-in" : "fade-out")}
          onPointerLeave={() => { if (!drag.current) setHoveredIntent(null); }}
          onPointerDown={begin(side)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel}
          onKeyDown={keyAdjust(side)} />
      ))}
    </div>
  );
}
