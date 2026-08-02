# DAW-conformance harness

Turns the gathered **reality pack** (`docs/reality-pack/`) into a reproducible gate that
proves Mosh behaves like a real DAW — not just that command plumbing returns `ok`.

`conformance.py` loads `docs/reality-pack/mosh_daw_eval_suite.csv` (200 rows), groups them
into the ~24 distinct scenario families (`(area, user_action)` pairs), runs each family
**once** through the real command surface via `Mosh --run-script`, and fans the verdict back
to every eval-id sharing that scenario. It reuses `scripts/verify-hardware/verify.py`'s
run-script + WAV helpers and the `__snapshot` run-script directive, so state / audio / undo
assertions hit the **same** `snapshot()` and rendered audio the app produces.
Capabilities shipped after the reality pack was gathered register in **`EXTRA_FAMILIES`**
(keyed by family name, reported under the `Post-pack` area, no CSV retrofit needed).

## Run

```bash
python3 scripts/daw-conformance/conformance.py            # auto-finds the newest local build
python3 scripts/daw-conformance/conformance.py --bin /path/to/Mosh
python3 scripts/daw-conformance/conformance.py --write-verdicts   # intentional-change path
```

Writes `scripts/daw-conformance/report.json` (per-eval-id + per-area/priority/invariant
rollups — gitignored) and compares the normalized outcome against the **committed**
`verdicts.json`. **Exit 0** unless an in-scope family *regresses* (status `fail`) **or the
run disagrees with `verdicts.json`** — a behavior change must land its verdict flip
(`--write-verdicts` + `scoreboard.py`) in the same PR, as a reviewable diff.

## Verdict statuses

| status | meaning | gate |
|---|---|---|
| `pass` | in-scope capability proven headless (state/audio/undo asserted) | ✅ |
| `fail` | in-scope capability **regressed** (was green, now broken) | ❌ blocks |
| `gap` | in-scope capability **absent** — attributed to a LIVE backlog item via `backlog_ref` | ✅ tracked |
| `hardware` | needs a live audio device / mic / MIDI — proven in the Phase-1 hardware pass | ✅ |
| `out-of-scope` | Moshi / Arena / Collaboration / battle-submission — outside the conventional-parity pass | ✅ |

A parity fix that closes a gap flips that family from `gap` → `pass`; the harness is the
proof the backlog item actually landed. An eval row may be authored AHEAD of its
implementation by carrying a `backlog_ref` column pointing at a live backlog item — it
reports `gap` until the item ships; a `backlog_ref` at a **done** item is a hard FAIL
(the row must gain a family).

## Honesty tooling (DAW-parity program P1 — all pure-static, cheap-lane)

| tool | what fails the gate |
|---|---|
| `coverage_check.py` | any MoshOps dispatch command exercised by **no** test surface (conformance / verify / selftest / e2e) and not waived in `coverage_waivers.json` (waivers are reasoned + **expiring**, fail when stale or no-longer-needed) |
| `model_lint.py` | unmapped in-scope eval scenario; `gap` verdict without a live `backlog_ref`; verdicts.json out of sync with the CSV/`EXTRA_FAMILIES`; malformed backlog/matrix artifacts |
| `scoreboard.py --check` | a stale `docs/FEATURE_AUDIT.md` (regenerable byte-for-byte from committed inputs alone) |

`scoreboard.py` (no flag) regenerates `docs/FEATURE_AUDIT.md` from `verdicts.json` + the
eval CSV + `scripts/daw-conformance/parity_backlog.jsonl` (the minimal G-prefixed
conventional-parity registry) + the coverage ledger.

## Scope

Conventional DAW parity only (locked 2026-06-26; expansion governed by the DAW-parity
program — see `docs/reality-pack/missing_capabilities_2026-07-18.md` and the capability
matrix once it lands). The Moshi, Arena, and Collaboration areas are reported
`out-of-scope`, not failed — see `docs/reality-pack/INDEX.md`.

## Baseline (2026-07-18, fresh Debug binary)

150 pass · 0 gap · 2 hardware · 48 out-of-scope (in-scope row pass rate 150/152 ≈ 99%;
**18 distinct in-scope scenario families** — the row count is padded ~8× by the legacy CSV,
which is why the scoreboard now leads with the family count). The two `hardware` rows are
play→audible and count-in→audible-click. The 2026-06-26 "134/152, 17 gap" baseline is
historical: those gaps all shipped (G1/G2b/G4a/G4b/G7/G10/G12/G14 — see the backlog notes).

## Wiring

The native gate (`scripts/auto-loop/gate.sh`) runs `conformance.py` right after
`verify.py`; BOTH lanes run the three static honesty checks (`run_parity_checks`). Every
native PR must keep conformance green *and* fresh; adding scenario families or fixing gaps
is a normal code change reviewed by the loop.
