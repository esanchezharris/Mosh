# ClaudeMosh De-Slop Campaign

This ledger records the first review pass for the codebase cleanup campaign. It is
not an approval to bulk-edit the tree. Each source change still needs a focused
wave, behavior-lock coverage, and the class-correct gate.

## Workspace Guard

- Protected checkout: `/Users/emiliosanchez-harris/Documents/ClaudeMosh`
- Protected branch observed by the campaign: `codex/mosh-native-completion-debug`
- Campaign worktree: `.claude/worktrees/deslop-campaign-20260626`
- Campaign branch: `codex/deslop-campaign-20260626`
- Base: `origin/main` at `9429008d`
- Local evidence: `.omo/` remains untracked and local-only.

The campaign branch is an isolated infrastructure and backlog wave. It must not
absorb unrelated dirty work from the protected checkout.

## Baseline Before Edits

The following gates were run before source edits in the campaign worktree:

| Gate | Result |
| --- | --- |
| `git diff --check` | pass |
| Shell syntax on app/service/auto-loop scripts | pass |
| `npm --prefix ui run typecheck` | pass |
| `npm --prefix ui test` | pass, 557 passed and 1 skipped |
| `npm --prefix ui run test:e2e` | pass, 73 passed |
| `scripts/validate-command-log-contract.sh` | pass, 456 command records checked |
| `cmake --preset macos-arm64-release` | pass |
| `cmake --build --preset macos-arm64-release-app` | pass |
| `cmake --build --preset macos-arm64-release-tests` | pass |
| `ctest --test-dir build-macos-arm64-release --output-on-failure` | pass, 1/1 tests |

## Installed-App Lane

The native auto-loop gate proves the worktree build. It does not prove the
deployed `/Applications/Mosh.app`.

This campaign adds a manual installed-app gate wrapper at
`scripts/auto-loop/installed-app-gate.sh`. By default it runs:

1. `./run-mosh.sh deploy`
2. `codesign --verify --deep --strict /Applications/Mosh.app`
3. `/Applications/Mosh.app/Contents/MacOS/Mosh --selftest` three isolated times
4. `/Applications/Mosh.app/Contents/MacOS/Mosh --selftest-undo`
5. `MOSH_APP_BUNDLE=/Applications/Mosh.app python3 scripts/macos-ui-automation-gate.py`
6. `python3 scripts/verify-hardware/verify.py --bin /Applications/Mosh.app/Contents/MacOS/Mosh`

The wrapper also supports `--no-deploy` for inspecting the currently installed
app when the deploy path itself is under review. A no-deploy pass is actual-app
evidence, but it is not proof that the current branch was deployed.

## Verification After This Wave

| Gate | Result |
| --- | --- |
| `jq -c . docs/auto-loop/backlog.jsonl` | pass |
| `bash -n scripts/auto-loop/installed-app-gate.sh scripts/auto-loop/installed-app-gate-selftest.sh` | pass |
| `bash scripts/auto-loop/installed-app-gate-selftest.sh` | pass |
| `git diff --check` | pass |
| `scripts/auto-loop/gate.sh cheap . origin/main` | pass |
| Worktree Release `Mosh --selftest` | pass, 1009/1009 checks |
| `scripts/auto-loop/installed-app-gate.sh --no-deploy full` | fail on installed app |
| Computer Use `/Applications/Mosh.app` inspection | pass for launch surface, play, stop, and command-log drawer |

Installed app failure details:

- `codesign --verify --deep --strict /Applications/Mosh.app` failed with
  `code has no resources but signature indicates they must be present`.
- `/Applications/Mosh.app/Contents/MacOS/Mosh --selftest` failed consistently
  across three isolated runs: `1007/1009 checks passed, 2 failed`.
- The two installed-app selftest failures were in
  `Moshi brain proxy + native voice (packaged-app pieces)`:
  `brain: an incomplete requested provider falls back to a configured one` and
  `brain: nothing resolves when no key is set`.
- `/Applications/Mosh.app --selftest-undo` passed, 18/18 checks.
- `MOSH_APP_BUNDLE=/Applications/Mosh.app python3 scripts/macos-ui-automation-gate.py`
  passed.
- `python3 scripts/verify-hardware/verify.py --bin /Applications/Mosh.app/Contents/MacOS/Mosh`
  passed, 7/7 checks.

Because the worktree Release selftest passed and the installed app failed, this
wave treats the installed-app result as a package/deploy/environment blocker
rather than a source regression in the de-slop infrastructure changes.

## Review Findings

### Boundary Violations

| Backlog | Finding | Gate |
| --- | --- | --- |
| AL-010 | Live multiplayer commit callback applies `trackcommit::apply()` outside the `MoshOps::execute()` command envelope, despite an existing `apply_remote_track` command. | native |
| AL-012 | `WebBridge::serveUiResource` does not reject traversal outside the UI bundle. | native |
| AL-017 | `bridge.mock.ts` can silently succeed for unsupported mutating commands, including `paste_clip`. | cheap |

### Over-Defensive Code And Parse Boundaries

| Backlog | Finding | Gate |
| --- | --- | --- |
| AL-014 | `/training/import-registry` can treat malformed JSON as `{}` and persist an empty registry. | cheap |
| AL-015 | Corrupt rights or training state can be silently treated as valid empty state. | cheap |
| AL-022 | RAVE model/load failures collapse into broad catch-all failures without actionable diagnostics. | native |

### Duplication And Hidden Coupling

| Backlog | Finding | Gate |
| --- | --- | --- |
| AL-011 | Multiplayer lock classification duplicates dispatch metadata and misses scoped commands such as `paste_clip` and render-layer mutations. | native |
| AL-018 | Project/menu/shortcut actions are duplicated across UI surfaces instead of flowing through one action dispatcher. | cheap |
| AL-019 | `CommandLogTool` has render-time side effects and weak failure surfacing. | cheap |

### Data Correctness And Performance Equivalence

| Backlog | Finding | Gate |
| --- | --- | --- |
| AL-013 | Training source replacement returns the last source index instead of the replaced source index. | native |
| AL-016 | Training SHA-256 hashes entire source files in memory instead of streaming. | native |
| AL-020 | Multiplayer live smoke can exit 0 for `PARTIAL`, weakening the verification signal. | cheap |

### Gate And Deploy Hardening

| Backlog | Finding | Status |
| --- | --- | --- |
| AL-021 | Auto-loop selftest parsing needs a required baseline floor, durable gate artifacts, and explicit no-`.only`/skip checks. | needs-human |
| AL-023 | `run-mosh.sh deploy` removes `/Applications/Mosh.app` before replacement is proven and needs staged replacement semantics. | needs-human |
| AL-024 | Deploy/package flow can persist provider API keys into the app bundle by default and needs a secrets-safe bundle policy. | needs-human |
| AL-025 | Anira self-containment can suppress `install_name_tool` failures while claiming a self-contained bundle. | needs-human |

### Oversized Modules And Epics

These are review findings, not direct backlog work:

| Area | Status |
| --- | --- |
| `src/moshops/MoshOps.cpp` | Dedicated refactor epic only after seam coverage is improved. |
| `src/app/SelfTest.cpp` | Dedicated refactor epic only after selftest behavior is locked by sections. |
| `ui/src/vendor/moshi.js` | Treat as vendor-like; avoid cleanup unless behavior evidence demands it. |
| `service/server.py` | Split only behind focused route/state regression tests. |
| `scripts/macos-ui-automation-gate.py` | Split after installed-app QA artifacts and path-safety behavior are pinned. |

## Subagent Review Summary

Read-only audit agents covered native/C++ seams, React/UI, Python service,
scripts/deploy/gates, verification surface, and oversized-file inventory. Their
reports are claims until checked by focused tests and commands; the backlog only
accepts items with a one-wave verification path or marks them `needs-human`.

## Wave Rule

For each ready item:

1. Add or confirm a regression test first.
2. Keep public commands, snapshots, and events unchanged unless the change is
   additive and explicitly covered.
3. Run `scripts/auto-loop/classify.sh origin/main <worktree>`.
4. Run the class-correct `scripts/auto-loop/gate.sh`.
5. For native, app-bundle, deploy, UI, or audio-sensitive waves, run the
   installed-app lane and capture the resulting JSON/evidence.
