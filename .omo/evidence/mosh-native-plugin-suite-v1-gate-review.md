# Mosh Native Plugin Suite V1 Gate Review

recommendation: REJECT

## originalIntent

Ship Mosh Native Plugin Suite V1 on `codex/mosh-native-plugin-suite`: add Tracktion built-in processors `moshAutoTune`, `moshOTT`, and `moshXFeedback`; register them through the existing app/plugin surfaces; cover DSP, selftest, UI mock/readout, docs, and manual run-script evidence; preserve MoshOps as the only public mutation path.

## desiredOutcome

The user should be able to merge a stageable, verified branch where the three Mosh-native FX are built into the app, load through existing plugin commands, mutate only through generic MoshOps commands, survive undo/save/reload, expose additive `moshFx` readouts, and have current green evidence for build, selftest, CTest, UI tests, typecheck, command-log contract, and manual audio QA.

## userOutcomeReview

Most shipped artifacts support the intended user outcome:

- New source and test files are present and stageable: `git ls-files --others --exclude-standard` lists all `src/plugins/moshfx/*` files and `tests/test_moshfx_dsp.cpp`; `git check-ignore` returned no ignore match.
- Build graph includes the new app processors at `CMakeLists.txt:95-101` and C++ DSP test sources at `tests/CMakeLists.txt:9-25`.
- Mosh FX files are split under the 250 pure-LOC ceiling: `MoshAutoTuneDsp.cpp` 177, `MoshAutoTunePlugin.cpp` 160, `MoshFxDsp.h` 107, `MoshFxMath.h` 21, `MoshFxPlugins.h` 91, `MoshOTTDsp.cpp` 77, `MoshOTTPlugin.cpp` 101, `MoshXFeedbackDsp.cpp` 167, `MoshXFeedbackPlugin.cpp` 203, `tests/test_moshfx_dsp.cpp` 154.
- X-FDBK active-cut score/depth exists in production readouts: telemetry readout includes `score` and optional `depthDb` at `src/plugins/moshfx/MoshXFeedbackPlugin.cpp:67-83` and `src/plugins/moshfx/MoshXFeedbackPlugin.cpp:214-227`; preview fallback includes score and depth for active cuts at `src/moshops/MoshOps.cpp:63-77` and `src/moshops/MoshOps.cpp:124-128`.
- Selftest covers the X-FDBK score/depth readout at `src/app/SelfTest.cpp:939-967`.
- No new Mosh-specific public mutation command was found. The C++ dispatcher still routes plugin operations through existing `load_builtin`, `set_plugin_param`, `remove_plugin`, `reorder_plugin`, and `bypass_plugin` at `src/moshops/MoshOps.cpp:574-585`; the UI readout at `ui/src/ui/Dock.tsx:135-155` is display-only.
- Docs count matches final selftest evidence: `docs/CURRENT_STATUS.md:63` says 1046 checks, and `docs/PROGRESS.md:30` records `1046/1046, 0 failed x3`.

## blockers

1. Required code-review/slop coverage is missing from the executor review report.

   The gate instructions require the code review report to explicitly show the same skill-perspective check and overfit/slop criterion coverage, including deletion-only/requested-removal-only tests, tautological tests, implementation-mirroring tests, excessive/useless tests, and unnecessary extraction/parsing/normalization. The only slop coverage in `.omo/evidence/moshfx/final-review.md` is the two-line "Slop/maintainability review" at lines 30-32, which only mentions deduplicating AutoTune calculation and splitting files below 250 pure LOC. It does not mention `remove-ai-slops`, `programming`, overfit tests, tautological tests, implementation-mirroring tests, deletion-only tests, excessive tests, or production extraction/parsing/normalization. A direct `rg` over `.omo/evidence/moshfx/final-review.md` and the other `.md` evidence files found no such coverage.

## exactEvidenceGaps

- `.omo/evidence/moshfx/final-review.md:30-32` is insufficient for the required overfit/slop criterion coverage.
- `.omo/evidence/moshfx/c5-full-gate-final.txt:1-2` is sparse build evidence: it contains only Ninja recheck/restage output and no explicit command, exit code, or final target completion line. Current binary/object mtimes and subsequent selftest/CTest evidence reduce stale-build risk, but the artifact itself is not self-describing.
- No notepad path or separate manual QA matrix artifact was present in the supplied evidence set. Manual run-script evidence exists at `.omo/evidence/moshfx/c4-run-script-final.txt` and metrics at `.omo/evidence/moshfx/metrics-final.json`.

## checkedArtifactPaths

- `.omo/evidence/moshfx/c1-selftest-final-port8870.txt`
- `.omo/evidence/moshfx/c5-full-gate-final.txt`
- `.omo/evidence/moshfx/c2-ctest-final.txt`
- `.omo/evidence/moshfx/selftest-undo-final.txt`
- `.omo/evidence/moshfx/c3-ui-vitest-final.txt`
- `.omo/evidence/moshfx/c3-ui-typecheck-final.txt`
- `.omo/evidence/moshfx/command-log-contract-final.txt`
- `.omo/evidence/moshfx/c4-run-script-final.txt`
- `.omo/evidence/moshfx/metrics-final.json`
- `.omo/evidence/moshfx/final-review.md`
- `CMakeLists.txt`
- `tests/CMakeLists.txt`
- `src/plugins/moshfx/*`
- `tests/test_moshfx_dsp.cpp`
- `src/app/SelfTest.cpp`
- `src/moshops/MoshOps.cpp`
- `src/moshops/MoshOps.h`
- `src/plugins/hosting/PluginHost.cpp`
- `ui/src/bridge.mock.ts`
- `ui/src/bridge.mock.test.ts`
- `ui/src/types.ts`
- `ui/src/ui/Dock.tsx`
- `ui/src/ui/pluginBrowserUtil.test.ts`
- `docs/CURRENT_STATUS.md`
- `docs/PROGRESS.md`

## directSlopAndProgrammingPass

Direct pass did not find an unresolved production source slop blocker in the changed Mosh FX implementation. Tests are behavior-oriented enough for the DSP surface: `tests/test_moshfx_dsp.cpp` checks pitch movement, noise stability, retune response, OTT strength, X-FDBK detection, suppression, and release behavior rather than only verifying requested deletion or implementation text. UI mock tests do include schema parity assertions, but they are tied to the bridge contract and not used as sole proof; native selftest and run-script artifacts exercise the real command/render surfaces.

The rejection is based on missing required review-report coverage, not on a confirmed production-code behavior defect.
