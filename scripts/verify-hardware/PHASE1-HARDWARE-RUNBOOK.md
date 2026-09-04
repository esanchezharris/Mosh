# Phase 1 — Hardware verification runbook (DAW-parity)

The conformance harness (`scripts/daw-conformance/conformance.py`) proves everything that is
provable **headless**. A handful of conventional-DAW behaviors can only be confirmed on a
**live audio device / mic / MIDI** — they degrade to a graceful no-op (`applied:false`) or a
`-100 dB` meter when no device is present, so a green headless test does **not** prove them.

Run these on the Mac (with `/Applications/Mosh.app` deployed) and record the result in the
table at the bottom. Any **FAIL** becomes a backlog item (append to `docs/auto-loop/backlog.jsonl`).

## Quick automated smokes (no by-ear needed)

```bash
# Output device opens + real audio frames flow (no listening required):
/Applications/Mosh.app/Contents/MacOS/Mosh --live-audio-smoke

```

## By-ear / by-hand checks (need you at the machine)

Launch the app (`/Applications/Mosh.app`) and, for each row, do the action and confirm the
expected result. Reality-model invariant numbers in parentheses.

| # | Claim | Steps | Expected | Inv |
|---|---|---|---|---|
| H1 | Playback is audible + playhead advances | Import/create a clip, press Space | You hear it; playhead moves in sync | 1,4 |
| H2 | Loop playback repeats the region | Shift-drag a loop on the ruler, play | The region repeats audibly | 3,28 |
| H3 | Track + master meters move | Play a session | `Meter` bars track the audio; overload shows at clip | 18,57 |
| H4 | Mic recording captures a real take | Pick input (Settings), arm a track (R), record, stop | A non-silent clip lands on the armed track, time-aligned | 42–44,48 |
| H5 | Input monitoring is audible while armed | Arm + enable monitor (I) | You hear the live input through the output | 47 |
| H6 | MIDI controller plays an instrument track | Plug a keyboard, arm an instrument track | Played notes sound | 16 |
| H7 | Multi-out / per-track output routing | Route a track to a 2nd hardware out (needs G8 UI), play | Signal appears only on that output | 19 |
| H8 | Realtime export path (RT-only VST3) | Host a realtime-only VST3, Export | The bounce is non-silent and correct | 78,79 |

Notes:
- **H4/H5/H6** depend on `arm_track` / `set_input_monitor` / MIDI routing, which are wired but
  hardware-gated. **H7** needs the G8 output-routing UI (backlog) before it's reachable by click.
- These rows correspond to the `hardware` / count-in `gap` entries in the scoreboard
  (`docs/FEATURE_AUDIT.md`) — confirming them here promotes them from "plumbed" to "proven".

## Results (fill in, date each run)

| # | Date | Result (pass/fail) | Notes |
|---|---|---|---|
| H1 | | | |
| H2 | | | |
| H3 | | | |
| H4 | | | |
| H5 | | | |
| H6 | | | |
| H7 | | | |
| H8 | | | |

A FAIL here is a real defect → add a `G`-id row to `docs/auto-loop/backlog.jsonl` describing it,
and (where possible) extend `scripts/daw-conformance/` or `scripts/verify-hardware/verify.py`
with a check that would have caught it.
