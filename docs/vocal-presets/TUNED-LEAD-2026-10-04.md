# Mosh Tuned Lead v0 — a vocal chain preset that includes AutoTune (2026-10-04)

Owner request, 2026-10-04: a default vocal preset, meaning a sequence of plugins with
settings, that includes the new AutoTune. This is the starting point for the owner's
listening pass. **It has not been listened to and is not a voiced result.**

## What it is

`resources/presets/track-chain/mosh-tuned-lead-v0.json`, id `mosh.tuned-lead`. One pick
from the Mix Inspector's "Vocal preset…" applies all three stages as one undo step.

| # | Stage | Values |
|---|---|---|
| 1 | Mosh AutoTune | chromatic, retune 40 ms, amount 100 %, range 100 cents, mix 100 %, output 0 dB, glide 100 %, look-ahead 0 ms |
| 2 | High-pass | 80 Hz |
| 3 | Compressor | threshold −24 dB, ratio 2.5:1, attack 20 ms, release 150 ms, no makeup |

Why these:

- **AutoTune first**, so the pitch tracker hears the voice before the compressor shapes it.
- **Chromatic**, because a preset cannot know the song's key. Set Root and Scale per song.
- **Look-ahead 0**, so the chain is safe to sing through (about 1.8 ms). Raise it in the
  mix for tighter tuning (see [AUTOTUNE-SCOPE-2026-10-01.md](../AUTOTUNE-SCOPE-2026-10-01.md) §8).
- **Stages 2 and 3 are Mosh Clean Lead v0 unchanged.** A unit test fails if they drift apart.

## What changed to allow it

The preset format (`src/moshops/TrackPreset.h`) now pins a third processor, `moshAutoTune`,
with all nine of its parameters. Two encodings were added for it:

- `%` values are stored as a 0–1 fraction (amount, mix, glide);
- root and scale are choices, so a fractional value is an error rather than being rounded.

Root counts semitones above C (0 = C … 11 = B). Scale is 0 chromatic, 1 major, 2 minor.

## Verified

- Unit tests (`tests/test_track_preset.cpp`, `[autotune]`): the stage parses, units and
  ranges are enforced, and the bundled file is AutoTune ahead of the Clean Lead chain.
- Selftest (`src/app/selftest/TunedLeadPresetSelfTest.cpp`): the pinned row matches the
  linked plugin (ids, ranges, saved properties, state-first creation with no undo
  actions); the preset applies in order, reads back in its own units, is one undo step and
  does not duplicate on re-apply.

Not verified: how it sounds. Unlike Clean Lead, this chain reports latency, because
AutoTune does.

## Next

The owner tweaks all three stages in the app on real vocals. The values they settle on
replace the table above (as revision 1), and `validation.listening` changes only then.
