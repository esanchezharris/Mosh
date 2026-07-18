// Pure helper: resolve a named song SECTION (MOSH_SECTIONS — beat-based, tempo/time-sig
// independent; see types.ts's Section) to a [startSec, endSec) export range. export_audio
// itself only understands seconds (range:"custom" + start/end), so this is the one place
// a chosen section id turns into the args ExportControls dispatches. Uses the SAME
// canonical meter as the rest of the timeline (time.ts's meterFrom/beatSeconds — matches
// v2/timeline/geom.ts's beatToSec and SectionNavigator's jump-to-section), so a section
// export lands on exactly the region the section ribbon shows.

import { meterFrom, beatSeconds } from "./time";
import type { Section } from "./types";

export type SectionExportRange = { start: number; end: number };

/** [startSec, endSec) for a section, resolved via the project's tempo + time signature.
 *  Returns null when there's no section to resolve — callers fall back to leaving the
 *  export range untouched (a full-mix export) rather than sending a bogus range. */
export function resolveSectionExportRange(
  section: Section | undefined,
  session?: { tempo?: number; timeSigNumerator?: number; timeSigDenominator?: number },
): SectionExportRange | null {
  if (!section) return null;
  const bs = beatSeconds(meterFrom(session));
  return { start: section.startBeat * bs, end: section.endBeat * bs };
}
