# FMS-Bench — the in-voice run on REAL mumbles (2026-07-18)

The measurement the benchmark was built for, with every confound removed at last: a **real**
mumble in, a **real** finished vocal of the same song as reference, on the same session clock,
rendered in the owner's **own** voice. Oracle lyrics, 0–12 s window, `bench_own_run.py`.

## Result

| song | arm | wordAlign | hit | onsetF1 | →reference | →input | pq |
|---|---|---|---|---|---|---|---|
| LookinBack | reference | 0.404 | 0.72 | 1.000 | 1.000 | 0.422 | 7.10 |
| LookinBack | mumble | 0.147 | 0.17 | 0.476 | 0.414 | 1.000 | 7.02 |
| LookinBack | pipeline | 0.591 | 0.83 | 0.242 | 0.104 | 0.173 | 6.76 |
| LookinBack | **pipeline+snap** | 0.613 | 0.83 | 0.250 | 0.440 | 0.304 | 6.91 |
| stage10 | reference | 0.204 | 0.39 | 1.000 | 1.000 | 0.422 | 6.52 |
| stage10 | mumble | 0.125 | 0.12 | 0.316 | 0.388 | 1.000 | 6.44 |
| stage10 | pipeline | 0.325 | 0.42 | 0.500 | 0.148 | 0.222 | 6.85 |
| stage10 | **pipeline+snap** | 0.428 | 0.58 | 0.462 | 0.269 | 0.173 | 6.74 |
| stage9orsum | reference | 0.332 | 0.50 | 1.000 | 1.000 | 0.473 | 7.02 |
| stage9orsum | mumble | 0.166 | 0.19 | 0.308 | 0.399 | 1.000 | 6.77 |
| stage9orsum | pipeline | 0.429 | 0.62 | 0.065 | 0.060 | 0.205 | 7.22 |
| stage9orsum | **pipeline+snap** | 0.428 | 0.59 | 0.125 | 0.089 | 0.115 | 7.37 |

**Means** — wordAlign / →reference / →input:
reference **0.313 / 1.000 / 0.439** · mumble **0.146 / 0.400 / 1.000** ·
pipeline **0.448 / 0.104 / 0.200** · pipeline+snap **0.490 / 0.266 / 0.197**

## The verdict, in one line

**The pipeline solves the words and breaks the performance.**

- **Words: 0.146 → 0.490** — a 3.4× lift over the floor, and *past the human's own 0.313*.
- **Performance: 0.400 → 0.266** — the output is **further from the finished take than the
  raw mumble was**. Doing nothing scores better on this axis than running the pipeline.

That is precisely the owner's standing ear complaint — "it says the words but it isn't my
performance" — expressed as a number for the first time.

## What each number means

**Scoring above the human on word recovery is a red flag, not a win.** Forced alignment
rewards *canonical* articulation, and SoulX sings exactly the phonemes it was handed. A real
human sings with accent, slur, and style and aligns worse. So the human 0.313 is a **target**,
not a ceiling: 0.490 reads as "more robotically articulate than the singer," which is the
"doesn't sound human" complaint restated. (Caveat: the reference is aligned against Whisper's
transcript *of itself*, so ASR error depresses it somewhat — the gap is real but not its full
size.)

**No echoing.** Every arm is scored against its input as well as the reference. The two human
takes correlate **0.439**; the pipeline sits at **0.197–0.200**, far below. It genuinely
re-sings rather than handing back its input — the trap that killed the ACE cover lane is
avoided here.

**The product's phrase-snap is load-bearing and insufficient.** Adding
`soulx.perform.snap_render_to_take` lifts →reference from 0.104 to 0.266 (on LookinBack,
0.104 → 0.440, matching the mumble floor). Without this arm the run would have measured a raw
render and understated the shipping chain. But the mean still sits below the 0.400 floor.

**pq separates nothing** (6.44–7.37 across every arm, human and machine alike), confirming the
human-baseline verdict: pq tracks production polish, not human-ness. SingMOS-Pro is the
outstanding work on the naturalness axis.

## Where this leaves the effort

Three axes, now individually settled by measurement:

| axis | status | evidence |
|---|---|---|
| **Pitch** | already solved *by the input* | mumble vs finished differ by 0.0–0.1 semitones |
| **Words** | solved, arguably over-solved | 0.146 → 0.490 vs the human's 0.313 |
| **Performance / timing** | **the frontier** | 0.400 floor → 0.266; onsetF1 0.37 → 0.28 |

The target is now a specific number rather than an ear impression: **two human takes of the
same song correlate ≈0.40–0.44 in energy envelope.** A correct system should land there — as
far from the reference as another human performance would be, no further and no closer
(closer implies copying). Today's chain reaches 0.266.

Effort spent on pitch correction addresses a solved problem; effort on word accuracy is past
the point of returns and may now be *hurting* naturalness. **Performance transfer is the
whole remaining gap.**

## Method notes

- **F0 comes from the MUMBLE, never the finished take** (`pipeline_generate(f0_from=…)`,
  explicit rather than inferred). The finished take is the answer; reading its F0 would leak it.
- Cross-rate comparisons resample with band-limited polyphase (`resample_hq`), not linear —
  linear interpolation leaves HF images, the documented "squeak" root cause.
- One window (0–12 s) per song; full-take chunk assembly is not yet run.
- Oracle lyrics: the pipeline is handed the true words, isolating sing/timing quality from
  word *discovery*. Free-lyrics (words read off the mumble) remains deliberately out of scope.
