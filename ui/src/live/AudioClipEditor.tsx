import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { ClipWave } from "../ui/clipRenderers";
import type { Clip } from "../types";
import { ClipLoopBar } from "./ClipLoopBar";

type AudioClipEditorProps = {
  readonly clip: Clip;
  readonly onClose: () => void;
};

const sourceBasename = (sourceFile: string | undefined): string =>
  sourceFile?.split(/[\\/]/).pop() || "Source unavailable";

const clampToLength = (value: number, length: number): number => Math.max(0, Math.min(value, length));

export function AudioClipEditor({ clip, onClose }: AudioClipEditorProps) {
  const exec = useStore((s) => s.exec);
  const ensurePeaks = useStore((s) => s.ensurePeaks);
  const peaks = useStore((s) => s.peaks[clip.id]);
  const waveformRef = useRef<HTMLDivElement>(null);
  const [waveformWidth, setWaveformWidth] = useState(1);
  const gainDb = clip.gainDb ?? 0;
  const fadeInSec = clampToLength(clip.fadeInSec ?? 0, clip.length);
  const fadeOutSec = clampToLength(clip.fadeOutSec ?? 0, clip.length);

  useEffect(() => {
    if (!clip.sourceMissing) ensurePeaks(clip.id);
  }, [clip.id, clip.sourceFile, clip.sourceMissing, ensurePeaks]);

  useEffect(() => {
    const waveform = waveformRef.current;
    if (!waveform) return;
    const updateWidth = () => setWaveformWidth(Math.max(1, waveform.clientWidth));
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(waveform);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div className="live-dock-head">
        <span className="live-dock-title">Clip — {clip.name}</span>
        <button
          className="live-dock-close"
          data-testid="live-dock-close"
          aria-label="Close the detail view"
          title="Close the detail view"
          onClick={onClose}
        >×</button>
      </div>
      <section className="live-audio-editor" data-testid="live-audio-clip-editor" data-clip-id={clip.id} aria-label={`${clip.name} audio clip editor`}>
        <div className="live-audio-meta">
          <span data-testid="live-audio-source">{sourceBasename(clip.sourceFile)}</span>
          {clip.sourceLength != null && <span>{clip.sourceLength.toFixed(2)}s</span>}
          {clip.sourceMissing && <span className="live-audio-source-missing">Source unavailable</span>}
        </div>
        <div ref={waveformRef} className="live-audio-waveform" data-testid="live-audio-waveform">
          {clip.sourceMissing ? (
            <p data-testid="live-audio-waveform-status">Waveform unavailable — source file is missing</p>
          ) : peaks ? (
            <ClipWave peaks={peaks} width={waveformWidth} />
          ) : (
            <p data-testid="live-audio-waveform-status">Loading waveform…</p>
          )}
        </div>
        <div className="live-audio-controls">
          <label>
            <span>Gain (dB)</span>
            <input
              key={`${clip.id}-gain-${gainDb}`}
              type="number"
              min={-48}
              max={24}
              step={0.5}
              defaultValue={gainDb}
              data-testid="live-audio-gain"
              onBlur={(event) => {
                const next = Number(event.currentTarget.value);
                if (Number.isFinite(next) && next !== gainDb)
                  void exec("set_clip_gain", { clipId: clip.id, gainDb: next });
              }}
            />
          </label>
          <label>
            <span>Fade in (seconds)</span>
            <input
              key={`${clip.id}-fade-in-${fadeInSec}`}
              type="number"
              min={0}
              max={clip.length}
              step={0.01}
              defaultValue={fadeInSec}
              data-testid="live-audio-fade-in"
              onBlur={(event) => {
                const next = clampToLength(Number(event.currentTarget.value), clip.length);
                if (Number.isFinite(next) && next !== fadeInSec)
                  void exec("set_clip_fade", { clipId: clip.id, fadeInSec: next });
              }}
            />
          </label>
          <label>
            <span>Fade out (seconds)</span>
            <input
              key={`${clip.id}-fade-out-${fadeOutSec}`}
              type="number"
              min={0}
              max={clip.length}
              step={0.01}
              defaultValue={fadeOutSec}
              data-testid="live-audio-fade-out"
              onBlur={(event) => {
                const next = clampToLength(Number(event.currentTarget.value), clip.length);
                if (Number.isFinite(next) && next !== fadeOutSec)
                  void exec("set_clip_fade", { clipId: clip.id, fadeOutSec: next });
              }}
            />
          </label>
          <button
            className={clip.reversed ? "on" : ""}
            aria-pressed={!!clip.reversed}
            data-testid="live-audio-reverse"
            onClick={() => void exec("set_clip_reverse", { clipId: clip.id, reversed: !clip.reversed })}
          >Reverse</button>
          <button
            data-testid="live-audio-normalize"
            title="Normalize to 0 dBFS"
            onClick={() => void exec("normalize_clip", { clipId: clip.id, targetDb: 0 })}
          >Normalize to 0 dBFS</button>
        </div>
        <ClipLoopBar clip={clip} />
      </section>
    </>
  );
}
