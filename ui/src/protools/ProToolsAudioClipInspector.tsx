import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Clip, Track } from "../types";
import { IconClose } from "../ui/icons";

const MIN_GAIN_DB = -48;
const MAX_GAIN_DB = 24;

function formatSeconds(seconds: number): string {
  return `${Math.max(0, seconds).toFixed(3)} s`;
}

export function ProToolsAudioClipInspector({ clip, track, onClose }: {
  readonly clip: Clip;
  readonly track: Track;
  readonly onClose: () => void;
}) {
  const exec = useStore((state) => state.exec);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const editEpoch = useRef(projectEpoch);
  const snapshotGain = clip.gainDb ?? 0;
  const [name, setName] = useState(clip.name);
  const [nameInvalid, setNameInvalid] = useState(false);
  const [gainDraft, setGainDraft] = useState(snapshotGain);
  const [gainText, setGainText] = useState(String(snapshotGain));
  const [gainError, setGainError] = useState<string | null>(null);

  const resetGain = () => {
    setGainDraft(snapshotGain);
    setGainText(String(snapshotGain));
    setGainError(null);
  };

  useEffect(() => {
    editEpoch.current = projectEpoch;
    setName(clip.name);
    setNameInvalid(false);
    setGainDraft(snapshotGain);
    setGainText(String(snapshotGain));
    setGainError(null);
  }, [clip.id, clip.name, projectEpoch, snapshotGain]);

  const currentProject = () => useStore.getState().projectEpoch === editEpoch.current;
  const commitName = () => {
    const next = name.trim();
    if (!next) {
      setNameInvalid(true);
      return;
    }
    setNameInvalid(false);
    if (currentProject() && next !== clip.name)
      void exec("rename_clip", { clipId: clip.id, name: next });
  };
  const commitGain = (next: number) => {
    if (!Number.isFinite(next) || next < MIN_GAIN_DB || next > MAX_GAIN_DB) {
      setGainError("Clip gain must be between -48 and +24 dB.");
      return;
    }
    if (!currentProject()) {
      resetGain();
      return;
    }
    setGainDraft(next);
    setGainText(String(next));
    setGainError(null);
    if (next !== snapshotGain) void exec("set_clip_gain", { clipId: clip.id, gainDb: next });
  };

  return (
    <>
      <header className="pt-detail-head">
        <span className="pt-detail-title">Clip — {clip.name}</span>
        <button type="button" className="pt-detail-close" data-testid="pt-detail-close"
          aria-label="Close clip editor" title="Close clip editor" onClick={onClose}>
          <IconClose size={13} />
        </button>
      </header>
      <div className="pt-wave-inspector" data-testid="pt-wave-inspector">
        <div className="pt-wave-preview" aria-hidden="true">
          <span style={{ backgroundColor: track.color ?? "var(--pt-selected)" }} />
          <i /><i /><i /><i /><i /><i /><i />
        </div>
        <section className="pt-clip-editor-fields" data-testid="pt-audio-clip-inspector" aria-label={`${clip.name} audio clip controls`}>
          <label className="pt-clip-name-control">Name
            <input data-testid="pt-clip-name" value={name} aria-invalid={nameInvalid}
              aria-describedby={nameInvalid ? "pt-clip-name-error" : undefined}
              onChange={(event) => { setName(event.target.value); setNameInvalid(false); }}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitName();
                if (event.key === "Escape") { setName(clip.name); setNameInvalid(false); }
              }} />
          </label>
          {nameInvalid && <span id="pt-clip-name-error" className="pt-field-error" role="alert">Clip name cannot be empty.</span>}
          <div className="pt-clip-gain-control">
            <label htmlFor="pt-clip-gain-slider">Clip Gain</label>
            <input id="pt-clip-gain-slider" type="range" min={MIN_GAIN_DB} max={MAX_GAIN_DB} step={0.1}
              data-testid="pt-clip-gain-slider" value={gainDraft}
              onChange={(event) => {
                const next = Number(event.target.value);
                setGainDraft(next);
                setGainText(String(next));
                setGainError(null);
              }}
              onPointerUp={() => commitGain(gainDraft)}
              onPointerCancel={resetGain}
              onKeyUp={(event) => { if (event.key !== "Escape") commitGain(gainDraft); }}
              onKeyDown={(event) => { if (event.key === "Escape") resetGain(); }} />
            <input type="number" min={MIN_GAIN_DB} max={MAX_GAIN_DB} step={0.1}
              data-testid="pt-clip-gain-number" value={gainText} aria-label="Clip gain in decibels"
              aria-invalid={gainError !== null} aria-describedby={gainError ? "pt-clip-gain-error" : undefined}
              onChange={(event) => { setGainText(event.target.value); setGainError(null); }}
              onBlur={() => commitGain(Number(gainText))}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitGain(Number(gainText));
                if (event.key === "Escape") resetGain();
              }} />
            <span aria-hidden="true">dB</span>
            <button type="button" data-testid="pt-clip-gain-reset" onClick={() => commitGain(0)}>0 dB</button>
          </div>
          {gainError && <span id="pt-clip-gain-error" className="pt-field-error" role="alert">{gainError}</span>}
          <button type="button" className="pt-clip-mute" data-testid="pt-clip-mute"
            aria-pressed={Boolean(clip.mute)} onClick={() => {
              if (currentProject()) void exec("set_clip_mute", { clipId: clip.id, mute: !clip.mute });
            }}>{clip.mute ? "Unmute Clip" : "Mute Clip"}</button>
          <dl className="pt-clip-fields">
            <div><dt>Track</dt><dd>{track.name}</dd></div>
            <div><dt>Start</dt><dd>{formatSeconds(clip.start)}</dd></div>
            <div><dt>Length</dt><dd>{formatSeconds(clip.length)}</dd></div>
            <div><dt>Fade In</dt><dd>{formatSeconds(clip.fadeInSec ?? 0)}</dd></div>
            <div><dt>Fade Out</dt><dd>{formatSeconds(clip.fadeOutSec ?? 0)}</dd></div>
          </dl>
        </section>
      </div>
    </>
  );
}
