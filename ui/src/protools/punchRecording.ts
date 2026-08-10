import { beatAt, secAtBeat, tempoMapFrom } from "../time";
import type { Snapshot, Transport } from "../types";
import type { TimeRangeSel } from "../v2/shellState";

export type ProToolsPunchRange = { start: number; end: number };

const finiteRange = (range: ProToolsPunchRange | null | undefined): ProToolsPunchRange | null => {
  if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end)) return null;
  const start = Math.max(0, Math.min(range.start, range.end));
  const end = Math.max(range.start, range.end);
  return end - start > 1e-3 ? { start, end } : null;
};

/** Pro Tools uses the current Edit selection for a specified punch. Mosh stores the
 * engine's in/out markers in the transport loop range, while keeping loop playback off. */
export function resolveProToolsPunchRange(
  editSelection: TimeRangeSel | null,
  transport: Transport,
): ProToolsPunchRange | null {
  return finiteRange(editSelection)
    ?? finiteRange({ start: transport.loopStart, end: transport.loopEnd });
}

export function formatProToolsPunchRange(range: ProToolsPunchRange | null): string {
  return range ? `${range.start.toFixed(3)} – ${range.end.toFixed(3)} s` : "Select a range";
}

/** Visualize the nominal count-in span. Tracktion subtracts the configured count-in
 * beats from the capture point through its tempo sequence; this mirrors that mapping.
 * Audible click/capture timing remains native-device evidence, not a browser claim. */
export function proToolsPreRollRange(
  snapshot: Snapshot,
  captureStart: number,
): ProToolsPunchRange | null {
  const bars = snapshot.session.countInBars ?? snapshot.session.project?.countInBars ?? 0;
  if (bars !== 1 && bars !== 2) return null;
  const map = tempoMapFrom(snapshot.session);
  const beats = bars * (snapshot.session.timeSigNumerator ?? 4);
  const startBeat = Math.max(0, beatAt(map, Math.max(0, captureStart)) - beats);
  const start = secAtBeat(map, startBeat);
  return captureStart - start > 1e-3 ? { start, end: captureStart } : null;
}
