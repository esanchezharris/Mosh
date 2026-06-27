# DAW-conformance harness

Turns the gathered **reality pack** (`docs/reality-pack/`) into a reproducible gate that
proves Mosh behaves like a real DAW — not just that command plumbing returns `ok`.

`conformance.py` loads `docs/reality-pack/mosh_daw_eval_suite.csv` (200 rows), groups them
into the ~24 distinct scenario families (`(area, user_action)` pairs), runs each family
**once** through the real command surface via `Mosh --run-script`, and fans the verdict back
to every eval-id sharing that scenario. It reuses `scripts/verify-hardware/verify.py`'s
run-script + WAV helpers and the `__snapshot` run-script directive, so state / audio / undo
assertions hit the **same** `snapshot()` and rendered audio the app produces.

## Run

```bash
python3 scripts/daw-conformance/conformance.py            # auto-finds the newest local build
python3 scripts/daw-conformance/conformance.py --bin /path/to/Mosh
```

Writes `scripts/daw-conformance/report.json` (per-eval-id + per-area/priority/invariant rollups).
**Exit 0** unless an in-scope family *regresses* (status `fail`).

## Verdict statuses

| status | meaning | gate |
|---|---|---|
| `pass` | in-scope capability proven headless (state/audio/undo asserted) | ✅ |
| `fail` | in-scope capability **regressed** (was green, now broken) | ❌ blocks |
| `gap` | in-scope capability **absent** — a tracked backlog item (e.g. export range/tail, count-in, gain-undo) | ✅ tracked |
| `hardware` | needs a live audio device / mic / MIDI — proven in the Phase-1 hardware pass | ✅ |
| `out-of-scope` | Monster / Arena / Collaboration / battle-submission — outside the conventional-parity pass | ✅ |

A parity fix that closes a gap flips that family from `gap` → `pass`; the harness is the
proof the backlog item actually landed.

## Scope

Conventional DAW parity only (locked 2026-06-26). The Monster, Arena, and Collaboration
areas are reported `out-of-scope`, not failed — see `docs/reality-pack/INDEX.md`.

## Baseline (current `main`, release binary)

134 pass · 17 gap · 1 hardware · 48 out-of-scope (in-scope pass rate 134/152 ≈ 88%).
Gaps: **G1** export range/section + tail (×15 rows), **G2** recording count-in/pre-roll,
**G14** `set_track_volume`/`pan` undo does not restore the prior value (bypasses the
UndoManager). These are the seed of the auto-loop parity backlog.

## Wiring

The native gate (`scripts/auto-loop/gate.sh`) runs this right after `verify.py`, so every
native PR the auto-loop builds must keep conformance green. Adding scenario families or
fixing gaps is a normal code change reviewed by the loop.
