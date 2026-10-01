# Native AutoTune — scope, design and behavioural spec (2026-10-01)

Owner request, 2026-10-01: build a real native autotune. This document is the design
record and the behavioural spec the engine is implemented from. It supersedes the
"vocal tuning is an OPEN problem" note in
[MOSHPIT_PARTS_AND_ROADMAP.md](MOSHPIT_PARTS_AND_ROADMAP.md) once the owner accepts the
result.

## 1. What existed

| Piece | Verdict |
|---|---|
| `moshAutoTune` plugin shell (registration, catalog, `load_builtin`, params, telemetry, Moshi routing, selftest rows) | Kept. No new command and no wire change. |
| Its DSP core, `AutoTuneCore` in `src/plugins/moshfx/MoshAutoTuneDsp.cpp` | Replaced. It synthesized a sine over the voice; there was no pitch shifter. |
| Moshpit M009 streaming YIN tracker and correction logic (owner's own code) | Ported, with the changes listed in §5 and §6. |
| Moshpit M009 TD-PSOLA shifter | Not ported. Every scripted gate was green and the owner rejected it by ear twice. |
| Moshpit M006 Signalsmith spike | Not used. 133 ms latency rules it out for live monitoring. |

The lesson carried over from M009: its gate suite did not measure what made it sound bad.
Here the owner's ear decides at each gate and the automated tests are regression checks,
not quality evidence.

## 2. Owner decisions

- Must work live (monitoring while recording) and on recorded vocals in the mix.
- One retune knob from hard tune to natural correction.
- **Ear gate 1 (passed 2026-10-01).** The owner listened to their own takes, the Song A
  lead and six untuned vocadito excerpts rendered through an open-source reference retuner:
  - hard tune: approved;
  - natural correction: glide preferred over snap, **with a slider between the two**;
  - no audible difference between the reference's 22 ms and 3 ms modes, so Mosh's engine
    is low-latency only.

## 3. Provenance

- The technique is the classic one for vocal retuning: resample the input at the correction
  ratio and, when the read position drifts too far from the write position, jump by a whole
  pitch period with a crossfade. It is described in H. Hildebrand's US patent 5,973,252
  (filed 1998, expired) and in the public user documentation of several tuners.
- An open-source GPL retuner (zita-at1 as maintained in x42/fat1.lv2) was built **outside
  the repository** as a listening reference only. None of its code is in this tree, and
  none may be added: [DEPENDENCY_BOM.md](DEPENDENCY_BOM.md) §2 rules out a GPL app.
- The design in §4–§7 is Mosh's own. It differs structurally from the reference (per-sample
  decisions rather than fixed fragments, a native-rate windowed-sinc interpolator rather
  than 2x upsampling with a cubic, a correlation-refined splice, a one-sided delay window,
  a YIN tracker rather than FFT autocorrelation).
- The splice shifter is implemented by a fresh agent that is given this document only and
  never sees the reference source. This is an independent reimplementation, not a formal
  two-team clean room.

## 4. Architecture

All engine code is JUCE-free and lives in `src/plugins/moshfx/retune/`.

```
mono in ──┬─► PitchTracker ─► TuneCorrection ─► (period, ratio) ─┐
          │                                                       ▼
          ├─► SpliceShifter ───────────────────────────────────► wet ─┐
          └─► dry delay (latency-matched) ──────────────────────► dry ─┴─► mix, gain ─► out
```

| Unit | Job |
|---|---|
| `PitchTracker.h` | Streaming monophonic f0 and voicing, one estimate per hop. |
| `TuneCorrection.h` | Target note, snap/glide behaviour, retune smoothing, amount, range. |
| `SpliceShifter.h` | Applies a time-varying pitch ratio to the audio. |
| `RetuneCore.h/.cpp` | Composes the three, maps plugin params, dry/wet, readout. |

Control is applied at the tracker's hop boundaries, which are anchored to the absolute
sample count, so any chunking of the same input produces identical output.

## 5. PitchTracker (ported from Moshpit `TunePitchTracker.h`)

YIN (difference function, cumulative-mean normalisation, absolute threshold 0.15, parabolic
refinement), 70–800 Hz, a fixed integration span of about 21 ms, hop of one eighth of the
window, RMS gate at −50 dBFS, voicing hysteresis of three hops, rejection of jumps over
600 cents unless they persist for three hops, and a flush of the median ring when such a
jump is accepted (the octave-latch fix).

Changes from the Moshpit original, all to cut detection lag for the low-latency design:

- **End-anchored integration.** The fixed comparison segment is the most recent span of
  samples and the lagged segment slides back in time. The original anchored at the start
  of the window, which made every estimate about 9 ms older.
- **No median filter** (the original used 5 taps). On the 40 vocadito excerpts, removing
  it raised pitch accuracy from 93.4% (5 taps) and 95.9% (3 taps) to 97.4% within 50
  cents, with octave errors unchanged: on real voices it only added lag. The jump guard
  still rejects octave blips.
- A `clarity` value (1 − the normalised difference at the chosen lag) is reported for the
  UI confidence readout.
- No JUCE dependency.

One further change stops notes dropping out. Measured on the 40 vocadito excerpts against
their hand-annotated pitch, the tracker as ported lost the note for under 60 ms about 42
times a minute. **Continuity rescue:** inside a voiced run, when no lag passes the strict
threshold, the tracker looks only within ±4 semitones of the held pitch and accepts a
looser threshold (0.35) there. That cut the short dropouts to 15 a minute and raised
voicing recall from 93.9% to 95.9%, with pitch accuracy (95.9% within 50 cents) and octave
errors (1.45%) unchanged. Applying the looser threshold across the whole band instead
tripled the octave errors.

## 6. TuneCorrection (ported from Moshpit `TuneCorrection.h`)

Per voiced hop:

1. Convert f0 to cents. Find the nearest allowed note (chromatic, major or minor from the
   root). Switch to a new note only once the pitch is past the midpoint by half of a
   60-cent deadband (anti-warble hysteresis).
2. `requested = clamp(target − pitch, ±range) × amount`.
3. **Glide (new).** On the hop where the target note changes, or on the first voiced hop
   after a gap of 60 ms or more, the smoothed correction first jumps a fraction
   `1 − glide` of the way to `requested`. `glide = 0` snaps onto each new note;
   `glide = 1` eases in at the retune speed.
4. Retune smoothing: `smoothed += (requested − smoothed) × (1 − exp(−hop / retune))`.
   A retune time at the bottom of the knob (5 ms or less) means hard tune.
5. `ratio = 2^(smoothed / 1200)`.

Unvoiced hops hold the last state, so a short dip inside a note resumes smoothly. After a
gap of 60 ms or more the held note and smoothed correction are cleared, so a new phrase
does not start with the previous phrase's correction.

**Hold through dropouts.** While a hop is unvoiced but inside that 60 ms window,
`RetuneCore` keeps the shifter voiced at the last period and the held ratio. Releasing
straight away would let the pitch blip back to uncorrected and force a recentre crossfade
in the middle of the note. Only after the window does the shifter go unvoiced.

## 7. SpliceShifter — behavioural spec

### Interface

```cpp
namespace mosh::moshfx::retune
{
class SpliceShifter
{
public:
    void prepare (double sampleRate);   // allocates; never called on the audio thread
    void reset();                       // clears state, no allocation
    int latencySamples() const;         // constant after prepare()

    // Takes effect from the next processed sample.
    // periodSamples <= 0 means "unvoiced". ratio > 1 raises the pitch.
    void setTarget (double periodSamples, double ratio);

    // in and out may be the same buffer. No allocation, locks, logging or IO.
    void process (const float* in, float* out, int numSamples);
};
}
```

Header-only, C++17, standard library only. All state advances per sample, so splitting the
same input and the same `setTarget` calls (at the same sample positions) into different
block sizes must give bit-identical output.

### Signal model

- Input samples are written to a ring buffer. A read head sits a fractional delay `d`
  (in samples) behind the newest written sample; the output sample is the ring
  interpolated at that position.
- Each sample, `d += 1 − r`, where `r` is the current ratio. With `r > 1` the read head
  gains on the write head and the pitch rises.
- `r` follows the target ratio through a one-pole smoother with a 2 ms time constant, and
  is set to exactly the target once within 1e-5 of it (0.017 cent). The target is clamped
  to `[2^(−4/12), 2^(4/12)]`. (A tighter snap of 1e-7 took about 30 ms to settle from the
  largest ratio and broke property 8.)

### Interpolator

A 16-tap Kaiser-windowed sinc (β ≈ 8, full-band cutoff) with 256 fractional phases and
linear interpolation between neighbouring phases; each phase is normalised to unity DC
gain. At a fractional offset of exactly zero the kernel must be exactly a unit impulse, so
an integer delay reproduces the input bit-for-bit. The table is built in `prepare()`.

### Reported latency `D`

`D = 8 + 1 + ceil(0.006 × fs × (2^(4/12) − 1)) + 4` samples (88 at 48 kHz, about 1.8 ms):
half the interpolator, plus the furthest the old read head can advance toward the write
head during the longest crossfade at the largest ratio, plus a small margin. `d` never
goes below the interpolator's reach.

### Unvoiced behaviour

- The target ratio is forced to 1.
- Once `r` has settled at exactly 1 and no splice is in progress, if `d ≠ D` the shifter
  recentres: it starts a second read head at exactly `d = D` and crossfades to it over
  4 ms.
- After that, output is the input delayed by exactly `D` samples, bit-for-bit.
- The initial state after `prepare()` or `reset()` is unvoiced with `d = D`, `r = 1`.

### Voiced behaviour

With period `P` (samples), `d` is kept inside the one-sided window `[D, D + 1.5 P]`:

- `d < D`: splice **back** by one period (new head at `d + P*`, older audio).
- `d > D + 1.5 P`: splice **forward** by one period (new head at `d − P*`, newer audio).
- No new splice starts while one is in progress.

`P` is accepted only inside `[fs/1200, fs/55]`; anything else is treated as unvoiced.

### The splice

- **Refined period `P*`.** The tracker's period is several milliseconds stale, so the
  jump length is refined against the audio itself. Let `N = clamp(round(P), 0.002 fs,
  0.010 fs)`. Compare the `N` input samples the read head has just passed over with the
  `N` samples one candidate lag away (older for a back splice, newer for a forward
  splice), for integer lags `L` in `[0.9 P, 1.1 P]`, using normalised cross-correlation.
  Take the best lag, refine it with a parabolic fit over its two neighbours, and use it
  as `P*`. If the best correlation is below 0.5, use `P` unrefined.
  At sample rates above 48 kHz the search may stride both the lag scan and the sums by
  `round(fs / 48000)`, then refine around the best lag at stride 1.
- **Crossfade.** Length `X = clamp(round(P), 0.002 fs, 0.006 fs)` samples. Both heads
  advance at the current `r`. Output is `(1 − g) × old + g × new` with
  `g = 0.5 × (1 − cos(π k / X))` for `k = 0 … X − 1` (equal-gain raised cosine, correct
  for two copies of the same waveform one period apart). When it ends, the new head
  becomes the read head.

### Ring size

A power of two holding at least `D + 2.6 × (fs/55) + 0.010 fs + 32` samples.

### Required properties (each has a test)

1. **Identity.** With unvoiced input control, output equals input delayed by
   `latencySamples()`, bit-for-bit, at 44.1, 48 and 96 kHz.
2. **Ratio-1 voiced identity.** With a voiced period and ratio exactly 1 from the start,
   output equals input delayed by `latencySamples()`, bit-for-bit.
3. **Pitch.** A harmonic tone with period `P` and ratio `r` comes out at `r ×` its
   frequency within 3 cents, for `r` equal to ±35, ±100 and ±200 cents, at 110, 220 and
   440 Hz.
4. **Timbre.** This engine moves the formants with the pitch, so harmonic amplitudes are
   preserved by harmonic number: each of the first eight harmonics of that tone stays
   within 1.5 dB of its input level. (The sine core this replaces had no harmonics at
   all.)
5. **No clicks.** On that tone, the 1 ms RMS envelope of the output stays within 1.5 dB,
   in level and in step, of the same harmonic tone synthesised at the output pitch,
   splices included. (Comparing against the input at its own pitch is wrong: a tone's
   natural 1 ms envelope ripple depends on its pitch.)
6. **Chunking.** Output is bit-identical for block sizes {1, 64, 128, 137, 512, 4096}.
7. **Bounded delay.** While voiced, `d` stays within `[reach, D + 2.6 P]`; no read ever
   leaves the ring.
8. **Transitions.** Voiced → unvoiced returns to exact `D`-delayed identity within 30 ms;
   output is always finite.
9. **In place.** `process` gives the same output when `in` and `out` are the same buffer.

## 8. Plugin parameters

Unchanged ids, order and ranges for the first seven; one appended.

| # | Param | Range | Maps to |
|---|---|---|---|
| 0 | Root | 0–11 | scale root |
| 1 | Scale | 0–2 | chromatic, major, minor |
| 2 | Retune | 5–250 ms | retune time; 5 ms = hard tune |
| 3 | Amount | 0–1 | correction strength (default changes 0.35 → 1.0) |
| 4 | Range | 0–300 cents | cap on the correction |
| 5 | Mix | 0–1 | dry/wet; dry is delayed by `D` |
| 6 | Output | −18…+6 dB | output gain |
| 7 | **Glide** (new) | 0–1 | 0 snaps onto each new note, 1 eases in (default 1) |

Reported latency is `D` (about 1.8 ms). Voiced audio is additionally delayed by between
zero and one and a half pitch periods as the read head moves, which is inherent to the
technique; a Mix below 1 on voiced audio therefore combs.

## 9. Not in v1

Formant control, key detection, MIDI target notes, more scales, a reference-pitch (detune)
control, a pitch-graph UI, following the project key, any GPL code, any Tracktion patch.

## 10. Acceptance

Automated tests prove the properties in §7 and the wiring. They do not prove it sounds
good. That is ear gate 2 (Mosh's engine against the reference and dry, same takes, same
settings) and the in-app checks in Phase 3: singing through it live, a recorded take
landing aligned, and the Song A lead.
