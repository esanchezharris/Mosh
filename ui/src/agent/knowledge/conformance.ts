// Symbolic conformance readers: "did the in-the-box move take effect as intended?",
// read from the SNAPSHOT (note grids, automation curves, send routing) — not from
// rendered audio. Exact + deterministic, so the flywheel can validate technique
// reproduction with no DSP/scorer. Pure; unit-tested on synthetic snapshots.
//
// Honest scope: these prove a move was APPLIED/REPRODUCED (conformance), NOT that it
// sounds good (taste) — taste is the deferred audio-quality layer (05 / the plan).
import type { MidiNote, PluginParam, Track } from "../../types";

export type ConformanceResult = {
  conformant: boolean;
  inconclusive?: boolean;   // applicability gate — couldn't measure (don't count as a fail)
  detail: string;
  measured?: number;        // the signature value we read (for the report)
  target?: number;
};

// ── drum / note PATTERN — the load-bearing reader ──────────────────────────────
// Every expected (pitch, beat) hit must have a matching note within `tol` beats. This
// is what a mined producer pattern reduces to; reproduction fidelity is the value.
export type PatternSpec = { hits: { pitch: number; beats: number[] }[] };

export function patternConformance(notes: MidiNote[], pattern: PatternSpec, tol = 0.06): ConformanceResult {
  let want = 0, got = 0;
  const missing: string[] = [];
  for (const h of pattern.hits) {
    for (const beat of h.beats) {
      want++;
      const hit = notes.some((n) => n.pitch === h.pitch && Math.abs(n.start - beat) <= tol);
      if (hit) got++; else missing.push(`pitch ${h.pitch}@${beat}`);
    }
  }
  const frac = want ? got / want : 0;
  return {
    conformant: want > 0 && got === want,
    detail: `pattern hits ${got}/${want}${missing.length ? ` (missing ${missing.slice(0, 4).join(", ")})` : ""}`,
    measured: frac,
    target: 1,
  };
}

// ── SWING — off-beats pushed late by ~swing*division ───────────────────────────
// Recover each note's subdivision with floor() (swing only delays, never < grid, and
// is clamped < 1, so floor maps a swung off-beat back to its odd sub). Even subs must
// stay on-grid; odd subs must sit ~swing of the way into their sub.
export function swingConformance(notes: MidiNote[], opts: { division: number; swing: number; tol?: number }): ConformanceResult {
  const { division: div, swing } = opts;
  const tol = opts.tol ?? 0.08;
  const oddRatios: number[] = [];
  let evenOffGrid = 0;
  for (const n of notes) {
    const sub = Math.floor(n.start / div + 1e-6);
    const ratio = (n.start - sub * div) / div;        // 0..1 position within the sub
    if (sub % 2 === 0) { if (ratio > 0.1) evenOffGrid++; }
    else oddRatios.push(ratio);
  }
  if (oddRatios.length === 0)
    return { conformant: false, inconclusive: true, detail: "no off-beat notes to measure swing", target: swing };
  const mean = oddRatios.reduce((a, r) => a + r, 0) / oddRatios.length;
  const conformant = evenOffGrid === 0 && Math.abs(mean - swing) <= tol;
  return {
    conformant,
    detail: `swing ${mean.toFixed(2)} vs requested ${swing.toFixed(2)}; ${evenOffGrid} on-beats off-grid`,
    measured: mean,
    target: swing,
  };
}

// ── HUMANIZE — bounded, non-zero jitter; count + pitch preserved ───────────────
// Pair by (pitch, then start order) so a re-sorted MidiList still pairs. Conformant =
// something moved, every timing offset is bounded (human, not sloppy), no negatives.
export function humanizeConformance(before: MidiNote[], after: MidiNote[], opts: { maxOffsetBeats: number }): ConformanceResult {
  if (before.length !== after.length)
    return { conformant: false, inconclusive: true, detail: `note count changed ${before.length}→${after.length}` };
  const key = (n: MidiNote) => `${n.pitch}`;
  const sortBy = (a: MidiNote, b: MidiNote) => (a.pitch - b.pitch) || (a.start - b.start);
  const b = [...before].sort(sortBy), a = [...after].sort(sortBy);
  if (b.some((n, k) => key(n) !== key(a[k])))
    return { conformant: false, inconclusive: true, detail: "pitches don't pair up — can't measure" };

  let maxOffset = 0, moved = false, outOfBounds = false, negative = false, badVel = false;
  for (let k = 0; k < b.length; k++) {
    const dt = a[k].start - b[k].start;
    if (Math.abs(dt) > 1e-6 || a[k].velocity !== b[k].velocity) moved = true;
    maxOffset = Math.max(maxOffset, Math.abs(dt));
    if (Math.abs(dt) > opts.maxOffsetBeats + 1e-9) outOfBounds = true;
    if (a[k].start < 0) negative = true;
    if (a[k].velocity < 1 || a[k].velocity > 127) badVel = true;
  }
  const conformant = moved && !outOfBounds && !negative && !badVel;
  const why = !moved ? "no change (no-op)" : outOfBounds ? "exceeds the bound (sloppy)" : negative ? "a start went negative" : badVel ? "velocity out of range" : "bounded jitter";
  return { conformant, detail: `humanize: ${why}; max offset ${maxOffset.toFixed(3)} beats`, measured: maxOffset, target: opts.maxOffsetBeats };
}

// ── AUTOMATION — the param carries a directional curve ─────────────────────────
export function automationConformance(param: PluginParam, opts: { direction: "up" | "down"; minPoints?: number }): ConformanceResult {
  const minPoints = opts.minPoints ?? 2;
  const pts = [...(param.points ?? [])].sort((x, y) => x.t - y.t);
  if (!param.automated || pts.length < minPoints)
    return { conformant: false, detail: `automation: ${pts.length} point(s), automated=${!!param.automated}` };
  const drift = pts[pts.length - 1].v - pts[0].v;
  const conformant = opts.direction === "up" ? drift > 0 : drift < 0;
  return { conformant, detail: `automation drift ${drift.toFixed(2)} (${opts.direction})`, measured: drift };
}

// ── SEND — the track routes to the bus (at the level, if specified) ────────────
export function sendConformance(track: Track, opts: { bus: number; db?: number; tol?: number }): ConformanceResult {
  const tol = opts.tol ?? 0.5;
  const send = (track.sends ?? []).find((s) => s.bus === opts.bus);
  if (!send) return { conformant: false, detail: `no send to bus ${opts.bus}` };
  const levelOk = opts.db == null || Math.abs(send.db - opts.db) <= tol;
  return { conformant: levelOk, detail: `send to bus ${opts.bus} @ ${send.db}dB${opts.db != null ? ` (want ${opts.db})` : ""}`, measured: send.db, target: opts.db };
}
