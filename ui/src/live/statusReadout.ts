// The status bar's left readout (SPEC §9): a context-sensitive line — the current
// selection when there is one, the playhead position otherwise. Pure so the wording
// is pinned by unit tests rather than asserted from a browser.

import { secondsToBBSMap, type TempoMap } from "../time";
import type { Snapshot, Transport } from "../types";

export function statusReadout(
  snapshot: Snapshot | null,
  selection: ReadonlySet<string>,
  transport: Transport,
  map: TempoMap,
): string {
  if (snapshot && selection.size > 0) {
    const clips = snapshot.tracks
      .flatMap((t) => t.clips)
      .filter((c) => selection.has(c.id));
    if (clips.length === 1) {
      const c = clips[0];
      return `Clip: ${c.name} — Start ${secondsToBBSMap(map, c.start)} · Length ${secondsToBBSMap(map, c.length)}`;
    }
    if (clips.length > 1) return `${clips.length} clips selected`;
    // A selection id that no current clip owns (stale between commands): say so
    // plainly rather than naming nothing.
    return `${selection.size} selected`;
  }
  return `Position ${secondsToBBSMap(map, transport.position)}`;
}
