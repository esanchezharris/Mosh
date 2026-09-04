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

---

## S1/S2 — the extractor, and what four projects actually say

`service/references/extract_als.py` (+ `roles.py`, + `extract_als_test.py`, 19
assertions) now reads per-track effective level, low-cut, device chain, note
statistics and master chain out of an `.als`. Run on the four projects on disk.

**It never runs at produce time.** Its only legitimate consumer is a profile a
human signed off on after listening; wiring it into the preflight would make a
proxy metric gate a musical decision, which the postmortem contract forbids.

### The measurements

| Project | Tracks | Role coverage | Low-cut | *Shaping* low-cut | Shaping Hz | Drum bus | Melodic bus | Offset |
|---|---|---|---|---|---|---|---|---|
| Adriatique — Back To Life | 46 | 83% | 11% | 11% | 75–864 | −7.6 | +4.0 | **+11.6** |
| Adriatique — Never Alone | 23 | 70% | 65% | 44% | 64–167 | −5.8 | +2.2 | **+8.0** |
| STMPD — By Myself | 109 | 30% | 33% | 25% | 94–163 | +9.8 | +5.9 | **−3.8** |
| Gravitas — Catalyst | 32 | 56% | 47% | 38% | 61–114 | +4.2 | +2.4 | **−1.8** |

Master chains: **empty, empty, `Limiter → StereoGain → Eq8 → MultibandDynamics →
Eq8 → Eq8 → GlueCompressor → StereoGain`, `Limiter`.**

"Shaping" excludes low-cuts below 60 Hz. That split is not cosmetic: STMPD
carries a 30 Hz low-cut **eight times** — EQ Eight's default, left enabled — plus
one at 10 Hz, the device minimum. Counting those as "this producer highpasses"
would have been false. Every band is still recorded; only the summary splits.

### Against the pre-registered kill criteria

- **Role coverage — FAILS.** Bar was "under 60% on two or more projects".
  Result: 30% and 56%. Per-role aggregation is not reliable here, and STMPD's
  buses in particular are computed from under a third of its tracks.
- **Drum-to-melodic offset — FAILS decisively.** Bar was "spread over 6 dB".
  Result: **15.4 dB**, and the *sign flips* — melodic sits above the drums in
  both Adriatique projects and below in the other two. This is not a noisy
  constant; it is not a constant.
- **Low-cut incidence — survives, weakly.** 11% / 44% / 25% / 38%: a four-fold
  spread, so not a transferable number, but consistently a **minority** of
  tracks in every project.

**Verdict: per-genre median mix numbers do not transfer.** Two of three
quantitative criteria fail outright. Stated plainly rather than rescued.

### What does hold, and it contradicts our preflight

1. **Low-cut is always applied to a minority of tracks** (11–44%), never to
   everything in a category. Our preflight puts one on **all seven** melodic
   tracks, unconditionally.
2. **The frequencies sit lower than ours.** Shaping cuts cluster **60–170 Hz**;
   ours is a flat **180 Hz**.
3. **There is no universal master chain.** Two of four projects have an *empty*
   master; one has a lone limiter; one has eight devices. Our fixed
   softclip → God Particle has no support here.

### Correction to an earlier claim in this session

I previously reported, from the Adriatique remake alone, that the references
"highpass drums, not melodic parts, while we do the opposite". **Four projects do
not support that.** Shaping low-cuts land on kick, clap, snare, perc, cymbal and
shaker *and* on arp, pad, stab, chords and lead. Kick and clap appear in three of
four projects — the most consistent single fact here — but melodic parts are cut
too. The n=1 reading was wrong.

### Limits, stated rather than buried

- n=4 across three genres, and **two share a genre, a pack and an author**, so
  they are correlated. This validates the mechanism; it is not a coherence
  verdict.
- **All four are remakes, demos or teaching projects**, not original release
  sessions. A remake is evidence about one practitioner's reconstruction.
- Role coverage under 60% on two projects means their per-role figures carry
  real measurement error, independent of whether the underlying quantity
  transfers.

### What this implies for the next step

Wiring a `mixProfile` of measured *constants* into the preflight is not
justified: the constants are not there. The findings that survived are
**structural, not numeric** — how many tracks get a low-cut, and roughly where —
and the honest way to act on them is to put a candidate change in front of the
owner's ear, not to encode a median nobody can defend.
