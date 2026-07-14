// Open Lanes (v3) — the arrangement slab's lane stack. Each track is a chrome-off lane:
// at rest it's pure hue-tinted content; on hover/focus the name + M/S controls fade in
// (progressive disclosure). Stage 1 renders a compact clip preview per lane (clips as
// positioned hue blocks); Stage 2 swaps the focused body for the real inline editors
// (drum step-grid / MIDI piano-roll / audio waveform) reusing the proven renderers.

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { useOpenLanes } from "./state";
import { trackHue } from "./palette";
import type { Snapshot, Track } from "../types";

function songSpanSec(snapshot: Snapshot): number {
  let end = snapshot.session.length ?? 0;
  for (const tr of snapshot.tracks)
    for (const c of tr.clips)
      if (!c.hidden) end = Math.max(end, c.start + c.length);
  return Math.max(end, 1);
}

// A lane's compact preview: the track's clips drawn as rounded hue blocks positioned
// across the song span. Real snapshot data (clip.start/length in seconds), DPR-scaled.
// A ResizeObserver redraws on layout/size changes — the parent .ol-ed is absolutely
// positioned and starts at 0×0 until the flex lane settles, so the observer (not a bare
// effect) is what guarantees a correct-width draw. Redraws too when clips/span change.
function LanePreview({ track, hue, span }: { track: Track; hue: string; span: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const clips = track.clips.filter((c) => !c.hidden);
  // A stable signature of what affects the drawing, so the effect re-subscribes on change.
  const sig = clips.map((c) => `${c.id}:${c.start.toFixed(3)}:${c.length.toFixed(3)}`).join("|") + `@${span.toFixed(2)}#${hue}`;
  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = parent.clientWidth, h = parent.clientHeight;
      if (w === 0 || h === 0) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const pad = 6;
      for (const c of clips) {
        const x = pad + (c.start / span) * (w - pad * 2);
        const cw = Math.max(3, (c.length / span) * (w - pad * 2));
        const y = h * 0.24, bh = h * 0.52;
        ctx.fillStyle = hue;
        ctx.globalAlpha = 0.2;
        roundRect(ctx, x, y, cw, bh, 4);
        ctx.fill();
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = hue;
        ctx.lineWidth = 1;
        roundRect(ctx, x + 0.5, y + 0.5, cw - 1, bh - 1, 4);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps -- sig captures clips/span/hue
  return <canvas ref={ref} data-testid={`v3-lane-canvas-${track.id}`} />;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function Lanes({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const focusIdx = useOpenLanes((s) => s.focusIdx);
  const setFocusIdx = useOpenLanes((s) => s.setFocusIdx);
  const span = songSpanSec(snapshot);
  const tracks = snapshot.tracks;

  if (tracks.length === 0)
    return <div className="ol-empty" data-testid="v3-empty">No tracks yet — ask Moshi to start something.</div>;

  return (
    <>
      {tracks.map((track, i) => {
        const hue = trackHue(track.index);
        const focused = focusIdx === i;
        return (
          <div key={track.id}
            className={`ol-lane${focused ? " focus" : ""}${track.mute ? " muted" : ""}${selectedTrackId === track.id ? " selected" : ""}`}
            style={{ ["--hue" as string]: hue, flex: focused ? "2 1 0" : "1 1 0", minHeight: "var(--ol-compact-h)" }}
            data-testid={`v3-lane-${track.id}`}
            onPointerDown={() => { setFocusIdx(i); setSelectedTrack(track.id); }}>
            <div className="ol-lhead">
              <span className="ol-grip" title="Drag to reorder" aria-hidden>⠿</span>
              <span className="ol-nm">{track.name || "Track"}</span>
              <span className="ol-lctl">
                <button className="ol-cbtn m" data-on={Boolean(track.mute)} title="Mute" aria-pressed={Boolean(track.mute)}
                  onClick={(e) => { e.stopPropagation(); void exec("set_track_mute", { trackId: track.id, mute: !track.mute }); }}>M</button>
                <button className="ol-cbtn s" data-on={Boolean(track.solo)} title="Solo" aria-pressed={Boolean(track.solo)}
                  onClick={(e) => { e.stopPropagation(); void exec("set_track_solo", { trackId: track.id, solo: !track.solo }); }}>S</button>
              </span>
            </div>
            <div className="ol-ed">
              <LanePreview track={track} hue={hue} span={span} />
            </div>
            <div className="ol-ph" />
          </div>
        );
      })}
    </>
  );
}
