import type { Snapshot } from "../types";

// V3 parity brief row 11 — the arrangement's horizontal geometry, in the shared store's
// pxPerSec (the same scale v2 and Pro Tools zoom). Pure so the mapping is unit-testable.

export type TimeBox = { start: number; length: number };

/** Beats in the session at its tempo (the lane grid's cell count). */
export function sessionBeatCount(session: Snapshot["session"]): number {
  const tempo = session.tempo ?? 120;
  const length = session.length ?? 32;
  return Math.max(4, Math.ceil((length * tempo) / 60));
}

/** Beats a clip spans at the session tempo (the clip's own content grid). */
export function clipBeatCount(lengthSec: number, tempo: number | undefined): number {
  return Math.max(1, Math.round((lengthSec * (tempo ?? 120)) / 60));
}

/** The lane's content width: the whole session at this zoom, never narrower than the viewport. */
export function laneContentPx(session: Snapshot["session"], pxPerSec: number, viewportPx: number): number {
  const length = Math.max(1e-6, session.length ?? 32);
  return Math.max(viewportPx, Math.ceil(length * pxPerSec));
}

/** A clip's box on the lane. A width floor keeps a very short clip grabbable. */
export function clipBox(box: TimeBox, pxPerSec: number): { left: number; width: number } {
  return { left: box.start * pxPerSec, width: Math.max(6, box.length * pxPerSec) };
}

// ── playhead / sections / ruler (2026-09-21) ────────────────────────────────────────────
// All on the same pxPerSec scale as the clips, so the three never disagree at any zoom.

/** Where lane content starts inside the `.rows` stack: the 148 px sticky header + its 6 px gap. */
export const LANE_LEFT_PX = 148 + 6;

/** The playhead's x inside the `.rows` stack for a transport position (seconds). */
export function playheadLeftPx(positionSec: number, pxPerSec: number): number {
  return LANE_LEFT_PX + Math.max(0, positionSec) * pxPerSec;
}

export type BeatSpan = { startBeat: number; endBeat: number };

/** A section's start in session seconds at the session tempo. */
export function sectionStartSec(section: BeatSpan, tempo: number | undefined): number {
  return (section.startBeat * 60) / (tempo ?? 120);
}

/** A section's lane-relative box at this zoom. A width floor keeps a degenerate section visible. */
export function sectionBox(section: BeatSpan, tempo: number | undefined, pxPerSec: number): { left: number; width: number } {
  const secPerBeat = 60 / (tempo ?? 120);
  return {
    left: section.startBeat * secPerBeat * pxPerSec,
    width: Math.max(2, (section.endBeat - section.startBeat) * secPerBeat * pxPerSec),
  };
}

/** The ".2 .3 .4" beat labels need ~18 px per beat to read; below that the ruler shows bar numbers only. */
export function beatLabelsVisible(pxPerBeat: number): boolean {
  return pxPerBeat >= 18;
}

/** A ruler click at lane-relative `x` → session seconds at this zoom (clamped at the start). */
export function secondsAtLaneX(x: number, pxPerSec: number): number {
  return Math.max(0, x / pxPerSec);
}

// ── one beat scale for the ruler, the lane grid and every clip grid (2026-09-22) ─────────
// The ruler and the lane grid used to divide their own element widths into equal cells (each
// width off by a border or a ceil), and a clip stretched a rounded beat count over its inner
// box. Three slightly different scales — lines drifted a few pixels along a long clip. Now
// everything is placed at beatPx multiples from the lane's origin.

/** Pixels per beat at this tempo and zoom. */
export function beatPx(tempo: number | undefined, pxPerSec: number): number {
  return (60 / (tempo ?? 120)) * pxPerSec;
}

/** Grid cells across the lane: the whole session, and enough to fill a lane wider than it. */
export function gridBeatCount(session: Snapshot["session"], pxPerSec: number, lanePx: number): number {
  const bp = beatPx(session.tempo, pxPerSec);
  return Math.max(sessionBeatCount(session), bp > 0 ? Math.ceil(lanePx / bp) : 0);
}

/** A clip's span in beats (exact, not rounded) at the session tempo. */
export function clipBeats(box: TimeBox, tempo: number | undefined): { startBeat: number; lengthBeats: number } {
  const beatsPerSec = (tempo ?? 120) / 60;
  return { startBeat: box.start * beatsPerSec, lengthBeats: box.length * beatsPerSec };
}

export type GridLine = { x: number; bar: boolean };

/** The absolute beat lines that fall inside a clip, as fractions of its width (0..1), bar
 *  lines flagged by the SESSION's bars — so a clip that starts mid-bar still draws the bars
 *  where the ruler has them. */
export function clipGridLines(startBeat: number, lengthBeats: number): GridLine[] {
  const out: GridLine[] = [];
  if (!(lengthBeats > 0) || !Number.isFinite(startBeat)) return out;
  const eps = 1e-6;
  for (let b = Math.ceil(startBeat - eps); b <= startBeat + lengthBeats + eps; b++) {
    const x = (b - startBeat) / lengthBeats;
    if (x < -eps || x > 1 + eps) continue;
    out.push({ x: Math.min(1, Math.max(0, x)), bar: ((b % 4) + 4) % 4 === 0 });
  }
  return out;
}
