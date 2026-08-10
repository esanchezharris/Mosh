// Lane-height geometry (WIDGETS.md §1: default 86pt, drag range 17–443pt, header
// collapses to colour+name at the floor). Pure so the clamp is unit-testable.

export const LANE_MIN = 17;
export const LANE_MAX = 443;
export const LANE_DEFAULT = 86;
/** At/below this height the header renders only its top row (colour block + name +
 *  number) — Live's collapsed-at-min header. */
export const LANE_COMPACT_MAX = 40;

export function clampLaneHeight(px: number): number {
  return Math.min(Math.max(Math.round(px), LANE_MIN), LANE_MAX);
}
