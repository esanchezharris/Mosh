// M2 (Phase-B memory lane) — the generic deterministic tag/keyword scorer, extracted
// VERBATIM from knowledge.ts's original retrieveCards so retrieveContext.ts can score
// OTHER pools (preferences, patterns) with the exact same algorithm. This is a PURE
// extraction: knowledge.ts's cardWeights + retrieveCards now call scorePool() below
// instead of inlining the map/filter/sort — same tokens, same tie-break, same output,
// proven byte-stable by knowledge.test.ts (unchanged, still green).
//
// Deliberately free of any bridge/window dependency (imported by knowledge.ts, which
// the offline benchmark runner pulls in — see brainCore.ts's header comment).

const TOKEN_RE = /[a-z0-9]+/g;

// Very common / low-signal words carry no "which control" signal — exclude them.
export const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at", "for", "with",
  "i", "me", "my", "you", "your", "it", "its", "is", "are", "be", "am", "as", "so",
  "that", "this", "do", "does", "did", "how", "should", "can", "could", "would",
  "will", "if", "then", "than", "out", "up", "down", "more", "less", "not", "no",
  "yes", "just", "now", "when", "why", "what", "some", "any", "get", "got",
]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of (text || "").toLowerCase().matchAll(TOKEN_RE)) {
    const t = m[0];
    if (t.length >= 2 && !STOP.has(t)) out.push(t);
  }
  return out;
}

export type Scored<T> = { item: T; score: number };

/** Scores `pool` against `query` by summed weighted token overlap: each item supplies
 *  its own token→weight map via `weightsOf` (so a knowledge card's tiered tags/topic/
 *  prose weighting, or a flat per-token memory-item weight, are both just callers of
 *  this one scorer). Deterministic — ties break by `tieBreakKey`. Zero-overlap items
 *  are dropped (an irrelevant item in the prompt is worse than none). An empty query
 *  (no tokens) returns []. Unsorted-by-limit: callers slice() the result themselves. */
export function scorePool<T>(
  query: string,
  pool: readonly T[],
  weightsOf: (item: T) => Map<string, number>,
  tieBreakKey: (item: T) => string,
): Scored<T>[] {
  const qTokens = Array.from(new Set(tokenize(query)));
  if (qTokens.length === 0) return [];
  const scored = pool
    .map((item) => {
      const w = weightsOf(item);
      let score = 0;
      for (const t of qTokens) score += w.get(t) ?? 0;
      return { item, score };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || tieBreakKey(a.item).localeCompare(tieBreakKey(b.item)));
  return scored;
}
