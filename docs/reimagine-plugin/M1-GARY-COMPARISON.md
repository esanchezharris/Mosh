# Re-Imagine M1 versus Gary: comparison sheet

Owner decision of 2026-10-19: Gary is used **directly** as the baseline. Mosh does not
call, wrap or copy Gary (gary4juce is AGPL-3.0-only; the gary4local mac repository has no
licence file, see [DEPENDENCY_BOM.md](../DEPENDENCY_BOM.md)). The comparison asks one
question: on the same source and the same candidate budget, does the Mosh loop get you to
a keeper with less time and fewer controls than your competent direct use of Gary?

Nothing here is filled in by an agent. The keep/reject columns are yours. A blank cell
means "not observed", never "no".

## Fixed conditions (write them down before you start)

| Item | Value |
|---|---|
| Date | |
| Source phrase (file name; authorized, yours) | |
| Source length (bars, seconds), BPM, key, chords as entered | |
| Host and project | Ableton Live 11, Set: |
| Gary build and backend (gary4local version; SA3 on `127.0.0.1:8006` or Carey/ACE-Step on `:8003`) | |
| Mosh commit and backend (local SA3 Medium MLX through the Re-Imagine helper) | |
| Mosh controller (template, or Claude planner + model) | |
| Candidate budget, both sides | 2 initial candidates, then 1 revision batch of 2, at most 8 attempts |
| Order (alternate which tool goes first between sessions) | |

Use the same two requests on both sides:

1. "Turn these eight bars of keys into a hazy sampled-keyboard loop. Follow the supplied
   chord changes and make the performance less busy."
2. After choosing the closer candidate: "Roughen the texture, but preserve the
   chord-change timing."

Gary does not get the chord list unless you type it into its prompt yourself; write down
whether you did. Do not run Gary and the Mosh helper renders at the same time: both load
SA3 into memory.

## Measures

- **Time to first auditionable candidate:** from pressing Generate (Mosh) or the
  generate/transform button (Gary) to the moment you can hear a candidate against the
  track. Stopwatch it. Mosh also logs `generationSeconds` per attempt and, with the
  instrumentation in this milestone, `firstCandidateSeconds` per intention in
  `~/Library/Mosh/ReImagine/experience.jsonl`. Use your stopwatch for the comparison; the
  log is a cross-check.
- **Controls touched:** every setting you changed to get the result, counting each control
  once per request (prompt box, strength/variation, model selector, duration, seed, BPM,
  key, chord list, candidate count, LoRA, loop/continue toggles, drag/import). Mosh logs
  its own count as `controlsTouched`; count Gary's by hand.
- **Keep / reject per candidate:** your call after listening in context. `keep`,
  `reject` or blank.
- **Notes:** what you noticed (timing drift, harmony, texture, artefacts).

## Session table

| Side | Request | Candidate | Seconds to first audible | Controls touched | Keep / reject | Notes |
|---|---|---|---|---|---|---|
| Gary | 1 | A | | | | |
| Gary | 1 | B | | | | |
| Gary | 2 (revision of chosen) | A | | | | |
| Gary | 2 (revision of chosen) | B | | | | |
| Mosh | 1 | v1 | | | | |
| Mosh | 1 | v2 | | | | |
| Mosh | 2 (revision of chosen) | v3 | | | | |
| Mosh | 2 (revision of chosen) | v4 | | | | |

## Summary (yours)

| Question | Gary | Mosh |
|---|---|---|
| Keepers found | | |
| Total minutes to first keeper | | |
| Total controls touched | | |
| Attempts spent (of 8) | | |
| Would you use this again on the next song? | | |

One session is an anecdote, not a result. Repeat on a second phrase before drawing a
conclusion, and record which tool went first each time.
