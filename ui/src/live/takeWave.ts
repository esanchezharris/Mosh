// Pure per-take waveform mapping for the take lanes (take-lanes wave): downsample
// the engine's [min,max] peak buckets to one amplitude pair per canvas column.
// The engine's buckets are the SAME bucketedPeaks shape the main-lane renderer
// consumes (list_takes, additive); this is only a resample, unit-pinned in
// takeWave.test.ts. TakeLanes.tsx paints what this returns, dimmer than the main
// lane (Live's look); no peaks ⇒ the caller keeps the labeled-bar fallback.

export type PeakPair = readonly [number, number];

/**
 * One [min,max] amplitude pair per output column. Columns cover the buckets
 * contiguously (column c owns buckets [c·n/cols, (c+1)·n/cols)) and aggregate
 * min-of-mins / max-of-maxes, so a column never invents energy its buckets
 * don't have. Fewer buckets than columns ⇒ one column per bucket.
 * Empty peaks or a non-positive width ⇒ [] (the honest fallback path).
 */
export function peaksToColumns(peaks: readonly PeakPair[], widthPx: number): PeakPair[] {
  const n = peaks.length;
  const cols = Math.min(Math.floor(widthPx), n);
  if (n === 0 || cols <= 0) return [];
  const out: PeakPair[] = [];
  for (let c = 0; c < cols; ++c) {
    const from = Math.floor((c * n) / cols);
    const to = Math.max(from + 1, Math.floor(((c + 1) * n) / cols));
    let mn = 0, mx = 0;
    for (let b = from; b < to; ++b) {
      mn = Math.min(mn, peaks[b][0]);
      mx = Math.max(mx, peaks[b][1]);
    }
    out.push([mn, mx]);
  }
  return out;
}
