// The single canonical musical-time mapping (SES-001). Every view — ruler,
// grid, snap, clips, playhead, position readout — resolves positions through
// THIS module, derived from the session's tempo + time signature (the engine's
// tempoSequence as reflected in the snapshot). v0 assumes a constant tempo;
// a tempo map is a later wave. Positions on the command surface stay in seconds
// (the swappable seam); musical time is a pure view-side derivation.

export type SnapDiv = "bar" | "1/4" | "1/8" | "1/16" | "1/32";
export const SNAP_DIVISIONS: SnapDiv[] = ["bar", "1/4", "1/8", "1/16", "1/32"];

export type Meter = { tempo: number; num: number; den: number };

const QUARTERS: Record<Exclude<SnapDiv, "bar">, number> = {
  "1/4": 1,
  "1/8": 0.5,
  "1/16": 0.25,
  "1/32": 0.125,
};

export function meterFrom(session?: {
  tempo?: number;
  timeSigNumerator?: number;
  timeSigDenominator?: number;
}): Meter {
  return {
    tempo: session?.tempo && session.tempo > 0 ? session.tempo : 120,
    num: session?.timeSigNumerator ?? 4,
    den: session?.timeSigDenominator ?? 4,
  };
}

/** Seconds per quarter note. */
export const secPerQuarter = (tempo: number) => 60 / Math.max(1, tempo);
/** Seconds per beat (one denominator-note: quarter in x/4, eighth in x/8). */
export const beatSeconds = (m: Meter) => (4 / m.den) * secPerQuarter(m.tempo);
/** Seconds per bar. */
export const barSeconds = (m: Meter) => m.num * beatSeconds(m);

/** Grid step in seconds for a snap resolution. */
export function snapStep(m: Meter, division: SnapDiv): number {
  if (division === "bar") return barSeconds(m);
  return QUARTERS[division] * secPerQuarter(m.tempo);
}

/** Grid step in beats (denominator-notes) for a snap resolution. */
export function snapStepBeats(m: Meter, division: SnapDiv): number {
  return snapStep(m, division) / beatSeconds(m);
}

/** Format a time (seconds) as bars.beats.sixteenths (1-based). */
export function secondsToBBS(sec: number, m: Meter): string {
  const beats = Math.max(0, sec) / beatSeconds(m);
  const bar = Math.floor(beats / m.num);
  const beatInBar = Math.floor(beats - bar * m.num);
  const frac = beats - Math.floor(beats);
  const sixteenth = Math.floor(frac * 4);
  return `${bar + 1}.${beatInBar + 1}.${sixteenth + 1}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SES-001 — the piecewise tempo MAP. The backend serializes the engine's
// TempoSequence (session.tempoMap + session.timeSigMap, times computed by the
// engine's own beats->seconds conversion). Mosh inserts STEP changes only
// (curve=1.0 hold-then-jump), so a piecewise-CONSTANT mapping here is EXACT —
// no duplicated engine math, no drift. Each change point starts a new bar
// (the standard musical convention; a partial bar before a change counts as
// one). Bezier ramps / audio warp are deferred (documented).
// ─────────────────────────────────────────────────────────────────────────────

export type TempoSeg = {
  startSec: number;
  startBar: number;   // cumulative bar index at the segment start (0-based)
  tempo: number;
  num: number;
  den: number;
  barSec: number;
  beatSec: number;
};
export type TempoMap = TempoSeg[];

type SessionWithMaps = {
  tempo?: number;
  timeSigNumerator?: number;
  timeSigDenominator?: number;
  tempoMap?: { time: number; bpm: number }[];
  timeSigMap?: { time: number; numerator: number; denominator: number }[];
};

/** Build the piecewise map. Falls back to a single constant segment (the old
    behavior) when the session carries no map (or only the base point). */
export function tempoMapFrom(session?: SessionWithMaps): TempoMap {
  const base = meterFrom(session);
  const tempos = (session?.tempoMap ?? []).slice().sort((a, b) => a.time - b.time);
  const sigs = (session?.timeSigMap ?? []).slice().sort((a, b) => a.time - b.time);

  // Merge the distinct change times (always include 0 for the base segment).
  const times = Array.from(new Set([0, ...tempos.map((t) => t.time), ...sigs.map((s) => s.time)]))
    .sort((a, b) => a - b);

  const tempoAt = (t: number) => {
    let v = tempos.length > 0 && tempos[0].time <= 0 ? tempos[0].bpm : base.tempo;
    for (const p of tempos) if (p.time <= t + 1e-9) v = p.bpm;
    return v;
  };
  const sigAt = (t: number) => {
    let v = { num: base.num, den: base.den };
    for (const s of sigs) if (s.time <= t + 1e-9) v = { num: s.numerator, den: s.denominator };
    return v;
  };

  const map: TempoMap = [];
  let bar = 0;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const tempo = tempoAt(t);
    const { num, den } = sigAt(t);
    const m: Meter = { tempo, num, den };
    const seg: TempoSeg = {
      startSec: t, startBar: bar, tempo, num, den,
      barSec: barSeconds(m), beatSec: beatSeconds(m),
    };
    map.push(seg);
    if (i < times.length - 1) {
      // Bars consumed by this segment; a trailing partial bar counts as one
      // (every change point starts a fresh bar).
      const span = times[i + 1] - t;
      bar += Math.max(1, Math.ceil(span / seg.barSec - 1e-9));
    }
  }
  return map.length > 0 ? map : [{ startSec: 0, startBar: 0, tempo: base.tempo, num: base.num, den: base.den, barSec: barSeconds(base), beatSec: beatSeconds(base) }];
}

/** The segment governing a time (the last one starting at or before it). */
export function segAt(map: TempoMap, sec: number): TempoSeg {
  let seg = map[0];
  for (const s of map) { if (s.startSec <= sec + 1e-9) seg = s; else break; }
  return seg;
}

/** The local meter at a time. */
export const meterAt = (map: TempoMap, sec: number): Meter => {
  const s = segAt(map, sec);
  return { tempo: s.tempo, num: s.num, den: s.den };
};

/** Bar/beat gridlines + change markers across a range (capped). */
export function gridLines(map: TempoMap, fromSec: number, toSec: number, maxLines = 600): {
  bars: { sec: number; label: number }[];
  beats: number[];
  marks: { sec: number; label: string }[];
} {
  const bars: { sec: number; label: number }[] = [];
  const beats: number[] = [];
  const marks: { sec: number; label: string }[] = [];
  let total = 0;
  for (let i = 0; i < map.length && total < maxLines; i++) {
    const seg = map[i];
    const segEnd = i + 1 < map.length ? map[i + 1].startSec : toSec;
    if (seg.startSec > toSec || segEnd < fromSec) continue;
    if (i > 0) marks.push({ sec: seg.startSec, label: `${Math.round(seg.tempo)} ${seg.num}/${seg.den}` });
    for (let b = 0; total < maxLines; b++) {
      const sec = seg.startSec + b * seg.barSec;
      if (sec >= segEnd - 1e-9 || sec > toSec) break;
      if (sec >= fromSec) { bars.push({ sec, label: seg.startBar + b + 1 }); total++; }
      for (let k = 1; k < seg.num && total < maxLines; k++) {
        const bs = sec + k * seg.beatSec;
        if (bs >= segEnd - 1e-9 || bs > toSec) break;
        if (bs >= fromSec) { beats.push(bs); total++; }
      }
    }
  }
  return { bars, beats, marks };
}

/** Snap a time to the local grid (anchored to the governing segment's start, so
    the grid restarts at every tempo/meter change — musically standard). */
export function snapTimeMap(map: TempoMap, t: number, division: SnapDiv): number {
  const seg = segAt(map, t);
  const m: Meter = { tempo: seg.tempo, num: seg.num, den: seg.den };
  const step = snapStep(m, division);
  if (step <= 0) return t;
  return Math.max(0, seg.startSec + Math.round((t - seg.startSec) / step) * step);
}

/** Bars.beats.sixteenths over the map (1-based, exact for step changes). */
export function secondsToBBSMap(map: TempoMap, sec: number): string {
  const seg = segAt(map, Math.max(0, sec));
  const local = Math.max(0, sec) - seg.startSec;
  const barsIn = Math.floor(local / seg.barSec + 1e-9);
  const rem = local - barsIn * seg.barSec;
  const beat = Math.min(seg.num - 1, Math.floor(rem / seg.beatSec + 1e-9));
  const frac = rem / seg.beatSec - beat;
  const sixteenth = Math.max(0, Math.min(3, Math.floor(frac * 4)));
  return `${seg.startBar + barsIn + 1}.${beat + 1}.${sixteenth + 1}`;
}
