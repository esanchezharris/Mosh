// Pure geometry for the arrangement navigator: song length, vocal-take regions, playhead +
// seek fractions, bar ticks. Seconds in; 0..1 fractions out (the UI scales by pixel width).
// Modelled on ui/src/v2/timeline/SongNav.tsx (playhead placement, click-to-seek).

import type { Clip, Snap } from "./types";

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function secPerBar(tempo: number, tsNum = 4): number {
  const bpm = tempo > 0 ? tempo : 120;
  const beats = tsNum > 0 ? tsNum : 4;
  return (60 / bpm) * beats;
}

export function barToSec(bar: number, tempo: number, tsNum = 4): number {
  return Math.max(0, bar - 1) * secPerBar(tempo, tsNum);
}

export function secToBar(sec: number, tempo: number, tsNum = 4): number {
  return Math.max(0, sec) / secPerBar(tempo, tsNum) + 1;
}

const clipEnd = (c: Clip): number => c.start + c.length;

/** Song length in seconds: session.length, else the last clip end, else a small floor. */
export function songLength(snap: Snap | null): number {
  const declared = snap?.session?.length;
  if (declared && declared > 0) return declared;
  let end = 0;
  for (const t of snap?.tracks ?? [])
    for (const c of t.clips ?? []) if (!c.hidden) end = Math.max(end, clipEnd(c));
  return Math.max(end, snap?.transport?.position ?? 0, 1);
}

/** Time ranges where vocals are recorded — clips on the given track (else all non-hidden clips). */
export function regionsForTrack(snap: Snap | null, trackId?: string): { s: number; e: number }[] {
  const tracks = snap?.tracks ?? [];
  const picked = trackId ? tracks.filter((t) => t.id === trackId) : tracks;
  const out: { s: number; e: number }[] = [];
  for (const t of picked)
    for (const c of t.clips ?? [])
      if (!c.hidden && c.length > 0) out.push({ s: c.start, e: clipEnd(c) });
  return out;
}

export type Rect = { left: number; width: number }; // fractions 0..1

export function regionRects(regions: { s: number; e: number }[], lengthSec: number): Rect[] {
  const L = lengthSec > 0 ? lengthSec : 1;
  return regions.map((r) => {
    const left = clamp01(r.s / L);
    const width = clamp01((r.e - r.s) / L);
    return { left, width: Math.max(width, 0.004) }; // keep tiny takes visible
  });
}

export function playheadFrac(posSec: number, lengthSec: number): number {
  return clamp01((posSec > 0 ? posSec : 0) / (lengthSec > 0 ? lengthSec : 1));
}

export function fracToSec(frac: number, lengthSec: number): number {
  return clamp01(frac) * (lengthSec > 0 ? lengthSec : 0);
}

/** Bar-line tick fractions (thinned so a long song doesn't render hundreds of lines). */
export function barTicks(lengthSec: number, tempo: number, tsNum = 4): number[] {
  const spb = secPerBar(tempo, tsNum);
  const nbars = Math.ceil((lengthSec > 0 ? lengthSec : 0) / spb);
  const step = nbars > 48 ? 8 : nbars > 16 ? 4 : 1;
  const ticks: number[] = [];
  for (let b = step; b < nbars; b += step) {
    const f = (b * spb) / (lengthSec > 0 ? lengthSec : 1);
    if (f > 0 && f < 1) ticks.push(f);
  }
  return ticks;
}
