# ClaudeMosh Native Seam/Slop Audit

Scope: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626`, first-party C++/ObjC++ under `src/` and `tests`.

Read-only source posture: no source or test files were edited. This report artifact was written under `.omo/evidence` as the required review deliverable.

Branch/status observed: `codex/deslop-campaign-20260626...origin/main`; pre-existing untracked files were present under `.omo/evidence/` and `scripts/auto-loop/`.

codeQualityStatus: BLOCK

recommendation: REQUEST_CHANGES

blockers:

- HIGH-1 should be fixed or explicitly waived before approving this cleanup campaign as seam-safe: a live multiplayer commit callback mutates the Edit outside `MoshOps::execute()` even though a command wrapper already exists.

Skill-perspective check:

- `omo:remove-ai-slops` was loaded and applied. Violations found: boundary violation, duplicated classification/list metadata, missing focused tests, broad catch without diagnostics, and performance-equivalent full-file hashing.
- `omo:programming` was loaded and applied, including `references/code-smells.md`. Violations found: mutation outside the command boundary, parse/boundary checks missing in the WebBridge resource seam, brittle hidden coupling between command dispatch and lock classification, and tests that cover only happy paths for several native seams.
- No diff was provided for approval. This is a codebase audit report; the violations below are backlog findings in the inspected tree.

Commands/evidence used:

```sh
git status --short --branch
find src tests -type f \( -name '*.cpp' -o -name '*.mm' -o -name '*.h' -o -name '*.hpp' \) -not -path '*/.cpm-cache/*' -not -path '*/build/*' | wc -l
wc -l src/moshops/MoshOps.cpp src/app/SelfTest.cpp src/remote/RemoteCompanionServer.cpp src/training/TrainerRegistry.cpp src/webview/WebBridge.cpp tests/test_remote_companion.cpp
nl -ba src/moshops/MoshOps.cpp | sed -n '154,196p'
nl -ba src/moshops/MoshOps.cpp | sed -n '414,437p'
nl -ba src/moshops/MoshOps.cpp | sed -n '1488,1511p'
nl -ba src/moshops/MoshOps.cpp | sed -n '1772,1820p'
nl -ba src/multiplayer/TrackCommit.cpp | sed -n '19,76p'
nl -ba src/multiplayer/LockManager.cpp | sed -n '1,90p'
nl -ba src/webview/WebBridge.cpp | sed -n '74,105p'
nl -ba src/app/MenuController.cpp | sed -n '64,119p'
nl -ba src/remote/RemoteCompanionServer.cpp | sed -n '217,246p'
nl -ba src/remote/RemoteCompanionServer.cpp | sed -n '443,452p'
nl -ba src/training/TrainerRegistry.cpp | sed -n '132,138p'
nl -ba src/training/TrainerRegistry.cpp | sed -n '214,262p'
nl -ba src/plugins/transform/RaveEngine.cpp | sed -n '78,112p'
nl -ba src/app/SelfTest.cpp | sed -n '3925,3958p'
nl -ba src/app/SelfTest.cpp | sed -n '4341,4402p'
nl -ba tests/test_multiplayer_lock_manager.cpp | sed -n '1,70p'
nl -ba tests/test_remote_companion.cpp | sed -n '46,95p'
nl -ba tests/test_training.cpp | sed -n '67,135p'
rg -n "\"paste_clip\"|\"set_render_param\"|\"render_layer\"|\"sketch_beatbox\"|\"accept_render\"|\"freeze_layer\"|\"bounce_layer_to_clip\"|\"bypass_layer\"|\"remove_render_layer\"|\"create_render_layer\"" src/moshops/MoshOps.cpp src/multiplayer/LockManager.cpp
rg -n "serveUiResource|WebBridge|resource provider|pick_files|execute_command" src tests --glob '*.{cpp,mm,h,hpp}'
rg -n "open_recent|open_project" src/app src/moshops tests --glob '*.{cpp,mm,h,hpp}'
rg -n "RaveEngine|load_rave_model|MOSH_HAVE_ANIRA|loadModel" src tests --glob '*.{cpp,mm,h,hpp}'
```

## Findings

### CRITICAL

None.

### HIGH

#### HIGH-1: live multiplayer commit callback bypasses the MoshOps command chokepoint

- Evidence: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/moshops/MoshOps.cpp:167` installs the live `MultiplayerSession` commit callback; lines 181-184 call `trackcommit::apply(eng.edit(), ...)`, `eng.markDirty()`, and `emitSnapshotInvalidated()` directly.
- Related seam evidence: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/moshops/MoshOps.cpp:414` is `MoshOps::execute()`, the lock-guard command chokepoint; `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/moshops/MoshOps.cpp:1488` is the existing `cmdApplyRemoteTrack()` wrapper for the same peer-commit mutation.
- Mutation primitive: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/multiplayer/TrackCommit.cpp:49`, `:60`, `:61`, and `:70` remap and splice Tracktion `ValueTree` state with a `nullptr` undo manager.
- Slop category: boundary violation; duplicated command seam; direct Tracktion mutation outside the advertised `MoshOps::execute()` envelope.
- Behavior risk: live remote track commits can bypass command-wide lock/instrumentation/log/result semantics. The no-undo posture may be intentional for incoming peer history, but the callback path should still route through the existing command wrapper or a single explicitly named remote-apply seam.
- Existing coverage: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/app/SelfTest.cpp:3927` covers `apply_remote_track` behavior and undo invisibility; `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/app/SelfTest.cpp:4393` applies a wire-delivered commit through the command. I did not find coverage for the actual constructor callback path at `MoshOps.cpp:167`.
- Safe for one PR-sized cleanup wave: yes. Route the callback through the existing wrapper or `execute()` under the remote-apply flag, then add one focused live-callback/relay regression test. No public command/snapshot/event contract change is required.

### MEDIUM

#### MEDIUM-1: `mp_apply_bootstrap` performs a multi-step raw project rebuild inside one command

- Evidence: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/moshops/MoshOps.cpp:1772` implements `cmdMpApplyBootstrap`; lines 1777-1782 remove tracks via raw parent `removeChild(..., nullptr)`, line 1802 applies each track blob through `trackcommit::apply`, and lines 1809-1814 remove/append annotations directly.
- Slop category: boundary exception and raw mutation cluster.
- Behavior risk: this is at least inside a named command, but the rebuild is a compound raw Tracktion mutation with partial-failure ambiguity and no explicit transaction object/posture beyond comments. That makes future multiplayer state, logging, and error handling harder to reason about.
- Existing coverage: selftest has a "Multiplayer: project bootstrap (P6)" section and command coverage for `mp_serialize_project`/`mp_apply_bootstrap`, but the checked evidence was behavior-level, not a seam-level assertion that partial adoption, no-undo posture, and event emission stay intentional.
- Safe for one PR-sized cleanup wave: maybe. Keep behavior unchanged; extract/document a single internal "incoming history apply" helper and add focused regression coverage. Do not change public snapshot/event contracts.

#### MEDIUM-2: lock classification duplicates command dispatch and misses obvious scoped commands

- Evidence: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/multiplayer/LockManager.cpp:18`, `:41`, and `:56` maintain independent string sets. `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/moshops/MoshOps.cpp:477` dispatches `paste_clip`, lines 529-538 dispatch render-layer commands, and line 524 dispatches `sketch_beatbox`; the `rg` evidence shows only `create_render_layer` appears in `LockManager.cpp:60`.
- Slop category: duplication, hidden coupling, missing coverage.
- Behavior risk: fail-closed default prevents unsafe concurrent edits but can over-block legitimate track/clip-scoped work during multiplayer. Future commands can silently become session-global unless a developer remembers the second table.
- Existing coverage: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/tests/test_multiplayer_lock_manager.cpp:11` spot-checks representative command classes and fail-closed behavior; it does not assert dispatch/classifier coverage or classify the commands above.
- Safe for one PR-sized cleanup wave: yes. Add a small coverage test for known scoped commands or a shared command metadata source. Keep unknown commands fail-closed.

#### MEDIUM-3: WebBridge resource provider lacks a traversal boundary check

- Evidence: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/webview/WebBridge.cpp:74` implements `serveUiResource`; line 84 strips a leading slash and line 85 calls `uiDir.getChildFile(rel)` without rejecting `..`, absolute paths, or canonical paths outside `uiDir`.
- Slop category: parse/boundary validation missing at native resource seam.
- Behavior risk: crafted resource URLs from dev UI or compromised web content may be able to address files outside the staged UI bundle depending on JUCE path normalization and resource-provider URL behavior.
- Existing coverage: `rg -n "serveUiResource|WebBridge|resource provider|pick_files|execute_command" src tests --glob '*.{cpp,mm,h,hpp}'` found implementation references but no direct test file exercising `serveUiResource` path handling.
- Safe for one PR-sized cleanup wave: yes. Add a small normalization/rejection helper and focused traversal/fallback tests; this can be additive and local to WebBridge.

#### MEDIUM-4: authenticated remote companion `/command` is an unrestricted MoshOps tunnel

- Evidence: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/remote/RemoteCompanionServer.cpp:240` accepts `POST /command`, line 242 extracts any command object, and line 245 passes it to `commandHandler`. `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/remote/RemoteCompanionServer.cpp:450` returns `Access-Control-Allow-Origin: *`.
- Slop category: boundary too broad; capability leakage.
- Behavior risk: a paired companion token appears to authorize arbitrary DAW commands, not just transport/take/monitor-style companion actions. This may be deliberate, but it expands the blast radius of any companion/browser token.
- Existing coverage: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/tests/test_remote_companion.cpp:46` verifies unauthenticated rejection and authenticated `set_transport` routing. I did not find tests for an allowlist/capability boundary.
- Safe for one PR-sized cleanup wave: no without a product decision. A safe additive wave would introduce capability metadata or allowlist mode while preserving the current generic command path until the companion contract is decided.

#### MEDIUM-5: training source replacement returns the wrong index

- Evidence: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/training/TrainerRegistry.cpp:247` searches for an existing source id and line 252 replaces it in place, but line 261 always returns `sourceSummary(..., sources.size() - 1, true)`.
- Slop category: missing negative/update test; bookkeeping bug.
- Behavior risk: updating an existing source can return the last list index instead of the replaced source index, which can mislead UI selection or automation even if persisted registry data is correct.
- Existing coverage: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/tests/test_training.cpp:67` is a smoke flow for first import, approval, corpus build, fake training, and activation. It does not import the same `sourceId` twice or assert replacement index.
- Safe for one PR-sized cleanup wave: yes. Track the replacement index and add one focused replacement test.

### LOW

#### LOW-1: native Open Recent menu bypasses the safer `open_recent` by-index command

- Evidence: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/app/MenuController.cpp:107` handles recent-menu item selection; lines 112-118 resolve the path from the snapshot and fire `open_project`. The backend by-index command lives at `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/moshops/MoshOps.cpp:5688`.
- Slop category: seam mismatch and duplicated path resolution.
- Behavior risk: the native menu loses the backend's by-index recent-list resolution and command identity; stale snapshot paths can be passed as `open_project` instead of preserving the `open_recent` semantics already covered elsewhere.
- Existing coverage: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/app/SelfTest.cpp:2399` covers `open_recent` by index and invalid index cases. I did not find native `MenuController` action coverage.
- Safe for one PR-sized cleanup wave: yes, but may require a small UI/action payload adjustment so the native action can carry the index.

#### LOW-2: training SHA-256 loads whole source files into memory

- Evidence: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/training/TrainerRegistry.cpp:132` implements `sha256File`; lines 134-137 load the full file into a `MemoryBlock` before hashing.
- Slop category: performance equivalence / hidden scaling cost.
- Behavior risk: real training sources can be large WAV/stem files; corpus build can allocate hundreds of MB per file just to hash content.
- Existing coverage: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/tests/test_training.cpp:74` uses a tiny dummy file, so it will not expose memory pressure.
- Safe for one PR-sized cleanup wave: yes. Switch to a streaming hash path and keep manifest output unchanged.

#### LOW-3: RAVE engine catches all native model/load failures without diagnostics

- Evidence: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/plugins/transform/RaveEngine.cpp:78` implements `prepare`, with `catch (...) {}` at line 90. `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/src/plugins/transform/RaveEngine.cpp:94` implements `loadModel`, with `catch (...)` returning `false` at lines 109-112.
- Slop category: over-defensive broad catch; missing observability.
- Behavior risk: model shape/backend errors collapse to a generic load failure, making native model problems hard to diagnose and distinguish from missing files or unsupported builds.
- Existing coverage: `rg -n "RaveEngine|load_rave_model|MOSH_HAVE_ANIRA|loadModel" src tests --glob '*.{cpp,mm,h,hpp}'` found implementation references and MoshOps dispatch but no dedicated RAVE test coverage in `tests/`; the feature is gated by `MOSH_HAVE_ANIRA`.
- Safe for one PR-sized cleanup wave: maybe. Add internal last-error/log diagnostics behind the existing API first; avoid changing public command contracts unless additive and tested.

## Scope-Control Notes

- `src/moshops/MoshOps.cpp` and `src/app/SelfTest.cpp` are oversized (`6680` and `5211` lines by `wc -l`). Per task instruction, I am not recommending blind file splitting. Treat them as refactor epics only after behavior seams above are covered.
- The strongest one-wave candidate is HIGH-1 because it has a clear existing command wrapper, concrete seam evidence, and focused coverage path.
