# Reference extraction — findings (2026-09-03)

Running log for the validation experiment in the approved plan: prove the
reference-extraction method produces coherent, actionable numbers *before*
building a pipeline around it. Corpus is the four Ableton projects already on
disk (see [FREE-FIRST-2026-09.md](FREE-FIRST-2026-09.md)); no downloads.

---

## S0 — is the mixer fader even the right thing to measure?

**Why this ran first.** A design review flagged that `Mixer.Volume.Manual` is
only one of several gain stages in an Ableton project. If the balance actually
lives in clip gain, sampler volume, Utility devices or group tracks, then every
dB number extracted from the fader measures the wrong thing, and the whole
"measure the mix" premise fails on the instrument rather than the theory.

Pre-registered kill criterion: **more than 30% of tracks in at least two of the
four projects staging gain outside the fader** ⇒ drop all dB-valued outputs and
keep only categorical/structural findings.

### Result: the criterion is NOT met, but the concern was real

| Project | Tracks | Groups | Staging gain outside the fader |
|---|---|---|---|
| Adriatique — Back To Life | 46 | 7 | **29 (63%)** |
| Adriatique — Never Alone | 23 | 4 | 6 (26%) |
| STMPD — By Myself | 109 | 17 | 14 (13%) |
| Gravitas — Catalyst Demo | 32 | 3 | 5 (16%) |
| **Total** | **210** | **31** | **54 (26%)** |

One project of four exceeds 30%, not two. The experiment continues — but with a
corrected instrument, because two distinct things are going on.

### What is actually happening

**1. A uniform sampler trim that cancels out of every relative measure.** Both
Adriatique projects apply an essentially constant Simpler trim to every drum
track:

| Track | Fader | Simpler | Effective |
|---|---|---|---|
| Kick | −5.5 | −12.0 | −17.5 |
| Snare 1 | −3.0 | −12.0 | −15.0 |
| Snare 2 | −1.1 | −12.0 | −13.1 |
| Clap | −8.2 | −12.0 | −20.2 |
| Rim | −12.1 | −12.4 | −24.4 |
| Shaker 1 | −15.6 | −12.4 | −28.0 |

That is headroom management, not balance: a constant offset applied to
everything. It shifts absolute levels by ~12 dB but leaves every *relative*
relationship intact. Since the plan's hypothesis is explicitly about
relationships, this stage is survivable.

**2. Group gain, which does not cancel.** STMPD's groups sit at −2.6, −5.4,
−6.4 and +0.8 dB; Gravitas' at −1.3 dB. Per-group offsets change the balance
*between* roles, so they must be summed into any effective level. This is the
part that would genuinely have corrupted the numbers.

### Consequence for the extractor

The extractor must compute an **effective level** per track, summing every
stage, not read the fader alone:

```
effective_dB = fader_dB + utility_dB + sampler_dB + group_dB
```

Units differ per stage and must not be confused (this is where the probe first
went wrong — see below):

| Stage | XML | Units | Unity |
|---|---|---|---|
| Mixer / group volume | `Mixer.Volume.Manual` | linear amplitude | 1.0 |
| Utility | `StereoGain.Gain.Manual` | linear amplitude (max 56.23 = +35 dB) | 1.0 |
| Simpler | `OriginalSimpler.VolumeAndPan.Volume.Manual` | **decibels** (range −36…+36) | 0.0 |

Cost to implement: about forty lines. Already prototyped in the probe.

### Correction to the record

An earlier message reported the Adriatique gain map as "kick −5.5, snares
−3.0/−1.1, clap −8.2, shakers −15 to −27 dB". Those were **fader-only** values.
The effective levels are roughly 12 dB lower across the board. Because that
particular offset is uniform, the relative picture stands, but the absolute
figures were wrong and should not be reused.

A first pass of this probe also reported "Simpler −120 dB" on kicks and snares.
That was a unit bug — the Simpler volume is already in decibels and was being
run through a linear-to-dB conversion. It was caught because a −120 dB kick in
a working mix is not credible. Noted here because the same class of error would
be invisible in any number that happens to look plausible.

### Still open from the same review

The **@15drtt jerk figure of ~6.6 dB** (FL) was measured from mixer insert
volumes only, ignoring FL channel volume and any plugin gain. It is subject to
exactly the same objection and should not be quoted against our preflight's
~19 dB until `service/flp/flp_cli.py` reads the other stages. Treat that
comparison as unproven for now.
