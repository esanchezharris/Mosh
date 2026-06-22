// Pure vertical layout for the arrangement's track rows. Each row's FULL height is
// given (base lane height + any expanded FX drawer); this returns the cumulative top
// offset + height per row. With uniform heights it's exactly i*h — so the fixed-grid
// arrangement layout is byte-identical until a track is expanded.
export function laneRows(heights: number[]): { top: number; height: number }[] {
  const rows: { top: number; height: number }[] = [];
  let top = 0;
  for (const height of heights) {
    rows.push({ top, height });
    top += height;
  }
  return rows;
}

export function lanesTotal(heights: number[]): number {
  return heights.reduce((sum, h) => sum + h, 0);
}
