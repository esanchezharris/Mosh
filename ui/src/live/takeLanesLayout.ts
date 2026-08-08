// Pure take-lane layout for the live shell (Live 12 take lanes, display math
// only). Take lanes are per-TRACK rows stacked under the main lane: one row per
// take INDEX, and every clip with takes paints its takes inside its own time
// extent on the matching row — so two clips with takes share row 0 for their
// first takes, and a clip with fewer takes leaves gaps on the later rows.
// Consumed by TakeLanes.tsx (render) and Arrangement.tsx (row height); unit-pinned
// in takeLanesLayout.test.ts.

export interface TakeLaneClip {
  id: string;
  start: number;   // seconds
  length: number;  // seconds
  numTakes?: number;
}

export interface TakeBar {
  clipId: string;
  takeIndex: number;
  leftSec: number;
  widthSec: number;
}

export interface TakeLanesLayout {
  /** Number of sub-lane rows (max numTakes across clips with takes; 0 = no lanes). */
  rows: number;
  /** bars[rowIndex] — the take bars on that row, in clip order. */
  bars: TakeBar[][];
}

/** Only clips with MORE THAN ONE take get lanes (a single take is just the clip). */
export function takeLanesLayout(clips: readonly TakeLaneClip[]): TakeLanesLayout {
  const withTakes = clips.filter((c) => (c.numTakes ?? 0) > 1);
  const rows = withTakes.reduce((m, c) => Math.max(m, c.numTakes ?? 0), 0);
  const bars: TakeBar[][] = Array.from({ length: rows }, () => []);
  for (const c of withTakes)
    for (let i = 0; i < (c.numTakes ?? 0); ++i)
      bars[i].push({ clipId: c.id, takeIndex: i, leftSec: c.start, widthSec: c.length });
  return { rows, bars };
}
