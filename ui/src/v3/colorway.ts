export const V3_COLORWAYS = ["lime", "bone", "violet", "coral"] as const;
export type V3Colorway = (typeof V3_COLORWAYS)[number];

export function colorwayAttr(value: unknown): V3Colorway {
  return V3_COLORWAYS.includes(value as V3Colorway) ? (value as V3Colorway) : "lime";
}
