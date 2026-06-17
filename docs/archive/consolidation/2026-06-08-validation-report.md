# MOSH Consolidation Validation Report

Date: 2026-06-08

This report records the validation run for the master consolidation pass in
`/Users/emiliosanchez-harris/Documents/ClaudeMosh`.

## Source Scope

Tracked consolidation outputs:

- `.gitignore`
- `docs/consolidation/`
- `scripts/`

Ignored preservation outputs:

- `_preserved_artifacts/2026-06-08-consolidation/`
- `assets/grit_demo/`

No legacy source folder was deleted or archived during this pass.

## Baseline Gates

These commands passed in the consolidation run:

```bash
git status --short --branch
npm --prefix ui run build
cmake --build build --target Mosh MoshTests
ctest --test-dir build --output-on-failure
MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest
```

Results:

- UI build passed and kept the Vite single-file bundle path.
- Native build passed for `Mosh` and `MoshTests`.
- `ctest` passed `MoshTests`.
- Command-surface selftest passed `89/89`.
- Selftest emitted the repo's existing JUCE assertion/leak-detector lines; the command result gate still passed.

## SA3 Gate

The SA3-gated command surface was available on this machine:

- `~/AI/stable-audio-3/optimized/mlx`
- `~/AI/judges_venv/bin/python`
- `service/colors/COLORRACK_DATA/colors.json`

This command passed:

```bash
MOSH_SELFTEST_SA3=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest
```

Result: `98/98` checks passed.

## Preservation Gates

These consolidation scripts passed:

```bash
scripts/verify-preservation-manifest.sh
scripts/validate-command-log-contract.sh
scripts/compare-sa3-colors.sh
```

Results:

- Preservation manifest verified every listed destination by size and SHA256.
- Command-log contract audit accepted the current JSONL shape and treats `seq` as process-local for append-only selftest logs.
- SA3 comparison generated `docs/consolidation/2026-06-08-sa3-color-rack-compare.md`.

## Native Evidence

Plugin-host command-surface evidence was captured with:

```bash
MOSH_EVID=/tmp/claudemosh-plugin-host-evidence-final scripts/plugin-host-evidence-gate.sh
```

Result: PASS. Evidence was written to `/tmp/claudemosh-plugin-host-evidence-final`.

The live-audio loopback gate was intentionally not run in this pass. The adapted
guardrail script is `scripts/live-audio-loopback-plan.sh`; it documents the
device/volume capture and restore requirements before any future CoreAudio
state changes.

## Remaining Review Items

- Review `docs/consolidation/2026-06-08-archive-candidates.md` before any archive/delete action.
- Decide whether any legacy Color Rack candidates should graduate into a new SA3 runtime expansion task.
- Decide whether the known JUCE assertion/leak-detector lines should become strict failures in a future cleanup pass.
