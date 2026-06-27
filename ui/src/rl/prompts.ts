// RL-train prompt selection (pure, deterministic, unit-tested).
//
// The GRPO loop practices on a pool of eval-shaped tasks (EvalExample: utterance +
// setup prefix + gold command names). Two invariants matter:
//   1. NO LEAKAGE — every example whose source file appears in the frozen gate is
//      dropped, so the held-out clean-apply number stays honest.
//   2. BALANCE — the raw pool is ~90% note-population (add_note), whose clean-apply
//      reward is trivially easy; left unbalanced, GRPO would just farm it. We cap each
//      gold-command "shape" so the policy sees mixer/tempo/key/clip tasks too — the
//      same lesson that lifted SFT 0.42→0.62.

import type { EvalExample } from "../gepa/evalset";

/** Source file id = the part of an example id before "#" (e.g. "beat.als@123"). */
export function sourceId(ex: EvalExample): string {
  return (ex.id ?? "").split("#")[0];
}

/** The command-shape bucket key for balancing: the sorted, unique gold command names. */
export function shapeKey(ex: EvalExample): string {
  return [...new Set(ex.goldCommandNames ?? [])].sort().join("+") || "(none)";
}

// djb2 — same stable string hash used across the SFT tooling (deterministic shuffle).
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export type RlPromptOptions = {
  /** Max examples per gold-command shape bucket (balance). Default 250. */
  perShapeCap?: number;
  /** Overall cap after balancing (0 = no cap). Default 0. */
  max?: number;
  /** Deterministic shuffle seed. Default 1. */
  seed?: number;
};

export type RlPromptResult = {
  examples: EvalExample[];
  stats: {
    poolSize: number;
    droppedLeakage: number;
    droppedDup: number;
    perShape: Record<string, number>;
    gateSources: number;
  };
};

/**
 * Build the RL-train prompt set from candidate pools, excluding any example that
 * shares a source file with `gate`, deduping by id, then capping each command shape.
 */
export function buildRlPromptSet(
  pools: EvalExample[],
  gate: EvalExample[],
  opts: RlPromptOptions = {},
): RlPromptResult {
  const perShapeCap = opts.perShapeCap ?? 250;
  const max = opts.max ?? 0;
  const seed = opts.seed ?? 1;

  const gateSources = new Set(gate.map(sourceId));
  let droppedLeakage = 0;
  let droppedDup = 0;
  const seen = new Set<string>();
  const candidates: EvalExample[] = [];
  for (const ex of pools) {
    if (gateSources.has(sourceId(ex))) { droppedLeakage++; continue; }
    if (seen.has(ex.id)) { droppedDup++; continue; }
    seen.add(ex.id);
    candidates.push(ex);
  }

  // deterministic shuffle, then take up to perShapeCap of each shape
  candidates.sort((a, b) => hash(`${seed}:${a.id}`) - hash(`${seed}:${b.id}`));
  const perShape: Record<string, number> = {};
  const kept: EvalExample[] = [];
  for (const ex of candidates) {
    const k = shapeKey(ex);
    const n = perShape[k] ?? 0;
    if (n >= perShapeCap) continue;
    perShape[k] = n + 1;
    kept.push(ex);
  }

  // re-shuffle the balanced set so shapes interleave, then optional overall cap
  kept.sort((a, b) => hash(`${seed}:mix:${a.id}`) - hash(`${seed}:mix:${b.id}`));
  const examples = max > 0 ? kept.slice(0, max) : kept;

  return {
    examples,
    stats: { poolSize: pools.length, droppedLeakage, droppedDup, perShape, gateSources: gateSources.size },
  };
}
