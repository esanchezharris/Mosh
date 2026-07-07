// Offset-clip coordinate examples (Cycle-3 data fix — r3 diagnostic, 2026-07-06).
//
// The r3 61%-checkpoint peek found split_clip failing on the frozen eval's Keys
// clip (which starts at beat/second 4) with "split point outside clip": the model
// emits a valid split_clip but computes the time wrong on an OFFSET clip. Root
// cause (confirmed against the engine — split_clip time is ABSOLUTE timeline
// seconds, TimePosition::fromSeconds): every training clip starts at 0, so
// absolute == relative and the model never had to learn the distinction; on an
// offset clip it adds the offset / reads the time as clip-relative and lands
// outside.
//
// This module deterministically enumerates coordinate tasks on clips at NON-ZERO
// offsets, where the ONLY answer that clean-applies is the absolute pass-through
// (adding the offset lands outside → penalised). split_clip is primary (the
// confirmed miss); trim_clip / move_clip are the same coordinate class. PURE +
// seeded — golden-tested; the engine-validating emitter is ui/scripts/genOffsetCoords.mts.

export type ClipDef = { name: string; start: number; length: number };

export type CoordTask = {
  op: "split_clip" | "trim_clip" | "move_clip";
  clipName: string; // resolved to a real clipId by the emitter
  args: Record<string, number>; // absolute coordinates (clipId injected at emit time)
  request: string;
};

// Deterministic seeded PRNG (mulberry32) — reproducible enumeration.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, xs: T[]): T => xs[Math.floor(rng() * xs.length)];

const SPLIT_PHRASINGS = [
  (n: string, t: number) => `split the ${n} clip at ${t} seconds`,
  (n: string, t: number) => `cut ${n} at the ${t} second mark`,
  (n: string, t: number) => `can you split ${n} at ${t}s?`,
  (n: string, t: number) => `divide the ${n} clip at ${t} seconds on the timeline`,
  (n: string, t: number) => `slice ${n} at ${t} seconds`,
];
const MOVE_PHRASINGS = [
  (n: string, s: number) => `move the ${n} clip to ${s} seconds`,
  (n: string, s: number) => `shift ${n} so it starts at ${s}s`,
  (n: string, s: number) => `drag ${n} to the ${s} second mark`,
  (n: string, s: number) => `reposition the ${n} clip to start at ${s} seconds`,
];
const TRIM_PHRASINGS = [
  (n: string, s: number, l: number) => `trim ${n} to start at ${s} seconds and run for ${l} seconds`,
  (n: string, s: number, l: number) => `resize the ${n} clip: start ${s}s, length ${l}s`,
  (n: string, s: number, l: number) => `set ${n} to begin at ${s} seconds with a ${l} second length`,
];

// Tasks for one offset clip. Every coordinate is ABSOLUTE and lands inside/valid,
// so the gold clean-applies and the "add the offset" error would land outside.
export function coordTasksForClip(clip: ClipDef, seed: number): CoordTask[] {
  const rng = mulberry32(seed);
  const { name, start, length } = clip;
  const end = start + length;
  const out: CoordTask[] = [];

  // split_clip — the confirmed miss. Two distinct interior split points (integers
  // strictly between start and end). Requires length ≥ 2 for two distinct points.
  const interior: number[] = [];
  for (let t = Math.ceil(start) + 1; t <= Math.floor(end) - 1; t++) interior.push(t);
  if (interior.length) {
    const n = Math.min(2, interior.length);
    const chosen = new Set<number>();
    while (chosen.size < n) chosen.add(pick(rng, interior));
    for (const t of chosen) {
      out.push({ op: "split_clip", clipName: name, args: { time: t }, request: pick(rng, SPLIT_PHRASINGS)(name, t) });
    }
  }

  // move_clip — new absolute start ≠ current, non-zero (offset-sensitive).
  const moveTo = start + (rng() < 0.5 ? 2 : -1 * Math.min(2, Math.floor(start)));
  const ms = Math.max(1, Math.round(moveTo === start ? start + 1 : moveTo));
  out.push({ op: "move_clip", clipName: name, args: { start: ms }, request: pick(rng, MOVE_PHRASINGS)(name, ms) });

  // trim_clip — new absolute start (non-zero) + a shorter length that stays > 0.
  const ts = Math.max(1, Math.round(start + 1));
  const tl = Math.max(1, Math.round(length - 1));
  out.push({ op: "trim_clip", clipName: name, args: { start: ts, length: tl }, request: pick(rng, TRIM_PHRASINGS)(name, ts, tl) });

  return out;
}

export function coordTasks(clips: ClipDef[], seed: number): CoordTask[] {
  return clips.flatMap((c, i) => coordTasksForClip(c, seed + i * 1009));
}

// Invariant used by the golden + a belt in the emitter: a split time must be
// STRICTLY inside the clip (else it can't clean-apply and can't teach the offset).
export function splitTimeIsInterior(clip: ClipDef, time: number): boolean {
  return time > clip.start && time < clip.start + clip.length;
}
