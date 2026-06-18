// Pure dBFS → meter geometry. Meter.tsx owns the per-frame rAF ballistics; this
// module is the testable instantaneous mapping it paints with (same split as
// takeLanes.ts / deriveTakeLanes). Readings arrive on the 30 Hz `levels` telemetry
// as peak dBFS — 0 = full scale, ~-100 = the engine's silence floor.
//
// Named meterGeom (not meter) so it never case-collides with Meter.tsx on a
// case-insensitive filesystem.

// Visible meter floor. The engine reports down to ~-100 dBFS; we show the top 60 dB
// (the musically useful range), so anything at or below this maps to an empty bar.
export const METER_FLOOR_DB = -60;

// Peak dBFS → 0..100 bar-fill percentage, clamped to the visible range. Non-finite
// readings (−Infinity silence, NaN) read as empty.
export function meterPct(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const pct = ((db - METER_FLOOR_DB) / (0 - METER_FLOOR_DB)) * 100;
  return Math.max(0, Math.min(100, pct));
}

// A peak at or above 0 dBFS is a full-scale overload (lights the clip indicator).
export function isClip(db: number): boolean {
  return Number.isFinite(db) && db >= 0;
}
