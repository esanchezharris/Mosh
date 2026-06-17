// Pure string similarity for the deterministic phrase matcher — a dependency-free
// port of fuzzywuzzy's token_set_ratio (order-independent, subset-tolerant), using a
// Levenshtein ratio in place of SequenceMatcher. No DOM/node — unit-tested.

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

const ratio = (a: string, b: string): number => {
  if (!a && !b) return 1;
  const max = Math.max(a.length, b.length);
  return max ? 1 - levenshtein(a, b) / max : 1;
};

const uniqTokens = (s: string): string[] => [...new Set(s.split(/\s+/).filter(Boolean))];

/** token_set_ratio in [0,1]: high when `phrase`'s tokens are a subset of `utterance`'s,
 *  order-independent and tolerant of extra/filler words. 0 against an empty phrase. */
export function tokenSetScore(utterance: string, phrase: string): number {
  const A = new Set(uniqTokens(utterance));
  const B = new Set(uniqTokens(phrase));
  if (B.size === 0) return 0;
  const inter = [...A].filter((t) => B.has(t)).sort();
  const restA = [...A].filter((t) => !B.has(t)).sort();
  const restB = [...B].filter((t) => !A.has(t)).sort();
  const t0 = inter.join(" ");
  const tA = [...inter, ...restA].join(" ");
  const tB = [...inter, ...restB].join(" ");
  return Math.max(ratio(t0, tA), ratio(t0, tB), ratio(tA, tB));
}
