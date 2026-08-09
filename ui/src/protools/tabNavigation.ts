export interface TabNavigationInput {
  position: number;
  tabToTransient: boolean;
  transientCandidates: readonly number[];
  clipBoundaries: readonly number[];
}

function nextFinite(values: readonly number[], position: number): number | null {
  let next = Number.POSITIVE_INFINITY;
  for (const candidate of values) {
    if (Number.isFinite(candidate) && candidate > position && candidate < next) next = candidate;
  }
  return Number.isFinite(next) ? next : null;
}

export function nextTabPosition(input: TabNavigationInput): number | null {
  if (!Number.isFinite(input.position)) return null;
  if (input.tabToTransient) {
    const transient = nextFinite(input.transientCandidates, input.position);
    if (transient !== null) return transient;
  }
  return nextFinite(input.clipBoundaries, input.position);
}
