// Real waveform peaks for seeded dev sessions. A wave clip whose sourceFile is
// "/fixture/<stem>" draws the min/max envelope scripts/portfolio/song_a_peaks.py computed
// from the actual audio, sliced to the clip's offset/length and resampled to the caller's
// bucket count — so the dev lane shows a real song's shape, not a synthetic sine.
import fixture from "./fixtures/songA.peaks.json";
import type { Clip } from "../types";

type PeakPair = [number, number];
type Fixture = { perSec: number; stems: Record<string, PeakPair[]>; durationSec: Record<string, number> };
const data = fixture as unknown as Fixture;

export const FIXTURE_PREFIX = "/fixture/";

export function fixtureStemOf(sourceFile: string | undefined): string | null {
  if (!sourceFile || !sourceFile.startsWith(FIXTURE_PREFIX)) return null;
  const stem = sourceFile.slice(FIXTURE_PREFIX.length);
  return stem in data.stems ? stem : null;
}

export function fixtureStemDuration(stem: string): number {
  return data.durationSec[stem] ?? data.stems[stem].length / data.perSec;
}

/** Slice `stem`'s envelope to [offsetSec, offsetSec + lengthSec] and merge it into `buckets`
 *  min/max pairs. Buckets past the end of the audio read as silence. */
export function fixturePeaks(stem: string, offsetSec: number, lengthSec: number, buckets: number): PeakPair[] {
  const src = data.stems[stem];
  const perSec = data.perSec;
  const out: PeakPair[] = [];
  const n = Math.max(1, Math.floor(buckets));
  for (let i = 0; i < n; i++) {
    const t0 = offsetSec + (i / n) * lengthSec;
    const t1 = offsetSec + ((i + 1) / n) * lengthSec;
    const a = Math.max(0, Math.floor(t0 * perSec));
    const b = Math.max(a + 1, Math.ceil(t1 * perSec));
    let lo = 0, hi = 0, any = false;
    for (let k = a; k < b && k < src.length; k++) {
      const p = src[k];
      if (!any) { lo = p[0]; hi = p[1]; any = true; } else { if (p[0] < lo) lo = p[0]; if (p[1] > hi) hi = p[1]; }
    }
    out.push([lo, hi]);
  }
  return out;
}

/** Peaks for a clip if it is fixture-backed, else null (the caller falls back to its synthetic waveform). */
export function fixturePeaksForClip(clip: Clip, buckets: number): PeakPair[] | null {
  const stem = fixtureStemOf(clip.sourceFile);
  if (!stem) return null;
  return fixturePeaks(stem, clip.offset ?? 0, clip.length, buckets);
}
