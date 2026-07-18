# FMS — performance transfer, Phase 1: the lever matrix (2026-07-18)

The own-pairs run diagnosed the pipeline as *solving the words and breaking the performance*
(energy-envelope correlation to the finished take 0.400 floor → 0.266). Phase 1 measures the
levers that already exist before building anything, on the own-pairs lane, in-voice, against
the **two-sided human band**: two genuine takes of the same song correlate **0.40–0.44**, so
landing above the band means the envelope was *painted on* rather than transferred.

## Result (3 songs, 0–12 s, verbatim durations)

| arm | wordAlign | onsetF1 | →reference | →input | pq | band verdict |
|---|---|---|---|---|---|---|
| reference (human) | 0.313 | 1.000 | 1.000 | 0.439 | 6.88 | (identity) |
| mumble (floor) | 0.146 | 0.367 | 0.400 | 1.000 | 6.74 | IN BAND ✓ |
| pipeline | 0.424 | 0.378 | 0.145 | 0.222 | 6.94 | below (gap 0.255) |
| pipeline+snap | 0.490 | 0.297 | 0.303 | 0.286 | **7.06** | below (gap 0.097) |
| snap+dyn:**frame** | 0.394 | 0.523 | **0.726** | 0.367 | **6.47** | **above band — painted** |
| snap+dyn:**note** | 0.463 | 0.346 | **0.414** | 0.245 | 6.96 | **IN BAND ✓** |

## The finding: per-NOTE loudness transfer closes the gap; per-FRAME overshoots it

**`note` — impose the take's loudness per note, leave the model's attack/decay shape intact
inside each note — lands at 0.414, dead in the human band**, while keeping word recovery
(0.463), leaving pq unchanged (6.96 vs 7.06), and not echoing its input (0.245, far below the
human takes' own 0.439).

**`frame` — the deleted implementation recovered verbatim from `fac16264` — overshoots to
0.726.** This is the version the owner rejected by ear as *"I can hear the volume automation
rather than the words ending naturally."* Three independent signals now agree it is bad:

1. it lands **far above** the human band (0.726 vs 0.40–0.44) — painted, not transferred;
2. it has the **worst pq of any arm** (6.47, the only arm below even the raw mumble), and worst
   of all on the song where it overshoots most (LookinBack 6.14);
3. the owner had already rejected it by ear, independently, months of context ago.

That agreement is the headline methodological result: **the band metric flags the known-bad
implementation as bad.** A naive "higher correlation is better" reading would have crowned
0.726 the winner — precisely the V3 trap, where a metric improved while the sound degraded.
The two-sided band exists only because the own-pairs data told us what a human scores, and it
is what makes this axis safe to optimize.

Note also `frame` *raises onset F1* (0.523, best of any arm) while sounding worst — the exact
V3 signature repeating. Alignment metrics reward it; ears do not.

## Negative result: derived durations (B1-lite) does not move this axis

Re-running the full matrix with `durations="derived"` changes nothing measurable:
`pipeline+snap` 0.303 → 0.302, `snap+dyn:note` 0.414 → 0.408, word recovery 0.490 → 0.445.

This is not a refutation of B1-lite — it was built to fix **vowel-onset placement** (its own
instrument measured 45 ms → 0.0 ms), which is finer-grained than energy-envelope correlation
and invisible to it. The honest reading: **derived durations is not the performance-transfer
fix, and its outstanding ear-gate remains a separate open question.**

## Caveats

- The band (0.40–0.44) is measured from **n=3 songs**; per-song the `note` arm reads
  0.498 / 0.379 / 0.365, so "in band" is a statement about the mean, not a per-song guarantee.
- `snap+dyn:note` is a **lab probe applied post-hoc in the bench**, not a product
  implementation. Phase 2 ports it into `perform.py` + the adapter behind a gate.
- pq again ranks `pipeline+snap` (7.06) **above the human reference** (6.88), re-confirming it
  measures production polish rather than human-ness. It is used here only as a *degradation
  detector* — where it drops sharply (frame, 6.47), something audible broke.
- The benchmark nominates; it does not decide. The ear gate is Phase 3.

## Verdict

Dynamics is confirmed as the dominant term in the performance gap, and the fix is **per-note,
not per-frame**: transfer the take's loudness at note granularity and leave the model's own
articulation inside each note alone. Proceed to Phase 2 — productionize it behind a
`strength` gate with a `strength=0 ⇒ byte-identical` pin — then Phase 3 blind A/B, which also
finally closes the stale B1-lite gate.
