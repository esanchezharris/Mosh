# FMS — ear gate: per-note dynamics REFUTED, and env_corr falsified a second time (2026-07-18)

Phase 1 nominated per-note dynamics transfer (energy-envelope corr 0.414, inside the human
band 0.40–0.44) over the shipping chain (0.303, below band) and the recovered per-frame
version (0.726, overshoot). Phase 2 built it, default-off. The blind ear gate ran on 3 songs,
arms shuffled per song, key held outside the serve root.

## Owner verdict

| song | ranking (best → worst) | unblinded |
|---|---|---|
| LookinBack | A > B > C | **today (no dynamics)** > per-note > per-frame |
| stage10 | A > B > C | **today (no dynamics)** > per-note > per-frame |
| stage9orsum | *"none of that match the rhythm or intonation of my mumble"* | all three rejected |

Unprompted, on LookinBack: *"B has some volume automation and C has lots."* B is per-note,
C is per-frame — he ranked the **amount** of envelope painting correctly, blind.

## Result 1 — the control validated the apparatus

Per-frame is the implementation the owner rejected by ear months ago. It ranked **last in both
rankable songs**, and he re-described the exact artifact unprompted. The known-answer control
did its job: the harness, the blinding, and the shuffle all behave.

## Result 2 — the nominated fix LOST, and the metric is anti-correlated

Per-note landed in the human band and still sounded **worse than doing nothing**. Worse, the
full ordering inverts:

| arm | env_corr | ear rank |
|---|---|---|
| per-frame | 0.726 | 3rd (worst) |
| per-note | 0.414 (in band) | 2nd |
| today (none) | 0.303 | **1st (best)** |

**Perfectly inverted, all three arms, both songs.** This is not metric noise — energy-envelope
correlation is *anti-correlated* with the ear on this axis. It is the **second** time env_corr
has been caught doing this (mechanism-verify V3 was the first, on the per-word snap).

The two-sided band was built specifically to guard against this failure mode, and **it was not
sufficient**. It correctly rejected the extreme (0.726) but wrongly preferred 0.414 over 0.303.

**Conclusions:**
1. **Retire energy-envelope correlation as the performance target.** Falsified twice. Whatever
   "sounds like my performance" is, it is not this. It may stay as a diagnostic; it may not
   gate decisions.
2. **Post-hoc gain transfer is the wrong MECHANISM, not a mistuned one.** The owner heard
   automation in *both* gain-based arms, differing in degree, not in kind. Turning a render
   down is not the same as singing quieter. Per-note was a smaller dose of the same error.
   The mel-domain / resynthesis route (make it *be* quieter singing) and expression-conditioned
   synthesis remain the only untried mechanisms.
3. `dynamics` stays **default "off"** in the adapter. The code is kept — it is the cheapest way
   to reproduce this finding — but it is not a shipping candidate.

## Result 3 — the words we feed the model are substantially wrong

stage9orsum's rejection is about *rhythm and intonation*, and prompted the owner to ask whether
supplying the real lyrics would help. Checking the ground truth actually in use — Whisper on
the finished take — in the exact rendered windows:

| song | words in window | below the 0.6 gate | what Whisper heard |
|---|---|---|---|
| LookinBack | 29 | **16 (55%)** | "…got a curved bottom, **Yattis** bitch might be bipolar, hell no **bono**" |
| stage10 | 26 | 7 (27%) | "See you and I get to fumbling… **Fuck you know by fumbling**, yeah" |
| stage9orsum | 33 | 5 (15%) | "I've been tough, I've been rough, I've been **guy**… I've **already sleep**… That **alligator around my jeans** must" |

The oracle-lyrics mode was never oracle — it was ASR. Two consequences:

1. **Phonemes**: SoulX sings what the score says. Wrong word in, wrong sounds out.
2. **Rhythm**: the author allocates roughly one note-slot per syllable, so a wrong word with a
   different syllable count **redistributes notes across the bar**. This is a direct mechanical
   path from bad transcription to "doesn't match the rhythm of my mumble" — meaning the
   stage9orsum complaint and the word problem may be the *same* problem, not two.

**Next: the owner supplies the real lyrics**, replacing ASR as the word source, and we re-run.
This is a genuinely untested variable and it is cheap. It does not depend on, and is not
blocked by, the dynamics lane being dead.

## Status

- Phase 2 (`transfer_note_dynamics`) — built, tested, **default off, not a shipping candidate**.
- Phase 3 ear gate — **run, and it refuted the nomination**. Working as intended: the benchmark
  nominates, the ear disposes, and this time the ear said no.
- B1-lite derived durations — still an open, separate ear question, untouched by this round.
