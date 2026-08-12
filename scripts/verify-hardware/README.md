# verify-hardware

Offline render-to-WAV verification for Mosh. Proves the audio chain *actually
produces correct audio* — not just that commands return `ok` — by bouncing the
real signal chain to WAV files and asserting on their contents with numpy.

It drives the headless `Mosh --run-script` mode: each scenario is a JSONL command
script (replayed through the one mutation path, `MoshOps::execute`) that ends with
an `export_audio`; the harness then analyses the rendered WAV. Deterministic,
headless, no audio device and no one present — audition the saved WAVs later.

## Run

```bash
python3 scripts/verify-hardware/verify.py            # offline checks (1,2,3,5) — fast
python3 scripts/verify-hardware/verify.py --sa3      # also the real SA3 generative transform (needs the wired service)
python3 scripts/verify-hardware/verify.py --bin /Applications/Mosh.app/Contents/MacOS/Mosh
```

Requires `numpy`. The binary defaults to the newest local build (Debug, then
Release, then `/Applications/Mosh.app`). For `--sa3`, wire the model first with
`service/setup-sa3.sh`.

## Checks

| # | Check | Asserts |
| --- | --- | --- |
| 1 | Makes sound | a test-tone export is non-silent, right duration/level |
| 2 | Drums audible | a drum-track MIDI pattern renders non-silent (the silent-drums regression guard) |
| 3 | Transform render (fake) | a Tier-B `transform` render (fake adapter, offline) produces non-silent audio that differs from its input (`mode: transform`) |
| 5 | Full producer loop | a multi-track + mix chain exports non-silent at the expected length |
| 4 | SA3 generative transform | a real `stable_audio3` re-imagine renders (`status: ready`), carries a quality readout (`pq`), differs from its input, and exports as audible audio |

Artifacts (WAVs + `report.json`) land in `verify-artifacts/` at the repo root
(git-ignored). The live, hands-on checks (realtime output, mic/voice, two-process
multiplayer) are listed in [`docs/VERIFICATION.md`](../../docs/VERIFICATION.md).

## Voice (speech-to-text)

`Mosh --voice-smoke` synthesizes a known phrase with macOS `say`, transcribes it
through the same `SFSpeechRecognizer` the app uses, and asserts the words — proving
STT with nobody speaking.

- **FILE mode** (default): reads a `say`-rendered file. No mic, no BlackHole — needs
  only a one-time **Speech Recognition** grant.
- **MIC / loopback mode**: `scripts/verify-hardware/voice-loopback.sh` routes the
  default input + output to **BlackHole 2ch** and runs `--voice-smoke` in MIC mode, so
  `say` plays digitally into the mic the recognizer reads (reliable, no room noise).
  Needs **Speech + Microphone** grants.

The grant is the one manual step: a headless run can't raise the macOS permission
prompt, so `--voice-smoke` checks the auth status and **skips cleanly (exit 2) with
guidance** until it's granted. Grant once via the GUI (launch the app, use voice), then
`--voice-smoke` passes and is a repeatable regression guard like `--live-audio-smoke`.
Tune with `MOSH_VOICE_SMOKE_PHRASE` / `MOSH_VOICE_SMOKE_TIMEOUT_MS`.

## Voice-to-MIDI (transcribe_clip)

`python3 scripts/verify-hardware/voice_to_midi_check.py` proves `transcribe_clip`'s
`mono` mode against synthesized-but-ground-truth-known vocal-like audio: a clean
stepwise melody, a legato glide with no silence or attack between notes, a single
sustained note with singing vibrato, and rhythmically loose (non-metronomic) timing.
Needs no Mosh binary — it drives `service/transcribe/transcribe_cli.py` directly, the
same subprocess `/transcribe` invokes. Skips cleanly if the transcribe venv isn't
installed (`service/transcribe/setup-transcribe.sh`).

This exists because the only prior coverage (`--selftest`, gated on
`MOSH_SELFTEST_TRANSCRIBE`) fed it one flat test tone and only checked "≥1 note" — it
couldn't have caught a real segmentation bug, and didn't: ordinary vibrato fragmented
a single sustained note into 11 spurious same-pitch notes. Fixed in
`transcribe_cli.py` (`_merge_vibrato_fragments`); this script is the regression lock.

## How `--run-script` works

`Mosh --run-script` reads JSONL from `MOSH_RUN_SCRIPT` (results to stdout and
`MOSH_RUN_SCRIPT_OUT`). Each line is `{"command","args"}`. A command may
`"capture":{"VAR":"dataField"}` a field of its result, and later args reference it
as `"${VAR}"` — so engine-assigned ids (trackId/clipId/index) never need
hard-coding. `{"command":"__wait","args":{"ms":N}}` pumps the message loop for
async work. `render_layer` with `"wait":true` blocks until the render finishes.
