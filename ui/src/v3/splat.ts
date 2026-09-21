// Moshi's face in the V3 dock is the SPLAT — the five-lobe ink blot the owner built with
// Grok Bot (vendor/agent-sprites; its stills in TRUTH.md are authoritative). This module is
// the pure glue: which of its palettes a V3 colorway wears, and which of its states the
// dock's mood maps to. The engine itself is clock-free; MoshiFace owns the clock.
import type { V3Colorway } from "./colorway";

export type SplatColorway = string | { id: string; hex: string; accent: string; voidHex: string };

/** The splat's own hero palettes carry lime and bone; violet and coral keep the ink body and
 *  take the shell accent as the mouth, so the avatar follows the colorway like every other
 *  accent in the shell (parity brief row 13). */
export function splatColorwayFor(colorway: V3Colorway): SplatColorway {
  switch (colorway) {
    case "lime": return "encre";
    case "bone": return "creme";
    case "violet": return { id: "violet", hex: "#1B1D1C", accent: "#B8A4FF", voidHex: "#0B0914" };
    case "coral": return { id: "coral", hex: "#1B1D1C", accent: "#FF8B7A", voidHex: "#140A08" };
    default: { const unreachable: never = colorway; return unreachable; }
  }
}

export type DockMood = { safe: boolean; busy: boolean; listening: boolean; clarify: boolean };
export type SplatState = "sleep" | "thinking" | "wide" | "notify" | "idle" | "laugh";

/** Recording-safe dock = asleep (he must not distract a take); a running agent thinks; a
 *  live mic widens the eyes; an open clarify question is a notify badge; otherwise idle.
 *  Priority is that order — the safest read wins. */
export function splatStateFor(m: DockMood): SplatState {
  if (m.safe) return "sleep";
  if (m.busy) return "thinking";
  if (m.listening) return "wide";
  if (m.clarify) return "notify";
  return "idle";
}
