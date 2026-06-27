# Golden-audio baselines

`manifest.json` is the committed regression baseline for Mosh's offline renders. `--selftest`
proves commands dispatch; the golden gate proves the **samples are right** — the thing a DAW
whose reason to exist is audio transformation cannot get wrong.

## What's in here

For each bit-deterministic offline render, the manifest stores:

- **`pcm_sha256`** — SHA-256 of the decoded PCM **frames only** (NOT the whole file). JUCE's
  WAV writer emits a non-deterministic header (`bext`/timestamp chunk, ~784 bytes that vary
  run-to-run); the audio samples are deterministic, so the frames are the honest fingerprint.
- **`features`** — `{frames, peak, rms, centroid_hz}`. Purely diagnostic: on a checksum miss
  the gate prints which feature moved and by how much, so a real regression (centroid shifts
  200 Hz) is distinguishable from benign noise.

Only bit-deterministic paths are checksum-gated: `makes_sound`, `drums`, `transform_fake`
(the stdlib fake adapter), `full_loop`. The non-deterministic synth-bounce (`midi_render`)
and the model paths (real SA3 / real RAVE) are **never** checksummed — they keep the
perceptual RMS/diff bounds in their own checks. WAVs are gitignored; we commit checksums +
features, never audio.

## Running the gate

```sh
python3 scripts/verify-hardware/verify.py --bin <Mosh> --gate
```

This is wired into the pre-merge gate (`scripts/auto-loop/gate.sh`): a checksum miss reds the
merge. Without `--gate`, `verify.py` keeps its prior bounds-only behavior.

## Regenerating (intentional change only)

When you intentionally change a DSP path or the fake adapter, the checksums move and the gate
goes red **on purpose**. Regenerate, eyeball the diff (especially the feature deltas — they
should match your intent), and commit:

```sh
python3 scripts/verify-hardware/verify.py --bin <Mosh> --update-golden
git diff scripts/verify-hardware/golden/manifest.json
```

Regenerate on the **canonical macOS arm64 build** (the prime-directive reference platform).
Exact checksums hold there because the render config is pinned (sample rate, block size,
bit depth, no wall-clock/Random in the DSP path). A future Windows/CUDA gate should fall back
to feature-bounds rather than red on cross-platform float noise.
