# Mosh — Hardware Verification Runbook

*Closing the gap between "passes `--selftest` plumbing" and "**actually** produces correct audio /
responds to a mic / syncs between two peers."*

Most of Mosh is proven by the deterministic command-surface harness (`Mosh --selftest`, ~784
checks) plus the UI suites (vitest + Playwright). Those prove the *plumbing*. This runbook proves
the parts that only real hardware (or real audio rendering) can confirm.

**Primary proof vehicle = offline render-to-WAV.** Rather than live-listening or BlackHole
loopback, we bounce the real signal chain to a file (`export_audio` / `bounce_layer_to_clip`, and
`--neural-ab`'s `MOSH_NEURAL_AB_WAV` dump) and assert on the WAV's contents programmatically
(non-silent? expected level? does neural-ON differ from neural-OFF? did SA3 actually transform it?).
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

`scripts/verify-hardware/` (built in the verification pass):
- a driver that runs the binary headlessly to render evidence WAVs into `verify-artifacts/`, and
- a numpy/`wave` analyzer that asserts each WAV's properties and prints a pass/fail report.

```bash
# offline render-to-WAV checks (self-driven, deterministic):
scripts/verify-hardware/run.sh                 # renders + analyzes; writes verify-artifacts/
# live checks (owner-driven) are listed per-row below.
```

## Checks

| # | Check | Kind | How | Asserts | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Makes sound | offline | test-tone project → `export_audio` | non-silent, right duration/peak | ⏳ pending |
| 2 | Drums audible | offline | drum track + pattern → render | non-silent (guards the silent-drums regression) | ⏳ pending |
| 3 | Tier-A neural A/B | offline | same source, insert bypassed vs active → 2 WAVs | active differs from source > threshold; bypass ≈ passthrough | ⏳ pending |
| 4 | SA3 transform | offline | `render_layer` (grit) → accept → bounce | output differs from source; quality readout (`pq`) present | ⏳ pending |
| 5 | Full producer loop | offline | arrange + VST3 + neural + SA3 + mix → `export_audio` | non-silent, expected length | ⏳ pending |
| 6 | Realtime output path | live | `--live-audio-smoke` + one GUI double-click | device opens, non-silent capture; transport plays out loud | ⏳ pending |
| 7 | Voice (mock brain) | live | GUI: grant mic, hold-to-talk + 👂 hands-free + barge-in (`MOSH_VOICE_BARGE_IN=1`) | STT transcribes; earcons fire | ⏳ pending |
| 8 | Multiplayer (2-process) | live | `relay/run-mp-selftest.sh` + two GUIs on the local relay | automated protocol green; track-lock + clip-move sync visible | ⏳ pending |

Evidence WAVs and the analyzer report land in `verify-artifacts/` (git-ignored); a summary of
results is recorded here and reconciled against the "honest gap" notes in `CLAUDE.md` as each row
closes.

## Re-running

The offline checks (1–5) are deterministic — re-run `scripts/verify-hardware/run.sh` any time
(e.g. after a change that could affect the signal chain) as a render-level regression guard on top
of `--selftest`.
