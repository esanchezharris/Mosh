// Recipe arithmetic for the LoRA Lab's knobs — the epochs <-> steps conversion,
// and nothing else.
//
// The measured EPOCH CURVE deliberately does not live here. It is
// `service/training/recipe.py`'s `_EPOCH_ANCHORS`, delivered through
// /training/capabilities, because it was fit to real runs on real hardware and a
// second copy in TypeScript would drift the moment either side is re-measured —
// and the drift would be invisible, since both numbers look equally plausible.
// What lives here is the arithmetic that turns a producer's chosen epoch count
// into a step count, which is pure and identical on both sides.
//
// Why the producer gets this knob at all: the round that produced the local
// trainer found that the same step count under-trains one corpus and over-trains
// another (145 / 44 / 11 epochs for 33 / 189 / 424 clips), AND that the
// best-scoring checkpoint was not the best-sounding one — a 25-epoch adapter had
// better character than a 44-epoch one scoring 0.14 higher. A single fixed recipe
// cannot be right. The default is a starting point; the Lab exists to let someone
// disagree with it by ear.

/** The recipe the service recommends for a corpus. Mirrors recommend_recipe(). */
export type Recipe = {
  epochs: number;
  steps: number;
  batchSize: number;
  gradAccum: number;
  effectiveBatch: number;
  footprintGb: number;
  estMinutes: number;
  clipCount: number;
  note?: string;
};

/** Steps needed for `epochs` passes over `clipCount` clips. Mirrors steps_for(). */
export function stepsFor(clipCount: number, epochs: number, batchSize: number, gradAccum: number): number {
  const effective = Math.max(1, Math.floor(batchSize) * Math.floor(gradAccum));
  return Math.max(1, Math.ceil(epochs * Math.max(1, Math.floor(clipCount)) / effective));
}

/** The inverse — what a given step count works out to in epochs. Shown next to
 *  the steps field so a producer who thinks in one unit can read the other. */
export function epochsFor(clipCount: number, steps: number, batchSize: number, gradAccum: number): number {
  const effective = Math.max(1, Math.floor(batchSize) * Math.floor(gradAccum));
  return (Math.max(1, steps) * effective) / Math.max(1, Math.floor(clipCount));
}

// Footprint model, fit to four direct phys_footprint measurements
// (22/31/40/49 GB at batch 1/2/3/4). Mirrors recipe.py's FIXED_GB /
// PER_BATCH_ITEM_GB — duplicated here ONLY to preview a knob change before
// submitting; the service re-checks and is the authority that refuses a run.
const FIXED_GB = 13.0;
const PER_BATCH_ITEM_GB = 9.0;

/** Estimated physical footprint of a training process at this batch size. */
export function footprintGb(batchSize: number): number {
  return FIXED_GB + PER_BATCH_ITEM_GB * Math.max(1, Math.floor(batchSize));
}

/**
 * How a chosen batch size sits against this machine's RAM.
 *
 * The thresholds are bracketed by measurement, not chosen round: on 64GB, batch 3
 * (40GB, 62.5%) ran healthy at 1.087 s/step while batch 4 (49GB, 76.6%) thrashed
 * at 12.65 s/step — an order of magnitude worse, and worse per sample than batch
 * 1. That is the failure this warning exists for, and it is worth stating plainly
 * because it does NOT announce itself: macOS grows the swapfile and the run
 * continues, looking merely slow rather than misconfigured.
 */
export type FootprintVerdict = { level: "ok" | "tight" | "over"; gb: number; pct: number; note: string };

export function footprintVerdict(batchSize: number, ramGb: number): FootprintVerdict {
  const gb = footprintGb(batchSize);
  if (!(ramGb > 0)) return { level: "ok", gb, pct: 0, note: `~${gb.toFixed(0)}GB` };
  const pct = gb / ramGb;
  if (pct > 0.70) {
    return {
      level: "over", gb, pct,
      note: `~${gb.toFixed(0)}GB of ${ramGb.toFixed(0)}GB — past the measured wall. macOS will swap rather than fail, and the run gets ~10x slower without saying so.`,
    };
  }
  if (pct > 0.55) {
    return {
      level: "tight", gb, pct,
      note: `~${gb.toFixed(0)}GB of ${ramGb.toFixed(0)}GB — fits, but only with other apps closed.`,
    };
  }
  return { level: "ok", gb, pct, note: `~${gb.toFixed(0)}GB of ${ramGb.toFixed(0)}GB` };
}

/** Wall-clock estimate at the measured ~1.1 s/step (nearly flat in batch size —
 *  the GPU is underfed, which is why accumulation is cheap). */
export function estMinutes(steps: number): number {
  return Math.round((steps * 1.1 / 60) * 10) / 10;
}

/** "12 min" / "1h 04m" — an ETA a producer reads at a glance. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
