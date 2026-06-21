# Mosh — Hardware Verification Runbook

*Closing the gap between "passes `--selftest` plumbing" and "**actually** produces correct audio /
responds to a mic / syncs between two peers."*

Most of Mosh is proven by the deterministic command-surface harness (`Mosh --selftest`, ~784
checks) plus the UI suites (vitest + Playwright). Those prove the *plumbing*. This runbook proves
the parts that only real hardware (or real audio rendering) can confirm.

**Primary proof vehicle = offline render-to-WAV.** Rather than live-listening or BlackHole
loopback, we bounce the real signal chain to a file (`export_audio` / `bounce_layer_to_clip`, plus the
render-layer job artifacts) and assert on the WAV's contents programmatically
(non-silent? expected level? did the Tier-B transform / SA3 actually change the audio vs its input?).
This is deterministic, headless, and needs no one present — you can audition the saved WAVs later.
Only a few checks are inherently live (mic/voice, two-window multiplayer sync).

## Prerequisites

| Need | For | Present on this machine |
| --- | --- | --- |
| Release `/Applications/Mosh.app` built from current `main` | everything | rebuild via `./run-mosh.sh deploy` |
| `service/.sa3.env` wired (`service/setup-sa3.sh`) | SA3 transform check | model present at `~/AI/stable-audio-3/optimized/mlx`; run setup to wire |
| `numpy` | WAV analysis | numpy 2.4.4 ✓ |
| Microphone + Privacy→Microphone grant | voice, recording | owner-provided, live |
| `ui/.env.local` brain key | full STT→LLM→command loop | **not used this pass — voice tested against the mock brain** |

## The harness

`scripts/verify-hardware/` (a driver that runs `Mosh --run-script` headlessly to render
evidence WAVs into `verify-artifacts/`, plus a numpy/`wave` analyzer that asserts each WAV and
prints a pass/fail report — see [`scripts/verify-hardware/README.md`](../scripts/verify-hardware/README.md)):

```bash
python3 scripts/verify-hardware/verify.py          # offline checks (1,2,3,5) — self-driven, deterministic
python3 scripts/verify-hardware/verify.py --sa3     # also the real SA3 transform (needs service/setup-sa3.sh)
# live checks (6,7,8 — owner-driven) are listed per-row below.
```

## Checks

Results below from the 2026-06-20 pass (offline checks are deterministic — WAV checksums stable
across runs).

| # | Check | Kind | Asserts | Status |
| --- | --- | --- | --- | --- |
| 1 | Makes sound | offline | non-silent, right duration/level | ✅ 2.0s stereo, peak 0.18, RMS 0.12 |
| 2 | Drums audible | offline | non-silent (silent-drums regression guard) | ✅ 4.0s, peak 0.91, RMS 0.088 |
| 3 | Transform render (fake) | offline | Tier-B `transform` (fake adapter) renders non-silent, differs from input | ✅ `adapter/mode: transform`, **diff-from-input RMS 0.270**, RMS 0.45 |
| 4 | SA3 transform | offline (`--sa3`) | real model renders, quality readout present, differs from input | ✅ `adapter: stable_audio3`, **`pq 6.933`**, non-silent |
| 5 | Full producer loop | offline | multi-track + mix exports non-silent | ✅ 2.0s, peak 0.34, RMS 0.18 |
| 6 | Realtime output path | live | device opens; audio frames flow | ✅ `--live-audio-smoke` **14/14** (MacBook Pro Speakers, CoreAudio 48k) — by-ear out-loud confirm still owner-side |
| 7 | Voice (mock brain) | live | STT transcribes; earcons fire | ⏳ owner: grant mic, hold-to-talk + 👂 hands-free + barge-in (`MOSH_VOICE_BARGE_IN=1`) |
| 8 | Multiplayer (2-process) | live | protocol green; track-lock + clip-move sync | ✅ `relay/run-mp-selftest.sh` **911/911** — two-window *visual* sync still owner-side |
| 9 | Sketch (beatbox→drums) | gated | recognizable kick/snare/hat land in a real editable clip; tempo set; byte-identical across runs | ✅ `MOSH_SELFTEST_SKETCH=1` **16/16** on the committed fixtures (boom-bap 90 + trap 140), determinism asserted; CLI stdout byte-identical across runs |

**Sketch gated selftest** (needs `service/sketch/setup-sketch.sh` first):

```bash
MOSH_SELFTEST_SKETCH=1 MOSH_SKETCH_FIXTURE_DIR="$PWD/service/sketch/fixtures" \
  build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest   # run from the repo root
```

The default `Mosh --selftest` (no env) stays **893/893** whether or not the librosa venv is present
(graceful degradation). Remaining hands-on for Sketch: the by-ear "does it groove" confirm and a
real beatbox-from-your-mouth take (the fixtures are synthesised, not recorded) — owner-side.

Evidence WAVs + the analyzer `report.json` land in `verify-artifacts/` (git-ignored). The
`--run-script` runner and the harness live in PR #80; this runbook in #78.

## Re-running

The offline checks (1–5) are deterministic — re-run `python3 scripts/verify-hardware/verify.py`
(add `--sa3`) any time a change could affect the signal chain, as a render-level regression guard
on top of `--selftest`.
