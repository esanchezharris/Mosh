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
| 3 | Tier-A neural A/B | the same source rendered with the neural insert active differs measurably from the dry render |
| 5 | Full producer loop | a multi-track + neural + mix chain exports non-silent at the expected length |
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

## How `--run-script` works

`Mosh --run-script` reads JSONL from `MOSH_RUN_SCRIPT` (results to stdout and
`MOSH_RUN_SCRIPT_OUT`). Each line is `{"command","args"}`. A command may
`"capture":{"VAR":"dataField"}` a field of its result, and later args reference it
as `"${VAR}"` — so engine-assigned ids (trackId/clipId/index) never need
hard-coding. `{"command":"__wait","args":{"ms":N}}` pumps the message loop for
async work. `render_layer` with `"wait":true` blocks until the render finishes.
