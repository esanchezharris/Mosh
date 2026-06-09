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
