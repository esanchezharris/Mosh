// Presentational clip-content renderers, shared by BOTH shells: classic's Arrange and
// v2's ClipView draw clip bodies through these exact components, so wave peaks, MIDI
// note blocks and drum step-grids look identical everywhere. Extracted verbatim from
// ui/Arrange.tsx so the v2 module graph no longer imports classic's arrangement view
// just to reach them (that import made the whole classic subtree look reachable to the
// UI-REACH probe). Pure drawing: no `exec(`, no store access, no command dispatch.

import { memo, useEffect, useRef } from "react";
import { type Peaks } from "../store";
import { DRUM_LANES, laneIndexForPitch } from "./drumGrid";
import type { MidiNote } from "../types";

// Shared canvas setup: size the backing store to devicePixelRatio, scale the context,
// and clear. Returns null until the canvas + 2D context are ready.
function prepCanvas(cv: HTMLCanvasElement | null): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  if (!cv) return null;
  const dpr = window.devicePixelRatio || 1;
  const h = cv.clientHeight, w = cv.clientWidth;
  cv.width = Math.max(1, Math.floor(w * dpr)); cv.height = Math.max(1, Math.floor(h * dpr));
  const ctx = cv.getContext("2d"); if (!ctx) return null;
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export const ClipWave = memo(function ClipWave({ peaks, width }: { peaks?: Peaks; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!peaks) return;
    const prep = prepCanvas(ref.current); if (!prep) return;
    const { ctx, w, h } = prep;
    ctx.fillStyle = "rgba(204,255,35,0.5)";
    const mid = h / 2, n = peaks.length;
    for (let x = 0; x < w; x++) {
      const p = peaks[Math.min(n - 1, Math.floor((x / w) * n))];
      if (!p) continue;
      const top = mid + p[0] * mid * 0.92, bot = mid + p[1] * mid * 0.92;
      ctx.fillRect(x, top, 1, Math.max(1, bot - top));
    }
  }, [peaks, width]);
  return <canvas ref={ref} />;
});

// A MIDI clip reads as "drums" when most of its notes land on GM percussion keys
// (the same lanes the drum sequencer uses); melodic clips get the piano preview.
export function isDrumClip(notes?: MidiNote[]): boolean {
  const ns = notes ?? [];
  if (ns.length === 0) return false;
  const onLane = ns.filter((n) => laneIndexForPitch(n.pitch) >= 0).length;
  return onLane >= ns.length * 0.7;
}

// Inline MIDI preview — pitch-mapped note blocks. Notes carry clip-local beats;
// beatSeconds(meter) → seconds, then the shared secToPx scale lands them on the
// same grid the ruler/playhead use. Double-click the clip still opens the PianoRoll.
export const ClipMidi = memo(function ClipMidi({ notes, width, bs, secToPx }:
  { notes?: MidiNote[]; width: number; bs: number; secToPx: (s: number) => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const prep = prepCanvas(ref.current); if (!prep) return;
    const { ctx, h } = prep;
    const ns = notes ?? []; if (ns.length === 0) return;

    // Vertical range from the clip's own pitches (padded); fixed window if degenerate.
    let lo = Infinity, hi = -Infinity;
    for (const n of ns) { if (n.pitch < lo) lo = n.pitch; if (n.pitch > hi) hi = n.pitch; }
    if (hi - lo < 4) { const c = Math.round((lo + hi) / 2 || 60); lo = c - 6; hi = c + 6; }
    else { lo -= 1; hi += 1; }
    const span = Math.max(1, hi - lo);
    const rowH = Math.max(2, Math.min(7, (h - 2) / span));

    ctx.fillStyle = "rgba(180,108,255,1)";   // violet — matches the .clip.midi identity
    for (const n of ns) {
      const x = secToPx(n.start * bs);
      const wpx = Math.max(2, secToPx(n.length * bs) - 1);
      const y = (1 - (n.pitch - lo) / span) * (h - rowH);   // high pitch toward top
      ctx.globalAlpha = 0.45 + 0.55 * (Math.min(127, Math.max(1, n.velocity)) / 127);
      ctx.fillRect(x, y, wpx, rowH);
    }
    ctx.globalAlpha = 1;
  }, [notes, width, bs, secToPx]);
  return <canvas ref={ref} />;
});

// Inline drum preview — fixed GM lanes (kick/snare/hat/…), FL-style steps. x stays
// grid-aligned via secToPx(beats); y is the GM lane, not the pitch.
export const ClipDrumGrid = memo(function ClipDrumGrid({ notes, width, bs, secToPx }:
  { notes?: MidiNote[]; width: number; bs: number; secToPx: (s: number) => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const prep = prepCanvas(ref.current); if (!prep) return;
    const { ctx, w, h } = prep;
    const ns = notes ?? []; if (ns.length === 0) return;

    const lanes = DRUM_LANES.length;
    const laneH = h / lanes;
    ctx.fillStyle = "rgba(180,108,255,0.14)";                // faint lane separators
    for (let l = 1; l < lanes; l++) ctx.fillRect(0, Math.round(l * laneH), w, 1);

    for (const n of ns) {
      const x = secToPx(n.start * bs);
      const cell = Math.max(3, Math.min(secToPx(n.length * bs), laneH - 2));
      const y = Math.max(0, laneIndexForPitch(n.pitch)) * laneH + 1;
      ctx.globalAlpha = 0.5 + 0.5 * (Math.min(127, Math.max(1, n.velocity)) / 127);
      ctx.fillStyle = "rgba(180,108,255,1)";
      ctx.fillRect(x, y, cell, Math.max(2, laneH - 3));
    }
    ctx.globalAlpha = 1;
  }, [notes, width, bs, secToPx]);
  return <canvas ref={ref} />;
});
