# Ponytail Audit — Mosh

## Summary

This audit independently re-verified every flagged finding against the source. Of the candidates, **30 confirmed** findings stand and **9 risky / needs-judgment** findings were retained for human review (1 candidate was rejected outright). The confirmed set removes roughly **474 lines** of genuinely dead, duplicated, or unreachable code; the risky set would remove another **~189 lines** but each carries a behavioral caveat or a coordinated multi-file edit. The headline read: **Mosh is a lean codebase.** Nearly all confirmed cruft is the expected residue of a fast incremental build — copy-pasted test-helper lambdas, symmetric scaffold getters in the WIP LoRA trainer, unwired UI store fields whose features were intentionally dropped, dead Windows/cross-platform breadcrumbs in a macOS-only v0, and dev-script helpers. No prime-directive architecture (the command/snapshot seam, undo, adapter seam, ASTD, cache fingerprint) is implicated by any cut. The single largest opportunity is the `service/quality_readout.py` LearnedJudge sidecar (~105 lines) and the root `keymap.ts` parallel-keymap runtime (~60 lines), both fully superseded by the live paths.

## Outcome — applied 2026-06-19 (maximal scope)

Applied behind the full test gate: **tsc clean · vitest 324/324 · Playwright e2e 29/29 · `Mosh --selftest` 793/793 ×3 deterministic** (Debug build). Net source change: **+89 / −742 = −653 lines** across 34 files.

**Applied:**
- All confirmed safe deletes — TS dead store fields/re-exports; Python `LearnedJudge` sidecar + `compare()` + orphan `corpus_builder.py` + `lora_trainer_adapter` dead fns; dead automation-script helpers; `run.ps1` un-bundled; C++ `GenerativeJobManager`/`TrainingJobManager::capabilities()`; Swift dead structs/methods/fields.
- Test-coupled deletes (removed dead code **and** its dead-only tests) — `keymap.ts` runtime (+`keymap.test.ts`), dock `presetLayout`/`bringToFront`, `drumGrid.noteStart`, `actions` `ALL_ACTIONS`/`isEditorAction`/`REGIONS`, `pluginBlocklist` UI plumbing (+ mock allowlist), the `"color"` setting type.
- Restructures — `SelfTest.cpp` demo-helper consolidation (file-scope `moshDemoCmd`/`moshDemoObj`), cmake non-Apple branches removed, `accept_aliases` flag dropped, `Arrange.tsx` `prepCanvas` extraction.
- **Regression fix** — `useFileDrop` is now mounted in `App.tsx` with a drop overlay (BRW-007 had lost its mount; backend command + selftest assertions were already live).

**Deferred (judgment calls — deliberately NOT applied):**
- `MoshEngine::indexOf` collapse — an unprovable case-collision behavior change; kept the explicit two-pass code.
- `RemoteCompanionServer` `pcm16Base64` wrapper — inlining triggers a TDZ `ReferenceError`; 1 line not worth the breakage.
- iOS `BonjourBrowser.stop()` — defensible NWBrowser teardown symmetry, near-zero cost.

**iOS/Swift:** build-verified — `xcodebuild` for the iOS Simulator (Xcode 26.5) compiles the app **and** the test target clean (`BUILD SUCCEEDED` / `TEST BUILD SUCCEEDED`).

## Confirmed findings

Grouped by tag, sorted within each group by estimated lines removed (desc). `auto-safe?` = safe to apply mechanically after a build/test run.

### delete (genuinely dead / unreachable code)

| file:lines | what | replacement | est | auto-safe? |
|---|---|---|---|---|
| `service/quality_readout.py:158-268` | Entire `LearnedJudge` learned-judge sidecar block: env constants, class, `_LEARNED` singleton + `learned_judge()` accessor, helper-only imports | nothing | 105 | ✅ |
| `service/training/corpus_builder.py:1-49` | Whole module — argparse CLI (`validate`/`build`) wrapping `build_corpus_bundle`; server.py imports the wrapped fn directly | nothing | 49 | ✅ |
| `ui/src/ui/dock/dockLayout.ts:109-139` | `presetLayout()` + `LayoutName` type + `DockLayout` interface ("layout presets" section); Phase-4 wiring never landed | nothing | 31 | ❌ (test edit) |
| `service/training/lora_trainer_adapter.py:17-36` | `train_adapter()` + `main()` CLI + `__name__` guard (and now-unused `import json` / `train` import); server binds `trainer_job.train` directly | keep only `backend_name()`/`available()` passthroughs | 22 | ❌ (scaffold) |
| `ui/src/store.ts:30,51,110,192,345-346` | `inlineAuto` field + `setInlineAuto` + `InlineAutoSel` type (AUT-003 inline-automation selection; feature intentionally dropped) | nothing | 7 | ✅ |
| `ui/src/store.ts:176,584-590` | `setUiScale` mirror setter; UI scale is set via SettingsPanel `set("uiScale",…)`. Field stays | nothing (setter only) | 7 | ✅ |
| `ios/.../Models/CompanionModels.swift:21-33` | `RemoteStatus` + `RemotePairingInfo` structs (unused parallel Swift mirror) | nothing | 13 | ✅ |
| `ui/src/ui/dock/dockLayout.ts:104-107` | `bringToFront(order, id)` z-order helper; no dock z-order state exists | nothing | 12 | ❌ (test edit) |
| `ui/src/store.ts:58,129-130,197,446-458` | `pluginBlocklist` field + `loadBlocklist`/`clearBlocklist` (INS-005 UI plumbing, unwired) | nothing | (see risky) | — |
| `ui/src/store.ts:43,100,188,335` | `laneHeight` field + `setLaneHeight` (Arrange uses local `LANE_H=76`, never the store field) | nothing | 4 | ✅ |
| `ui/src/ui/dock/useDockLayout.ts:49,60-64` | `setLeftCollapsed` store action; left collapse handled by `toggleLeft` | nothing | 6 | ✅ |
| `service/quality_readout.py:150-155` | `compare(pq, pq_base)` helper; the shipped delta is computed inline in `sa3/qa.py` | nothing | 6 | ✅ |
| `ui/src/ui/drumGrid.ts:50-51` | `noteStart` back-compat alias; callers use `stepStartBeats(step, sb)` (identical at swing=0) | nothing | 6 | ❌ (test edit) |
| `src/training/TrainingJobManager.cpp:105-108` (+ `.h:15`) | `TrainingJobManager::capabilities()` def + decl; zero callers | nothing | 6 | ❌ (live scaffold) |
| `src/generative/GenerativeJobManager.cpp:117-120` (+ `.h:24`) | `GenerativeJobManager::capabilities()` def + decl; dead HTTP wrapper | nothing | 5 | ✅ |
| `ios/.../Models/CompanionModels.swift:110-112` | `RenderTarget.status` + `.adapter` stored fields (+ assignments 49-50); never read | nothing | 4 | ❌ (no Swift build gate) |
| `ios/.../Services/CompanionStore.swift:74-76` | `noteRenderTargetNeeded(_:)` method; zero callers | nothing | 3 | ❌ (no Swift build gate) |
| `ui/src/agent/brain.ts:14` | Dead re-export `export { INTENTS, systemPrompt, parseReply } from "./brainCore"` + false comment; consumers import from brainCore directly | nothing | 2 | ✅ |
| `ui/src/store.ts:108,344` | `clearTimeRange` action; callers use `setTimeRange(null)` | nothing | 2 | ✅ |
| `ui/src/agent/brainCore.ts:10` | Write-only `mocked?: boolean` field on `BrainReply` (+ `, mocked: true` write in brain.ts:32) | nothing | 1 | ✅ |
| `ios/.../Services/PhoneTakeRecorder.swift:63-74` | `cancel(client:)` (+ orphaned `ChunkSequencer.cancel()`); network cancel path preserved in `stop()` | nothing | 17 | ✅ |

### shrink (duplication / boilerplate consolidation)

| file:lines | what | replacement | est | auto-safe? |
|---|---|---|---|---|
| `src/app/SelfTest.cpp:3663-3672, 3727-3736, 3794-3803, 3819-3828, 3850-3859` | 10 copy-pasted local `cmd`/`obj` lambdas across the 5 demo/AB functions | Use file-scope `objN(...)` and `cmd(ops, …)`: `obj(`→`objN(`, `cmd(x)`→`cmd(ops, x)` | 45 | ✅ |
| `ui/src/ui/Arrange.tsx:704-800` | Identical 5-line DPR/canvas-setup boilerplate in ClipWave/ClipMidi/ClipDrumGrid | Extract `prepCanvas(cv): {ctx,w,h}|null`; ClipWave keeps its `!peaks` guard | 8 | ❌ (hot-path, run tsc/vitest) |

### yagni (dead parameter / speculative flag)

| file:lines | what | replacement | est | auto-safe? |
|---|---|---|---|---|
| `service/server.py:304-330` | `accept_aliases: bool = True` flag in `_normalize_training_submit` + its branch logic; always called True | Drop the param, keep the alias-accepting path unconditionally | 4 | ❌ (restructure, not deletion) |

### native (unreachable build/platform paths)

| file:lines | what | replacement | est | auto-safe? |
|---|---|---|---|---|
| `cmake/BuildUI.cmake:55-64, 73-75` | Two non-Apple `else()` branches; `CMakeLists.txt` FATAL_ERRORs on non-Apple before include, so `if(APPLE)` is always true | Drop the `else()` blocks, unwrap the `if(APPLE)` guards to the Apple bodies | 12 | ❌ (build-system, human glance) |

### delete (dev scripts / bundling)

| file:lines | what | replacement | est | auto-safe? |
|---|---|---|---|---|
| `scripts/macos-ui-automation-gate.py:307-325` | Unused `mouse_drag(...)`; live variant is `mouse_drag_xy` | nothing | 21 | ✅ |
| `scripts/macos-ui-automation-gate.py:554-566` | Unused `blue_centroid_x(...)` centroid finder | nothing | 13 | ✅ |
| `scripts/macos-ui-automation-gate.py:497-499` | Unused `mean_brightness(...)`; live comparison is `mean_abs_diff` | nothing | 3 | ✅ |
| `run-mosh.sh:118` | `deploy` bundles `service/run.ps1` (Windows PowerShell) into the macOS .app; runtime only execs `run.sh` | Remove `"$ROOT/service/run.ps1"` from the cp arg list | 0 | ✅ |

## Risky / needs-judgment

These are real findings, but each needs a human to apply — either because the edit is a behavior change that cannot be proven safe, or because the named cut breaks a test/build unless a coordinated multi-file edit is done together, or because the symbol is defensible API/scaffold the author may intend to keep.

- **`src/engine/MoshEngine.cpp:199-209, 219-229` — stdlib (`StringArray::indexOf` 3-arg overload).** The collapse is *not* strictly semantics-preserving: when a device list holds entries differing only by case, today's two-pass code prefers the exact match's index, while a single `indexOf(.., true)` returns the earliest case-insensitive match (e.g. `"MIC"` against `["mic","MIC"]` stores `"MIC"` now, `"mic"` after). Practically rare on macOS, but a real, unprovable behavior change. (~14 lines)
- **`src/remote/RemoteCompanionServer.cpp:633` — yagni (JS `pcm16Base64FromSamples` wrapper).** The wrapper is genuinely a one-line passthrough, but the proposed inline is **broken**: line 623 binds `const pcm16Base64 = …`, so inlining creates a const self-reference and throws a TDZ `ReferenceError`, breaking live mic recording. A safe removal must also rename the local const. (~1 line)
- **`ui/src/hooks/useFileDrop.ts:1-125` — delete (drag-and-drop import hook).** Orphaned on the React side (never mounted in App.tsx), BUT the backing `import_clip_data` MoshOps command and its ~13 SelfTest assertions are **alive**, and FEATURE_AUDIT documents BRW-007 as a shipped feature. This reads as an incomplete/regressed landing (the hook's one-line mount is missing) — a *fix-by-mounting* decision, not a delete. (125 lines)
- **`ui/src/store.ts:58,129-130,197,446-458` — delete (`pluginBlocklist` + `loadBlocklist`/`clearBlocklist`).** Genuinely unwired UI plumbing, but `bridge.mock.test.ts`'s allowlist-staleness test asserts `get_plugin_blocklist`/`clear_plugin_blocklist` are still dispatched, and these are their only dispatch sites. Cutting the store lines alone fails vitest; needs a coupled edit to the allowlist test + the `PluginBlockEntry` import. (~18 lines)
- **`ui/src/settings/schema.ts:23,256-260` — delete (`"color"` SettingType + coerce case).** No descriptor uses `type:"color"`, but it is a coordinated 3-site/2-file edit (also `SettingsPanel.tsx:72-80`) under a tsc gate, and it is the same class of intentionally-extensible-but-unwired type as the documented forward-looking `gesture-table` slot — an author-intent judgment call. (~12 lines)
- **`ui/src/keymap.ts:20-84` — delete (parallel keymap runtime).** Dead production code superseded by `interaction/keymap.ts`, but removing it forces deleting `keymap.test.ts` (12 vitest tests). Deleting tests covering an unreachable impl is a human call per the test-protection rule. Keep `ActionId` (used by menuActions.ts). (~60 lines)
- **`ui/src/interaction/actions.ts:55-61` — delete (`ALL_ACTIONS` Set + `isEditorAction()` guard).** Zero production callers, but referenced by `actions.test.ts`; a bare line-range cut leaves dangling imports and breaks the 343-test suite. Needs a coordinated test-file edit. (~7 lines)
- **`ui/src/interaction/actions.ts:66-72` — delete (`REGIONS` const array).** Production uses region strings as inline literals; the `Region` type stays. Same problem: `actions.test.ts` imports `REGIONS` across 6 assertions, so the cut requires dropping that test block too. (~7 lines)
- **`ios/.../Services/BonjourBrowser.swift:30-34` — delete (`stop()`).** Never invoked (browser runs for app lifetime), but `stop()` is the symmetric teardown for `start()` — the conventional NWBrowser/OS-resource cleanup hook a future `scenePhase`/`onDisappear` would call. Near-zero-cost API symmetry; a judgment call, not clear-cut over-engineering. (~5 lines)

## What was checked and deliberately NOT flagged

Every finding was screened against Mosh's prime directives, and **prime-directive architecture was excluded by design.** Nothing in the confirmed set touches: the single mutation path (MoshOps `execute_command`), the one undo system (Tracktion `UndoManager`), the swappable command/snapshot+events seam, the Tier-B generative adapter seam (`service/adapters/*`), the ASTD safety-mapping layer, or the full-fingerprint cache. The contract guard `commands.contract.test.ts` parses `src/moshops/MoshOps.cpp` only — no flagged edit alters a command body or its argument reads, so the guard is untouched throughout. Test files were treated as protected: where a "dead" symbol is only referenced by its own test, the finding was marked risky (coordinated edit) rather than auto-safe, and no finding deletes test coverage of *reachable* behavior. Apparent duplication that is actually a deliberate symmetric facade (the LoRA trainer scaffold's twin `capabilities()`/passthrough getters) or a forward-looking extensibility slot (the self-describing settings schema's reserved types) was downgraded to needs-judgment rather than cut. The goal was a conservative, build-safe excision list — not maximal line count.
