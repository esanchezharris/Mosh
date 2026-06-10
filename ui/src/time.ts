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
// SES-001 — the piecewise tempo MAP (+ ramps). The backend serializes the
// engine's TempoSequence (session.tempoMap + session.timeSigMap; and, when any
// point carries a ramp curve, session.tempoSections — the engine's OWN fine
// subdivision boundaries with times/bpm read back through its toTime/getBpmAt).
// The mapping here is therefore engine-faithful by construction:
//   - step-only maps: piecewise-constant, exact;
//   - ramps: the same ≤100-sections-per-span approximation playback uses.
// Bar semantics: every EXPLICIT tempo/meter change starts a fresh bar (the
// standard convention; a trailing partial bar counts as one). Ramp-internal
// section boundaries do NOT restart bars — the bar grid flows through a
// ritardando, compressing/expanding with the local tempo.
// ─────────────────────────────────────────────────────────────────────────────

export type TempoSeg = {
  startSec: number;
  startBarF: number;  // continuous (fractional) bar position at the segment start
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
  tempoMap?: { time: number; bpm: number; curve?: number }[];
  timeSigMap?: { time: number; numerator: number; denominator: number }[];
  tempoSections?: { time: number; bpm: number }[];
};

/** Build the piecewise map. Constant sessions yield one segment (the original
    behavior); step maps yield one segment per change; ramped maps consume the
    backend's engine-faithful fine sections. */
export function tempoMapFrom(session?: SessionWithMaps): TempoMap {
  const base = meterFrom(session);
  const sigs = (session?.timeSigMap ?? []).slice().sort((a, b) => a.time - b.time);
  const explicit = new Set<number>([0]);
  for (const p of session?.tempoMap ?? []) explicit.add(p.time);
  for (const s of sigs) explicit.add(s.time);

  // The fine time/bpm points: the engine sections when ramps exist, else the
  // tempoMap points themselves (each a constant span).
  const fine: { time: number; bpm: number }[] =
    session?.tempoSections && session.tempoSections.length > 0
      ? session.tempoSections.slice().sort((a, b) => a.time - b.time)
      : (session?.tempoMap ?? []).map((p) => ({ time: p.time, bpm: p.bpm }));

  const times = Array.from(new Set([0, ...fine.map((f) => f.time), ...sigs.map((s) => s.time)]))
    .sort((a, b) => a - b);

  const bpmAt = (t: number) => {
    let v = base.tempo;
    for (const p of fine) if (p.time <= t + 1e-9) v = p.bpm; else break;
    return v;
  };
  const sigAt = (t: number) => {
    let v = { num: base.num, den: base.den };
    for (const s of sigs) if (s.time <= t + 1e-9) v = { num: s.numerator, den: s.denominator };
    return v;
  };

  const map: TempoMap = [];
  let barF = 0;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const tempo = bpmAt(t);
    const { num, den } = sigAt(t);
    const m: Meter = { tempo, num, den };
    if (explicit.has(t)) barF = Math.ceil(barF - 1e-9); // explicit change -> fresh bar
    const seg: TempoSeg = {
      startSec: t, startBarF: barF, tempo, num, den,
      barSec: barSeconds(m), beatSec: beatSeconds(m),
    };
    map.push(seg);
    if (i < times.length - 1) barF += (times[i + 1] - t) / seg.barSec; // continuous through ramps
  }
  return map.length > 0 ? map
    : [{ startSec: 0, startBarF: 0, tempo: base.tempo, num: base.num, den: base.den, barSec: barSeconds(base), beatSec: beatSeconds(base) }];
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

/** Continuous bar position (fractional) at a time. */
const barPosAt = (map: TempoMap, sec: number): number => {
  const s = segAt(map, sec);
  return s.startBarF + Math.max(0, sec - s.startSec) / s.barSec;
};

/** Invert a continuous bar position back to seconds. */
const barPosToSec = (map: TempoMap, barF: number): number => {
  let seg = map[0];
  for (const s of map) { if (s.startBarF <= barF + 1e-9) seg = s; else break; }
  return seg.startSec + (barF - seg.startBarF) * seg.barSec;
};

/** Bar/beat gridlines + change markers across a range (capped). Bar lines land
    on integer continuous-bar positions, so they compress through a ramp. */
export function gridLines(map: TempoMap, fromSec: number, toSec: number, maxLines = 600): {
  bars: { sec: number; label: number }[];
  beats: number[];
  marks: { sec: number; label: string }[];
} {
  const bars: { sec: number; label: number }[] = [];
  const beats: number[] = [];
  const marks: { sec: number; label: string }[] = [];
  let total = 0;

  // Explicit-change markers (a mark per segment whose meter/tempo differs from
  // its predecessor at an explicit boundary — ramp-internal segs are unmarked).
  for (let i = 1; i < map.length && marks.length < 24; i++) {
    const a = map[i - 1], b = map[i];
    const explicitBoundary = Math.abs(b.startBarF - Math.round(b.startBarF)) < 1e-6;
    const changed = b.num !== a.num || b.den !== a.den || Math.abs(b.tempo - a.tempo) > 0.5;
    if (explicitBoundary && changed)
      marks.push({ sec: b.startSec, label: `${Math.round(b.tempo)} ${b.num}/${b.den}` });
  }

  const startBar = Math.max(0, Math.floor(barPosAt(map, Math.max(0, fromSec))));
  for (let k = startBar; total < maxLines; k++) {
    const sec = barPosToSec(map, k);
    if (sec > toSec) break;
    if (sec >= fromSec - 1e-9) { bars.push({ sec, label: k + 1 }); total++; }
    // Beats inside bar k (local meter at the bar start).
    const seg = segAt(map, sec);
    for (let j = 1; j < seg.num && total < maxLines; j++) {
      const bs = barPosToSec(map, k + j / seg.num);
      if (bs > toSec) break;
      if (bs >= fromSec - 1e-9) { beats.push(bs); total++; }
    }
  }
  return { bars, beats, marks };
}

/** Snap a time to the local musical grid (beat-domain rounding, so snapping
    stays musical through ramps; the grid restarts at explicit changes). */
export function snapTimeMap(map: TempoMap, t: number, division: SnapDiv): number {
  const seg = segAt(map, t);
  const m: Meter = { tempo: seg.tempo, num: seg.num, den: seg.den };
  const stepBars = division === "bar" ? 1 : snapStepBeats(m, division) / m.num;
  const barF = barPosAt(map, t);
  const snapped = Math.round(barF / stepBars) * stepBars;
  return Math.max(0, barPosToSec(map, snapped));
}

/** Bars.beats.sixteenths over the map (1-based; bars flow through ramps). */
export function secondsToBBSMap(map: TempoMap, sec: number): string {
  const seg = segAt(map, Math.max(0, sec));
  const barF = barPosAt(map, Math.max(0, sec));
  const bar = Math.floor(barF + 1e-9);
  const frac = barF - bar;
  const beatF = frac * seg.num;
  const beat = Math.min(seg.num - 1, Math.floor(beatF + 1e-9));
  const sixteenth = Math.max(0, Math.min(3, Math.floor((beatF - beat) * 4)));
  return `${bar + 1}.${beat + 1}.${sixteenth + 1}`;
}
