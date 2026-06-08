/**
 * timeutil.ts — pure time/grid helpers for the arrange view.
 *
 * No backend coupling here: these convert between seconds (the snapshot's clip
 * range unit) and the UI's bars/beats grid derived from the snapshot tempo.
 * The UI vocabulary stays seconds + the snapshot's tempo — no Tracktion types.
 */

/** Seconds per beat for a given bpm. */
export function secPerBeat(bpm: number): number {
  return 60 / Math.max(1, bpm);
}

/** Beats per bar parsed from a time signature like "4/4" (defaults to 4). */
export function beatsPerBar(sig: string): number {
  const top = Number.parseInt(sig.split("/")[0] ?? "4", 10);
  return Number.isFinite(top) && top > 0 ? top : 4;
}

/** Seconds per bar for a tempo. */
export function secPerBar(bpm: number, sig: string): number {
  return secPerBeat(bpm) * beatsPerBar(sig);
}

/** Format a seconds position as "bar.beat" (1-based) for a readout. */
export function formatBarBeat(sec: number, bpm: number, sig: string): string {
  const spb = secPerBeat(bpm);
  const bpBar = beatsPerBar(sig);
  const totalBeats = Math.max(0, sec) / spb;
  const bar = Math.floor(totalBeats / bpBar) + 1;
  const beat = Math.floor(totalBeats % bpBar) + 1;
  return `${bar}.${beat}`;
}

/** Format a seconds value as M:SS.mmm. */
export function formatClock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(2).padStart(5, "0")}`;
}

/** Snap a seconds value to the nearest beat. */
export function snapToBeat(sec: number, bpm: number): number {
  const spb = secPerBeat(bpm);
  return Math.round(sec / spb) * spb;
}
