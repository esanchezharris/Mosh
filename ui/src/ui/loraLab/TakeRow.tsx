// One take: play it, look at it, keep or bin it.
//
// The waveform is the widest element on the row, and that is the whole design
// argument. The alternative — a table of step counts and loss values with a
// small play button — optimises for the numbers, and the numbers are exactly
// what proved untrustworthy: the eval probe stayed flat (0.885 -> 0.899) across
// a run whose adapters improved from 0.744 to 0.884 by every other measure, and
// a 25-epoch take beat a 44-epoch one scoring 0.14 higher. So the row is built
// for the ear: a big play target, a shape you can scan, and the step number
// present but quiet.
//
// There is deliberately NO quality score here, and there will not be one. A
// number beside a play button becomes the thing people sort by, and this
// particular number has repeatedly pointed the wrong way. It belongs in
// Diagnostics, labelled as a divergence check, or nowhere.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import { renderKey, type LabTake } from "../../store/loraLab";
import { executeCommand } from "../../bridge";
import type { CommandResult } from "../../types";

/** The stock model. Rendered as a row so the baseline is one click away, not a
 *  mode you have to remember to set up — "is this better?" is unanswerable
 *  without it. */
export type TakeRowModel = LabTake | { name: null; step: -1; isFinal: false; landedAt: number };

function Waveform({ peaks, playing }: { peaks?: [number, number][]; playing: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const w = c.clientWidth || 300, h = c.clientHeight || 40;
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!peaks?.length) return;
    // Paint from the computed accent so the row follows the Lab's agentic scope
    // rather than pinning a colour a theme change would strand.
    const cs = getComputedStyle(c);
    ctx.fillStyle = cs.getPropertyValue("--v2-accent").trim() || "#b8e62e";
    ctx.globalAlpha = playing ? 1 : 0.62;
    const mid = h / 2;
    const step = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const [lo, hi] = peaks[i];
      const y0 = mid - Math.max(0.5, hi * mid);
      const y1 = mid - Math.min(-0.5, lo * mid);
      ctx.fillRect(i * step, y0, Math.max(0.7, step - 0.4), Math.max(1, y1 - y0));
    }
  }, [peaks, playing]);
  return <canvas ref={ref} className="lab-wave" data-testid="lab-wave" aria-hidden="true" />;
}

export function TakeRow({ take }: { take: TakeRowModel }) {
  const name = take.name;
  const key = renderKey(name);
  const render = useStore((s) => s.labRenders[key]);
  const cued = useStore((s) => s.labCued);
  const audition = useStore((s) => s.auditionLabTake);
  const stop = useStore((s) => s.stopLabAudition);
  const dismiss = useStore((s) => s.dismissLabTake);
  const setCued = useStore((s) => s.setLabCued);
  const promptSet = useStore((s) => s.labPrompt.trim().length > 0);
  const promote = useStore((s) => s.promoteLabTake);
  const keeping = useStore((s) => s.labKeeping);
  const keepError = useStore((s) => (name ? s.labKeepError[name] : ""));

  // Keep opens a name field rather than firing immediately. The name is what the
  // adapter is called forever after, in a rack the producer reads at a glance —
  // and promotion REFUSES to overwrite, so a silent default would just bounce off
  // the second checkpoint they tried to keep from the same run.
  const [naming, setNaming] = useState(false);
  const [keptName, setKeptName] = useState("");

  const isCued = cued === name;
  const status = render?.status;
  const playing = isCued && status === "ready";

  // Peaks are fetched once per rendered take and cached on the render record.
  // file_peaks is a read-only path-addressed call — no clip, no import.
  const peaksLoaded = useRef<string | null>(null);
  useEffect(() => {
    const path = render?.outputWav;
    if (status !== "ready" || !path || peaksLoaded.current === path || render?.peaks) return;
    peaksLoaded.current = path;
    void executeCommand<CommandResult<{ peaks: [number, number][] }>>({
      command: "file_peaks", args: { path, buckets: 260 },
    }).then((r) => {
      if (!r.ok || !r.data?.peaks) return;
      useStore.setState((s) => ({
        labRenders: { ...s.labRenders, [key]: { ...s.labRenders[key], peaks: r.data!.peaks } },
      }));
    });
  }, [status, render?.outputWav, render?.peaks, key]);

  const label = name === null
    ? "Base model"
    : take.isFinal ? "Final" : `Step ${take.step}`;
  const sub = name === null
    ? "no adapter — the comparison"
    : name;

  return (
    <div className={`lab-take${isCued ? " on" : ""}`} data-testid={`lab-take-${name ?? "base"}`}>
      <button
        className={`btn lab-play${playing ? " on" : ""}`}
        disabled={!promptSet}
        title={!promptSet ? "Write a prompt first — a take needs something to render"
               : playing ? "Stop" : "Audition this take"}
        aria-label={playing ? `Stop ${label}` : `Audition ${label}`}
        onClick={() => (playing ? stop() : void audition(name))}
      >{status === "rendering" ? "◌" : playing ? "■" : "▶"}</button>

      <div className="lab-take-id">
        <span className="lab-take-label display">{label}</span>
        <span className="lab-take-sub" title={sub}>{sub}</span>
      </div>

      <div className="lab-take-wave">
        {status === "rendering" && (
          <div className="lab-take-note" data-testid="lab-take-rendering">
            rendering{render && render.progress > 0 ? ` · ${Math.round(render.progress * 100)}%` : "…"}
          </div>
        )}
        {status === "error" && (
          <div className="lab-take-note err" data-testid="lab-take-error">{render?.error || "render failed"}</div>
        )}
        {status === "ready" && <Waveform peaks={render?.peaks} playing={playing} />}
        {!status && <div className="lab-take-note dim">not rendered yet</div>}
      </div>

      {/* Cue is a SELECTION, not playback: it marks which take you are judging so
          the A/B stays put while a slower one renders. Distinct from play on
          purpose — the two got conflated in the first sketch and made it
          impossible to line up a comparison. */}
      <button
        className={`mode-btn lab-cue${isCued ? " on" : ""}`}
        aria-pressed={isCued}
        title="Cue this take for comparison"
        onClick={() => setCued(isCued ? null : name)}
      >◑</button>

      {/* Keep — the one non-disposable action in the Lab. Everything else here
          can be undone by doing it again; this writes into the producer's
          library, outside the edit, where undo does not reach. */}
      {name !== null && (
        <button
          className="btn ghost lab-keep"
          data-testid={`lab-keep-${name}`}
          disabled={keeping === name}
          title="Keep this take — copies it into your library so it survives deleting the run"
          aria-label={`Keep ${label}`}
          onClick={() => {
            setKeptName(keptName || name.split("@")[0]);
            setNaming(!naming);
          }}
        >{keeping === name ? "…" : "Keep"}</button>
      )}

      {name !== null && (
        <button
          className="btn x"
          title="Hide from the sheet — the checkpoint is kept on disk"
          aria-label={`Hide ${label}`}
          onClick={() => dismiss(name)}
        >✕</button>
      )}

      {name !== null && naming && (
        <form
          className="lab-keep-name"
          data-testid={`lab-keep-form-${name}`}
          onSubmit={(e) => {
            e.preventDefault();
            void promote(name, keptName).then((okd) => { if (okd) setNaming(false); });
          }}
        >
          <input
            value={keptName}
            aria-label="Name for the kept adapter"
            placeholder="name it"
            autoFocus
            onChange={(e) => setKeptName(e.target.value)}
          />
          <button className="btn primary" type="submit" disabled={keeping === name}>Keep</button>
          <button className="btn ghost" type="button" onClick={() => setNaming(false)}>Cancel</button>
        </form>
      )}

      {name !== null && keepError ? (
        <div className="lab-take-note err" data-testid={`lab-keep-error-${name}`}>{keepError}</div>
      ) : null}
    </div>
  );
}
