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
(git-ignored). The live, hands-on checks (realtime output, mic recording, two-process
multiplayer) are listed in [`docs/VERIFICATION.md`](../../docs/VERIFICATION.md).

## How `--run-script` works

`Mosh --run-script` reads JSONL from `MOSH_RUN_SCRIPT` (results to stdout and
`MOSH_RUN_SCRIPT_OUT`). Each line is `{"command","args"}`. A command may
`"capture":{"VAR":"dataField"}` a field of its result, and later args reference it
as `"${VAR}"` — so engine-assigned ids (trackId/clipId/index) never need
hard-coding. `{"command":"__wait","args":{"ms":N}}` pumps the message loop for
async work. `render_layer` with `"wait":true` blocks until the render finishes.

To assert on async work, prefer
`{"command":"__wait_until","args":{"condition":C,"maxMs":N}}` over a fixed `__wait`.
It pumps the same loop, stops as soon as the condition holds and emits a result line
(`ok`, `data.waitedMs`). If the condition is not met by `maxMs` (default 30000) it
counts as a failure, never a silent pass. A fixed `__wait` bets a number against
machine load: `verify-direct-reimagine.py`'s overlap check read `rendering` in 12 of 12
runs while three sibling builds were running. The conditions are:
`direct_render_idle` (no Direct Re-Imagine request or worker in flight, no layer
queued/rendering), `render_job_submitted` (`clipId`'s layer shows a service jobId), and
`file_exists` (`file`, relative to the script's directory).
