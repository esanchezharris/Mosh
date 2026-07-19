# DAW-parity conformance gate + regenerated scoreboard (2026-06-27)

_Working note, 2026-06-27. Moved verbatim out of CLAUDE.md; content unchanged._

**DAW-parity conformance gate + regenerated scoreboard (2026-06-27).** The gathered cross-DAW reality pack (`docs/reality-pack/`, 152 invariants + a 200-row eval suite) is now an executable gate: `scripts/daw-conformance/conformance.py` replays the eval suite through the REAL command surface (via a read-only `__snapshot` run-script directive) and `scoreboard.py` regenerates `docs/FEATURE_AUDIT.md`, wired into the native gate (`gate.sh`). Baseline **134/152** in-scope eval rows pass (~88%); the stale 2026-06-09 audit is archived to `docs/archive/feature-audit-2026-06-09/`. DISCOVERED **G14**: `set_track_volume`/`pan` undo bypasses the UndoManager (applies but doesn't restore). Real gaps seeded G1–G14 in `docs/auto-loop/backlog.jsonl`. selftest **1032/1032** (0 assertions), conformance green & deterministic (3 runs), verify.py 8/8. (#141)
