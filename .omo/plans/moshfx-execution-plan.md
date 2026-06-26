# Mosh Native Plugin Suite V1 Execution Plan

## TL;DR
> Summary:      Ship `moshAutoTune`, `moshOTT`, and `moshXFeedback` as in-app Mosh/Tracktion built-ins, proven through RED tests, the existing `load_builtin`/MoshOps path, and real run-script export evidence.
> Deliverables:
> - RED evidence for command surface, DSP fixtures, and UI/mock coverage.
> - Shared `src/plugins/moshfx/` scaffolding plus three plugin implementations.
> - Additive MoshOps registration, snapshots/readouts, and UI/mock display only.
> - Gate outputs, tmux manual-QA transcript, WAV/metrics artifacts, and review notes.
> Effort:       Large
> Risk:         High - new realtime DSP plus command/snapshot/UI surfaces.

## Scope
### Must have
- Build three in-app Tracktion built-ins, not standalone AU/VST3 binaries: `moshAutoTune`, `moshOTT`, `moshXFeedback` (`.omo/ulw-loop/brief.md:3-7`).
- Register through the existing Mosh plugin path: `PluginHost::initialise()`, `CMakeLists.txt`, `kBuiltins`, and `list_builtins` / `load_builtin` / `set_plugin_param` (`.omo/ulw-loop/brief.md:9-16`; `.omo/plans/autotune-research.md:14-50`; `.omo/plans/ott-research.md:16-45`).
- Resolve the X-FDBK placement conflict in favor of this request: it must be loadable through `load_builtin`; any master safety helper must be MoshOps-managed and not a parallel mutation path (`.omo/ulw-loop/brief.md:9-16`; `.omo/plans/xfeedback-research.md:64-68`).
- Keep all user-visible mutations in MoshOps, with additive snapshot/event changes and existing undo posture (`.omo/plans/ott-research.md:13-18`; `.omo/plans/xfeedback-research.md:36-44`).
- Extend UI/mock only enough for plugin browser/rack display and X-FDBK readout (`.omo/ulw-loop/brief.md:15-24`; `.omo/plans/moshfx-ultrawork-notepad.md:48-56`).
- Capture evidence under `.omo/evidence/moshfx/` and render artifacts under `_preserved_artifacts/moshfx/` (`.omo/plans/moshfx-ultrawork-notepad.md:58-76`).

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No standalone AU/VST3 packaging or installer work; this is app-internal built-in plugin work only (`.omo/ulw-loop/brief.md:3-4`).
- No new third-party dependency unless JUCE/Tracktion/SoundTouch is proven insufficient; AutoTune v1 must not use Basic Pitch, ML inference, or external pitch-correction hosting (`.omo/plans/autotune-research.md:48-82`; `.omo/plans/ott-research.md:71-80`; `.omo/ulw-loop/brief.md:31`).
- No audio-thread allocation, locking, file I/O, plugin-cache mutation, or `juce::var` construction in `applyToBuffer` (`.omo/plans/autotune-research.md:74-82`; `.omo/plans/xfeedback-research.md:114-135`).
- No persistent extra notch/EQ plugin insertion for X-FDBK; suppression is internal/runtime and project state remains additive (`.omo/plans/xfeedback-research.md:6-12`; `.omo/ulw-loop/brief.md:30`).
- No direct UI mutation route around MoshOps (`.omo/ulw-loop/brief.md:15-16`).

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD + Catch2, app selftest, run-script, and UI Vitest.
- QA policy: every task has agent-executed scenarios.
- Evidence: `.omo/evidence/moshfx/task-<N>-<slug>.<ext>`.
- Note: source line references outside the seven allowed files are research-derived and must be rechecked by the executor before editing. The allowed build anchors are `CMakeLists.txt:73-136` and `tests/CMakeLists.txt:7-43`.

## Execution strategy
### Parallel execution waves
> Target 5-8 tasks per wave. This plan is compact by request; parallelism is concentrated after the RED wave.
> Extract shared dependencies as Wave-1/2 tasks to maximize parallelism.

Wave 1 (no dependencies):
- Task 1: RED tests and evidence ledger

Wave 2 (after Wave 1):
- Task 2: shared DSP/plugin scaffolding and build wiring

Wave 3 (after Wave 2):
- Task 4: AutoTune implementation
- Task 5: OTT implementation
- Task 6: X-FDBK implementation

Wave 4 (after Wave 3):
- Task 3: MoshOps registration, snapshots, and command seam
- Task 7: UI/mock plugin browser, rack, and X-FDBK readout

Wave 5 (after Wave 4):
- Task 8: gates, manual QA, review, and cleanup

Critical path: Task 1 -> Task 2 -> Task 6 -> Task 3 -> Task 8

### Dependency matrix
| Task | Depends on | Blocks | Can parallelize with |
|------|------------|--------|----------------------|
| 1    | none       | 2      | none                 |
| 2    | 1          | 4,5,6  | none                 |
| 3    | 4,5,6      | 7,8    | 7                    |
| 4    | 2          | 3,8    | 5,6                  |
| 5    | 2          | 3,8    | 4,6                  |
| 6    | 2          | 3,8    | 4,5                  |
| 7    | 3          | 8      | none                 |
| 8    | 3,7        | final  | final verification   |

## Todos
> Implementation + Test = ONE task. RED capture is its own setup task because failing-first proof is a hard gate.
> Every task MUST have: References + Acceptance Criteria + QA Scenarios + Commit.

- [ ] 1. RED tests and evidence ledger

  What to do: Add failing-first coverage before production code: selftest checks for the three built-ins, DSP fixture files for AutoTune/OTT/X-FDBK, UI/mock tests for plugin browser/rack/readout, and an evidence directory convention. Capture expected failures before implementing the plugins.
  Must NOT do: Do not add production plugin classes, green stubs, or skip/weaken existing tests.

  Parallelization: Can parallel: NO | Wave 1 | Blocks: [2] | Blocked by: []

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `.omo/plans/moshfx-ultrawork-notepad.md:28-76` - required success criteria and evidence outputs.
  - Pattern:  `.omo/ulw-loop/brief.md:18-24` - required tests, gates, and tmux manual QA.
  - Test:     `.omo/plans/autotune-research.md:180-260` - AutoTune RED built-in and sine-correction fixture requirements.
  - Test:     `.omo/plans/ott-research.md:155-208` - OTT RED surface, direct DSP fixture, and render proof.
  - Test:     `.omo/plans/xfeedback-research.md:279-300` - X-FDBK RED core tests.
  - Test:     `tests/CMakeLists.txt:7-43` - current Catch2 target wiring.

  Acceptance criteria (agent-executable only):
  - [ ] `MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-1-red-selftest.txt 2>&1; test $? -ne 0`
  - [ ] `ctest --test-dir build --output-on-failure > .omo/evidence/moshfx/task-1-red-ctest.txt 2>&1; test $? -ne 0`
  - [ ] `cd ui && npm test > ../.omo/evidence/moshfx/task-1-red-ui-vitest.txt 2>&1; test $? -ne 0`
  - [ ] Each RED log contains the expected absent ID/class/readout failure, not an unrelated build or environment failure.

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: expected command-surface RED
    Tool:     bash
    Steps:    MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-1-red-selftest.txt 2>&1; test $? -ne 0; grep -E "moshAutoTune|moshOTT|moshXFeedback|load_builtin" .omo/evidence/moshfx/task-1-red-selftest.txt
    Expected: command exits nonzero and log names the missing built-in coverage.
    Evidence: .omo/evidence/moshfx/task-1-red-selftest.txt

  Scenario: expected fixture/UI RED
    Tool:     bash
    Steps:    ctest --test-dir build --output-on-failure > .omo/evidence/moshfx/task-1-red-ctest.txt 2>&1; test $? -ne 0; cd ui && npm test > ../.omo/evidence/moshfx/task-1-red-ui-vitest.txt 2>&1; test $? -ne 0
    Expected: CTest/UI failures point at missing Mosh FX DSP/readout behavior.
    Evidence: .omo/evidence/moshfx/task-1-red-ctest.txt
  ```

  Commit: NO | Message: `test(moshfx): add native plugin suite red coverage` | Files: [`src/app/SelfTest.cpp`, `tests/CMakeLists.txt`, `tests/test_moshfx_*.cpp`, `ui/**`]

- [ ] 2. Shared DSP/plugin scaffolding and build wiring

  What to do: Add `src/plugins/moshfx/` with shared realtime-safe helpers, parameter mapping utilities, DSP fixture harnesses, and empty compile-ready plugin/core shells only where needed for downstream implementation. Wire sources into the app and tests.
  Must NOT do: Do not make RED behavior pass with fake DSP, and do not introduce a new package/dependency.

  Parallelization: Can parallel: NO | Wave 2 | Blocks: [4,5,6] | Blocked by: [1]

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `.omo/ulw-loop/brief.md:9-16` - requested `src/plugins/moshfx/` and registration direction.
  - Pattern:  `.omo/plans/autotune-research.md:18-29` - custom plugin shape and RT constraints from existing plugins.
  - Pattern:  `.omo/plans/xfeedback-research.md:16-31` - common `te::Plugin` wrapper and FIFO/readout pattern.
  - API/Type: `CMakeLists.txt:73-136` - app target source/link area for new plugin files and `juce::juce_dsp` if needed.
  - Test:     `tests/CMakeLists.txt:7-43` - add Mosh FX DSP test sources and any shared pure DSP `.cpp` files.

  Acceptance criteria (agent-executable only):
  - [ ] `cmake --build build --target MoshTests > .omo/evidence/moshfx/task-2-build-tests.txt 2>&1`
  - [ ] `cmake --build build --target Mosh > .omo/evidence/moshfx/task-2-build-app.txt 2>&1`
  - [ ] RED tests from Task 1 still fail for real missing behavior, not compilation.

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: scaffolding compiles
    Tool:     bash
    Steps:    cmake --build build --target MoshTests > .omo/evidence/moshfx/task-2-build-tests.txt 2>&1 && cmake --build build --target Mosh > .omo/evidence/moshfx/task-2-build-app.txt 2>&1
    Expected: both build commands exit 0.
    Evidence: .omo/evidence/moshfx/task-2-build-app.txt

  Scenario: no dependency/package drift
    Tool:     bash
    Steps:    git diff -- package.json ui/package.json CMakeLists.txt > .omo/evidence/moshfx/task-2-dependency-diff.txt; ! grep -E "FetchContent|CPMAddPackage|add_subdirectory\\(.+third|\"dependencies\"" .omo/evidence/moshfx/task-2-dependency-diff.txt
    Expected: no new third-party dependency is introduced.
    Evidence: .omo/evidence/moshfx/task-2-dependency-diff.txt
  ```

  Commit: YES | Message: `build(moshfx): add shared native plugin scaffolding` | Files: [`src/plugins/moshfx/**`, `CMakeLists.txt`, `tests/CMakeLists.txt`]

- [ ] 3. MoshOps registration, snapshots, and command seam

  What to do: Register all three plugins through `PluginHost::initialise()`, expose them in `kBuiltins`, keep `load_builtin` / `set_plugin_param` normalized behavior, add additive snapshot/readout fields, and ensure bypass/remove/reorder/save/reload/undo stay on the existing MoshOps path. If X-FDBK also needs master safety controls, add MoshOps commands that find/create a Mosh-owned instance without bypassing `load_builtin` for user-facing insertion.
  Must NOT do: Do not create a second UI command path, standalone plugin target, or persistent child EQ/notch plugins.

  Parallelization: Can parallel: YES | Wave 4 | Blocks: [7,8] | Blocked by: [4,5,6]

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `.omo/plans/autotune-research.md:30-40` - palette and normalized parameter seam.
  - Pattern:  `.omo/plans/ott-research.md:16-21` - `kBuiltins` and `createNewPlugin(type,{})` insertion seam.
  - Pattern:  `.omo/plans/xfeedback-research.md:32-44` - registration, snapshot, and run-script verification path.
  - API/Type: `src/plugins/hosting/PluginHost.cpp:163-169` - research-derived registration location.
  - API/Type: `src/moshops/MoshOps.cpp:32-49` - research-derived built-in palette.
  - API/Type: `src/moshops/MoshOps.cpp:3260-3285` - research-derived load_builtin implementation.
  - API/Type: `src/moshops/MoshOps.cpp:3463-3478` and `src/moshops/MoshOps.cpp:3661-3664` - research-derived parameter normalization.

  Acceptance criteria (agent-executable only):
  - [ ] `MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-3-selftest.txt 2>&1`
  - [ ] `.omo/evidence/moshfx/task-3-selftest.txt` contains passing checks for `moshAutoTune`, `moshOTT`, and `moshXFeedback`.
  - [ ] `scripts/validate-command-log-contract.sh > .omo/evidence/moshfx/task-3-command-log.txt 2>&1`

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: all built-ins load through MoshOps
    Tool:     bash
    Steps:    MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-3-selftest.txt 2>&1 && grep -E "moshAutoTune|moshOTT|moshXFeedback" .omo/evidence/moshfx/task-3-selftest.txt
    Expected: selftest exits 0 and log includes all three built-in IDs.
    Evidence: .omo/evidence/moshfx/task-3-selftest.txt

  Scenario: command log contract preserved
    Tool:     bash
    Steps:    scripts/validate-command-log-contract.sh > .omo/evidence/moshfx/task-3-command-log.txt 2>&1
    Expected: script exits 0.
    Evidence: .omo/evidence/moshfx/task-3-command-log.txt
  ```

  Commit: YES | Message: `feat(moshops): register mosh native plugin suite` | Files: [`src/plugins/hosting/PluginHost.cpp`, `src/moshops/MoshOps.cpp`, `src/app/SelfTest.cpp`]

- [ ] 4. AutoTune implementation

  What to do: Implement conservative monophonic pitch correction using a Mosh-owned detector/control core and Tracktion SoundTouch/TimeStretcher pitch shifting. Defaults are chromatic, subtle, and stable on unvoiced/noise sections.
  Must NOT do: Do not use ML, Basic Pitch, third-party pitch detectors, external hosted correction plugins, or clear audio on stretcher underflow.

  Parallelization: Can parallel: YES | Wave 3 | Blocks: [3,8] | Blocked by: [2]

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `.omo/plans/autotune-research.md:52-82` - recommended files, registration ID, and v1 limits.
  - Pattern:  `.omo/plans/autotune-research.md:86-152` - detector, target selection, stretcher, dry-delay safety layer.
  - API/Type: `.omo/plans/autotune-research.md:154-178` - parameter IDs/ranges/defaults.
  - Test:     `.omo/plans/autotune-research.md:203-260` - near-note up/down/noise RED fixture details.
  - Build:    `CMakeLists.txt:121-125` - SoundTouch path is already enabled in the app target.

  Acceptance criteria (agent-executable only):
  - [ ] `ctest --test-dir build --output-on-failure -R "AutoTune|MoshFx" > .omo/evidence/moshfx/task-4-autotune-ctest.txt 2>&1`
  - [ ] Output median f0 is within fixture tolerance for sharp/flat A4 cases, noise remains stable, and all samples are finite.
  - [ ] `MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-4-autotune-selftest.txt 2>&1`

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: AutoTune DSP correction
    Tool:     bash
    Steps:    ctest --test-dir build --output-on-failure -R "AutoTune|MoshFx" > .omo/evidence/moshfx/task-4-autotune-ctest.txt 2>&1
    Expected: command exits 0; log reports sharp/flat sine correction and finite/noise-stable output.
    Evidence: .omo/evidence/moshfx/task-4-autotune-ctest.txt

  Scenario: AutoTune command seam
    Tool:     bash
    Steps:    MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-4-autotune-selftest.txt 2>&1 && grep "moshAutoTune" .omo/evidence/moshfx/task-4-autotune-selftest.txt
    Expected: selftest exits 0 and confirms load/params/snapshot/persistence for AutoTune.
    Evidence: .omo/evidence/moshfx/task-4-autotune-selftest.txt
  ```

  Commit: YES | Message: `feat(moshfx): add monophonic autotune builtin` | Files: [`src/plugins/moshfx/*AutoTune*`, `tests/test_*autotune*`, `src/app/SelfTest.cpp`]

- [ ] 5. OTT implementation

  What to do: Implement `moshOTT` as a 3-band upward/downward compressor using stock JUCE DSP filters/buffers and a Mosh-owned gain computer. `amount=0` is exact bypass; defaults are near-neutral; aggressive settings are obvious but ceiling-safe.
  Must NOT do: Do not raw dry/wet blend against all-pass crossover output, expose crossover automation in v1, or add third-party DSP.

  Parallelization: Can parallel: YES | Wave 3 | Blocks: [3,8] | Blocked by: [2]

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `.omo/plans/ott-research.md:30-45` - recommended files, registration, and build dependency limit.
  - Pattern:  `.omo/plans/ott-research.md:47-90` - signal path, LR split, and no raw dry/wet blend.
  - API/Type: `.omo/plans/ott-research.md:92-153` - gain computer, thresholds, parameters, and latency.
  - Test:     `.omo/plans/ott-research.md:203-280` - required signals and metrics.
  - Build:    `CMakeLists.txt:129-136` - link area for `juce::juce_dsp` if not already available.

  Acceptance criteria (agent-executable only):
  - [ ] `ctest --test-dir build --output-on-failure -R "OTT|MoshFx" > .omo/evidence/moshfx/task-5-ott-ctest.txt 2>&1`
  - [ ] Metrics show low-band dynamic range reduction, no full-band pumping, no NaN/Inf, and ceiling compliance.
  - [ ] `MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-5-ott-selftest.txt 2>&1`

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: OTT DSP metrics
    Tool:     bash
    Steps:    ctest --test-dir build --output-on-failure -R "OTT|MoshFx" > .omo/evidence/moshfx/task-5-ott-ctest.txt 2>&1
    Expected: command exits 0; log reports multiband dynamics change, no pumping regression, finite output, and ceiling pass.
    Evidence: .omo/evidence/moshfx/task-5-ott-ctest.txt

  Scenario: OTT command seam
    Tool:     bash
    Steps:    MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-5-ott-selftest.txt 2>&1 && grep "moshOTT" .omo/evidence/moshfx/task-5-ott-selftest.txt
    Expected: selftest exits 0 and confirms load/params/snapshot/persistence for OTT.
    Evidence: .omo/evidence/moshfx/task-5-ott-selftest.txt
  ```

  Commit: YES | Message: `feat(moshfx): add ott dynamics builtin` | Files: [`src/plugins/moshfx/*OTT*`, `tests/test_*ott*`, `src/app/SelfTest.cpp`]

- [ ] 6. X-FDBK implementation

  What to do: Implement `moshXFeedback` as a narrowband detector/suppressor with report-only default and explicit `autoSuppress` behavior. Use runtime internal notch slots, additive telemetry, render bypass, and fixed-size realtime processing.
  Must NOT do: Do not persist active notch frequencies as parameters, insert separate EQ/notch plugins, or let export/render suppression change bounces.

  Parallelization: Can parallel: YES | Wave 3 | Blocks: [3,8] | Blocked by: [2]

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `.omo/plans/xfeedback-research.md:46-86` - recommended files, plugin/core split, and wiring.
  - Pattern:  `.omo/plans/xfeedback-research.md:88-135` - detector, suppressor, notch math, and render bypass.
  - API/Type: `.omo/plans/xfeedback-research.md:137-161` - parameter defaults and runtime telemetry boundary.
  - API/Type: `.omo/plans/xfeedback-research.md:163-199` - MoshOps command behavior for optional master safety controls.
  - Test:     `.omo/plans/xfeedback-research.md:279-300` - core tests for report-only, suppressing, static tone, and render bypass.

  Acceptance criteria (agent-executable only):
  - [ ] `ctest --test-dir build --output-on-failure -R "XFeedback|MoshFx" > .omo/evidence/moshfx/task-6-xfeedback-ctest.txt 2>&1`
  - [ ] Report-only mode detects without changing output; auto-suppress mode reduces squeal; static tone does not suppress by default; rendering bypass is transparent.
  - [ ] `MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-6-xfeedback-selftest.txt 2>&1`

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: X-FDBK core behavior
    Tool:     bash
    Steps:    ctest --test-dir build --output-on-failure -R "XFeedback|MoshFx" > .omo/evidence/moshfx/task-6-xfeedback-ctest.txt 2>&1
    Expected: command exits 0; log confirms report-only, suppression, static-tone rejection, and render-bypass transparency.
    Evidence: .omo/evidence/moshfx/task-6-xfeedback-ctest.txt

  Scenario: X-FDBK command seam
    Tool:     bash
    Steps:    MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-6-xfeedback-selftest.txt 2>&1 && grep "moshXFeedback" .omo/evidence/moshfx/task-6-xfeedback-selftest.txt
    Expected: selftest exits 0 and confirms load/params/snapshot/readout behavior for X-FDBK.
    Evidence: .omo/evidence/moshfx/task-6-xfeedback-selftest.txt
  ```

  Commit: YES | Message: `feat(moshfx): add x-feedback safety builtin` | Files: [`src/plugins/moshfx/*Feedback*`, `tests/test_*feedback*`, `src/app/SelfTest.cpp`]

- [ ] 7. UI/mock plugin browser, rack, and X-FDBK readout

  What to do: Add Mosh FX mock data and UI display support so the plugin browser lists the three built-ins, generic rack sliders stay readable with their parameter sets, and X-FDBK telemetry renders from snapshot/event data only.
  Must NOT do: Do not add UI controls that mutate plugin state outside MoshOps, and do not create a separate bespoke editor for v1.

  Parallelization: Can parallel: YES | Wave 4 | Blocks: [8] | Blocked by: [3]

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `.omo/plans/moshfx-ultrawork-notepad.md:48-56` - UI/mock deliverable and RED/green policy.
  - Pattern:  `.omo/ulw-loop/brief.md:15-24` - plugin browser/rack/readout scope and `npm test` gate.
  - API/Type: `.omo/plans/xfeedback-research.md:201-277` - additive X-FDBK snapshot/event readout shape.
  - Test:     UI test files to be located by executor; read scope was constrained in this planning pass.

  Acceptance criteria (agent-executable only):
  - [ ] `cd ui && npm test > ../.omo/evidence/moshfx/task-7-ui-vitest.txt 2>&1`
  - [ ] UI tests assert browser entries for `moshAutoTune`, `moshOTT`, `moshXFeedback`, generic rack readability, and X-FDBK telemetry rendering from mock snapshot/event data.

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: UI mock and rack tests
    Tool:     bash
    Steps:    cd ui && npm test > ../.omo/evidence/moshfx/task-7-ui-vitest.txt 2>&1
    Expected: Vitest exits 0 and includes Mosh FX plugin browser/rack/readout assertions.
    Evidence: .omo/evidence/moshfx/task-7-ui-vitest.txt

  Scenario: no parallel mutation path
    Tool:     bash
    Steps:    git diff -- ui > .omo/evidence/moshfx/task-7-ui-diff.txt; ! grep -E "setXFeedback|setMoshFx|directPluginMutation|window\\.mosh.*plugin" .omo/evidence/moshfx/task-7-ui-diff.txt
    Expected: diff contains display/mock additions only, with command mutations still routed through existing bridge/MoshOps flows.
    Evidence: .omo/evidence/moshfx/task-7-ui-diff.txt
  ```

  Commit: YES | Message: `feat(ui): show mosh native plugin suite` | Files: [`ui/**`]

- [ ] 8. Gates, manual QA, review, and cleanup

  What to do: Run full local gates, then drive actual `Mosh --run-script` through tmux to load each built-in, set representative params, export WAVs, compute metrics, capture transcript, and clean up live QA state. Run final review lanes and address every finding before completion.
  Must NOT do: Do not declare success from tests alone, leave tmux sessions running, or include `.omo/` in publishable commits unless explicitly requested.

  Parallelization: Can parallel: NO | Wave 5 | Blocks: [final] | Blocked by: [3,7]

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `.omo/plans/moshfx-ultrawork-notepad.md:58-76` - tmux run-script and full-gate requirements.
  - Pattern:  `.omo/ulw-loop/brief.md:18-24` - exact gate list and `_preserved_artifacts/moshfx/` proof.
  - Pattern:  `.omo/plans/ott-research.md:187-201` - render proof shape for real command-surface exports.
  - Pattern:  `.omo/plans/xfeedback-research.md:40-44` - run-script replay and WAV metrics tooling.

  Acceptance criteria (agent-executable only):
  - [ ] `cmake --build build > .omo/evidence/moshfx/task-8-build.txt 2>&1`
  - [ ] Run `MOSH_NO_AUDIO=1 .../Mosh --selftest` three times with evidence files `task-8-selftest-1.txt` through `task-8-selftest-3.txt`, all exit 0.
  - [ ] `MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest-undo > .omo/evidence/moshfx/task-8-selftest-undo.txt 2>&1`
  - [ ] `ctest --test-dir build --output-on-failure > .omo/evidence/moshfx/task-8-ctest.txt 2>&1`
  - [ ] `scripts/validate-command-log-contract.sh > .omo/evidence/moshfx/task-8-command-log.txt 2>&1`
  - [ ] `cd ui && npm test > ../.omo/evidence/moshfx/task-8-ui-vitest.txt 2>&1`
  - [ ] Tmux transcript proves `run-script` completed and `_preserved_artifacts/moshfx/` contains non-empty WAV/metrics artifacts.
  - [ ] Final reviewers approve plan compliance, code quality, real QA, and scope fidelity unconditionally.

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: full local gate
    Tool:     bash
    Steps:    cmake --build build > .omo/evidence/moshfx/task-8-build.txt 2>&1 && MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-8-selftest-1.txt 2>&1 && MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-8-selftest-2.txt 2>&1 && MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest > .omo/evidence/moshfx/task-8-selftest-3.txt 2>&1 && MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest-undo > .omo/evidence/moshfx/task-8-selftest-undo.txt 2>&1 && ctest --test-dir build --output-on-failure > .omo/evidence/moshfx/task-8-ctest.txt 2>&1 && scripts/validate-command-log-contract.sh > .omo/evidence/moshfx/task-8-command-log.txt 2>&1 && (cd ui && npm test > ../.omo/evidence/moshfx/task-8-ui-vitest.txt 2>&1)
    Expected: every command exits 0.
    Evidence: .omo/evidence/moshfx/task-8-build.txt

  Scenario: real command-surface render proof
    Tool:     tmux
    Steps:    mkdir -p .omo/evidence/moshfx _preserved_artifacts/moshfx; tmux new-session -d -s ulw-qa-moshfx "MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --run-script _preserved_artifacts/moshfx/run-script.json --json > _preserved_artifacts/moshfx/run-script-output.json 2>&1"; while tmux has-session -t ulw-qa-moshfx 2>/dev/null; do sleep 2; done; tmux capture-pane -pt ulw-qa-moshfx -S - > .omo/evidence/moshfx/task-8-run-script-tmux.txt 2>/dev/null || true; test -s _preserved_artifacts/moshfx/run-script-output.json; find _preserved_artifacts/moshfx -type f \\( -name "*.wav" -o -name "*.json" \\) -size +0c > .omo/evidence/moshfx/task-8-artifacts.txt
    Expected: output JSON and artifact list are non-empty; transcript/output show all three built-ins loaded and exported.
    Evidence: .omo/evidence/moshfx/task-8-run-script-tmux.txt
  ```

  Commit: YES | Message: `test(moshfx): verify native plugin suite gates` | Files: [`scripts/**`, `_preserved_artifacts/moshfx/**`, relevant test files; exclude `.omo/` unless requested]

## Final verification wave (MANDATORY - after all implementation tasks)
> Runs in PARALLEL. ALL must APPROVE. Surface results to the caller and wait for an explicit "okay" before declaring complete.
- [ ] F1. Plan compliance audit - every task done, every acceptance criterion met.
- [ ] F2. Code quality review - diagnostics clean, idioms match, no dead code, no realtime hazards.
- [ ] F3. Real manual QA - every QA scenario executed with evidence captured under `.omo/evidence/moshfx/`.
- [ ] F4. Scope fidelity - nothing extra shipped beyond Must-Have, no standalone AU/VST3 packaging, no parallel mutation path.

## Commit strategy
- One logical change per commit. Conventional Commits (`<type>(<scope>): <subject>` body + footer).
- Atomic: every committed state must build and pass the relevant tests; RED evidence can be captured before commit and paired with the green implementation commit.
- No "WIP" / "fix typo squash later" commits on the final branch - clean up before merge.
- Reference the plan file path in the final implementation commit footer: `Plan: .omo/plans/moshfx-execution-plan.md`.

## Success criteria
- All Must-Have shipped; all QA scenarios pass with captured evidence; F1-F4 approved; commit history clean.
