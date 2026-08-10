import type { Snapshot } from "../types";
import { proToolsShownTracks, type ProToolsTrackVisibility } from "./proToolsTrackVisibility";

export type ReadonlyPeaks = Readonly<Record<string, readonly (readonly [number, number])[]>>;

const peaksAmplitude = (bucket: readonly [number, number] | undefined): number => (
  bucket ? Math.max(Math.abs(bucket[0]), Math.abs(bucket[1])) : 0
);

export function transientCandidates(
  snapshot: Snapshot | null,
  peaks: ReadonlyPeaks,
  trackVisibility: ProToolsTrackVisibility = {},
): readonly number[] {
  if (!snapshot) return [];
  const candidates: number[] = [];
  for (const track of proToolsShownTracks(snapshot.tracks, trackVisibility)) {
    for (const clip of track.clips) {
      if (clip.type !== "wave") continue;
      const buckets = peaks[clip.id];
      if (!buckets || buckets.length === 0) continue;
      for (let index = 0; index < buckets.length; index += 1) {
        const bucket = buckets[index];
        if (!bucket) continue;
        const previous = index === 0 ? 0 : peaksAmplitude(buckets[index - 1]);
        if (peaksAmplitude(bucket) >= 0.65 && previous < 0.45) {
          candidates.push(clip.start + (index / buckets.length) * clip.length);
        }
      }
    }
  }
  return candidates;
}
