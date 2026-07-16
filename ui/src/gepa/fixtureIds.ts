// Frozen-eval fixture id repair + tripwire (2026-07-10).
//
// Bug class: frozen-eval-v2 §A utterances from the EVAL-synthesis run were
// authored against the REAL engine's session (MoshOps logical ids start at
// 1000: the eval profile's entities landed on 1010–1018), but eval rows replay
// their startCommands on the MOCK engine (ids 17+/107+) — so the referenced
// entities never exist in the snapshot the model sees, and the row is
// unpassable by a rule-following model (29/210 rows; see
// docs/bench/SMALL_MODEL_MODE_2026-07.md §4).
//
// Fix: rewrite real-id tokens to ${VAR} placeholders naming the SAME vars the
// row's startCommands bind; the scorer (metric.ts resolveUtterance) substitutes
// the mock-bound ids at prompt-build time — like startCommands' $refs, robust
// to any future change in mock id assignment.

/** Real-engine id → bind var for SETUP_PROFILES.eval / buildEvalV2A's EVAL_BOUND.
 *  Recovered 2026-07-10 by replaying the eval profile through a real
 *  `Mosh --run-script` (id assignment is deterministic across replays — see
 *  scripts/lib/realEngine.mts): create_track Kick→1010, Keys→1012, Sub→1013,
 *  Lead→1014, add_midi_clip(Keys)→1016, add_test_tone_clip(Sub)→1018 (the real
 *  engine skips 1011/1015/1017 on side objects, so a positional map would be
 *  wrong — re-derive by replay if the profile ever changes). */
export const EVAL_REAL_ID_TO_VAR: Record<string, string> = {
  "1010": "TKICK",
  "1012": "TKEYS",
  "1013": "TSUB",
  "1014": "TLEAD",
  "1016": "CKEYS",
  "1018": "CSUB",
};

/** Rewrite mapped real-engine id tokens (word-bounded) to ${VAR} placeholders.
 *  Unmapped numbers — note values, dB amounts, names like "808" — are untouched. */
export function rewriteRealIds(utterance: string): string {
  return utterance.replace(/(?<![\w])(1\d{3})(?![\w])/g, (tok) => {
    const v = EVAL_REAL_ID_TO_VAR[tok];
    return v ? "${" + v + "}" : tok;
  });
}

/** Build-time tripwire: tokens in a (resolved) utterance that cannot resolve in
 *  the rendered snapshot text. Flags (a) leftover ${VAR} placeholders and (b)
 *  1000-series tokens (the real-engine logical-id namespace — the mock never
 *  assigns these) that don't appear as a quoted id in `snapText`. */
export function fixtureIdGaps(utterance: string, snapText: string): string[] {
  const gaps: string[] = [];
  for (const m of utterance.matchAll(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g)) gaps.push(m[0]);
  for (const m of utterance.matchAll(/(?<![\w])(1\d{3})(?![\w])/g)) {
    if (!snapText.includes(`"${m[1]}"`)) gaps.push(m[1]);
  }
  return gaps;
}
