// Finish-My-Song — the LIVE flow meter (rung 2). Pure, UI-local, zero round-trip:
// an instant syllable estimate + gap parsing + grid-derived target so the producer
// sees "does this line fit the beat" as they type. It deliberately mirrors the
// service's stdlib vowel-group heuristic (service/phonology/core.py::heuristic_syllables)
// so the live readout agrees with the precise backend on the common case; the precise
// dictionary stress/rhyme is a service call (get_rhymes / analyze), not this.

const VOWELS = "aeiouy";

/** Vowel-group syllable estimate for one word. Mirrors the Python heuristic. */
export function syllablesForWord(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  let count = 0;
  let prevVowel = false;
  for (const ch of w) {
    const isV = VOWELS.includes(ch);
    if (isV && !prevVowel) count += 1;
    prevVowel = isV;
  }
  // A silent trailing 'e' usually isn't its own syllable ("came") — but keep 'le'
  // ("table"), which is.
  if (w.endsWith("e") && !w.endsWith("le") && count > 1) count -= 1;
  return Math.max(1, count);
}

/** Total syllables across a line (gap markers + punctuation ignored). */
export function countSyllables(line: string): number {
  return tokenize(line)
    .filter((t) => !t.gap)
    .reduce((sum, t) => sum + syllablesForWord(t.text), 0);
}

export type SeedToken = { text: string; gap: boolean };

/** Tokenize a seed line, marking ___ runs (2+ underscores) as gaps. */
export function parseSeed(seedText: string): {
  tokens: SeedToken[];
  words: number;
  gaps: number;
} {
  const tokens = tokenize(seedText);
  return {
    tokens,
    words: tokens.filter((t) => !t.gap).length,
    gaps: tokens.filter((t) => t.gap).length,
  };
}

function tokenize(line: string): SeedToken[] {
  return (line.trim().match(/\S+/g) ?? []).map((t) => ({
    text: t,
    gap: /^_{2,}$/.test(t),
  }));
}

/** Default syllable target = subdivisions-per-bar × bars (16ths ⇒ 16/bar). */
export function gridTarget(grid: string, bars = 1): number {
  const perBar = grid === "1/4" ? 4 : grid === "1/8" ? 8 : grid === "1/16" ? 16 : 16;
  return perBar * Math.max(1, bars);
}

export type FlowState = "under" | "ok" | "over";

/** Is the line within tolerance of its target? target 0 ⇒ no target ⇒ "ok". */
export function flowStatus(count: number, target: number, tol = 1): FlowState {
  if (!target) return "ok";
  if (count < target - tol) return "under";
  if (count > target + tol) return "over";
  return "ok";
}
