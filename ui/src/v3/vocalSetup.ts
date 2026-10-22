import type { Track } from "../types";
import { acceptsTrackPreset } from "./MixInspector";

// The Booth's first-run defaults for a singer: one vocal chain, and no live mic into
// laptop speakers. Kept free of React so the rules are testable on their own.

/** The track-chain preset a fresh Booth setup starts with (list_presets names file stems). */
export const DEFAULT_VOCAL_CHAIN = "mosh-clean-lead-v0";

/** True when the output is a loudspeaker the mic will hear ("MacBook Pro Speakers",
 *  "iMac Speakers", older macOS's "Built-in Output"). Live monitoring there feeds back. */
export function looksLikeSpeakers(outputDevice: string | null | undefined): boolean {
  const name = (outputDevice ?? "").trim();
  return /speakers?\b/i.test(name) || /^built-in output$/i.test(name);
}

/** Which of the loop's two tracks get the default chain: both, so what you hear while
 *  singing (through Takes) matches what a kept pass plays back with (on Lead). Never
 *  when the Lead already carries effects -- that is the producer's own chain, and a
 *  default must not sit on top of it -- and never on a track that already has any. */
export function defaultChainTargets(tracks: readonly Track[], leadId: string, takesId: string): Track[] {
  const lead = tracks.find((t) => t.id === leadId);
  if (!lead || (lead.plugins ?? []).length > 0) return [];
  const takes = tracks.find((t) => t.id === takesId);
  return [lead, takes].filter((t): t is Track =>
    t !== undefined && acceptsTrackPreset(t) && (t.plugins ?? []).length === 0);
}
