# React/UI De-Slop Audit - ClaudeMosh

## Status

- codeQualityStatus: BLOCK
- recommendation: REQUEST_CHANGES
- blockers:
  - The dev mock still reports success for at least one known mutating UI command (`paste_clip`) without applying behavior.
  - Project/menu/shortcut actions are split across multiple dispatch paths despite comments claiming a single action dispatcher.
- scope: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src`
- exclusions honored: `node_modules`, `dist`, `vendor`
- source edits: none
- tests run: none. The task constrained verification to non-mutating search/read commands; tests were inspected but not executed.

## Skill Perspective Check

- `omo:remove-ai-slops`: consulted. Violations found: oversized modules, duplicate action paths, over-defensive catch-and-swallow blocks, false-success mock behavior, test coverage that mirrors constants instead of locking behavior.
- `omo:programming`: consulted with the TypeScript reference. Violations found: files over the 250 pure-LOC ceiling, catch blocks without narrowing/rethrow in interior code, implementation-mirroring tests, and needless duplicate dispatcher logic.

## Commands / Evidence

- `rg -n "React|UI|deslop|MoshOps|ui/src|CURRENT_STATUS|shortcut|bridge" /Users/emiliosanchez-harris/.codex/memories/MEMORY.md`
- `sed -n '1,260p' /Users/emiliosanchez-harris/.codex/plugins/cache/sisyphuslabs/omo/4.13.0/skills/remove-ai-slops/SKILL.md`
- `sed -n '1,260p' /Users/emiliosanchez-harris/.codex/plugins/cache/sisyphuslabs/omo/4.13.0/skills/programming/SKILL.md`
- `sed -n '1,260p' /Users/emiliosanchez-harris/.codex/plugins/cache/sisyphuslabs/omo/4.13.0/skills/programming/references/typescript/README.md`
- `sed -n '1,260p' /Users/emiliosanchez-harris/.codex/plugins/cache/sisyphuslabs/omo/4.13.0/skills/programming/references/code-smells.md`
- `rg --files /Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src -g '!node_modules/**' -g '!dist/**' -g '!vendor/**'`
- `find /Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src -path '*/node_modules/*' -prune -o -path '*/dist/*' -prune -o -path '*/vendor/*' -prune -o -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | while IFS= read -r -d '' f; do loc=$(awk '!/^[[:space:]]*$/ && !/^[[:space:]]*(\/\/|#|--)/ { c++ } END { print c+0 }' "$f"); if [ "$loc" -gt 250 ]; then printf "%5d %s\n" "$loc" "$f"; fi; done | sort -nr`
- `rg -n 'catch\s*(\(|\{)|console\.(log|warn|error|debug)|TODO|FIXME|HACK|XXX|@ts-ignore|@ts-expect-error|as any|as unknown|throw new Error|throw "|throw '\''|!\.' /Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src -g '*.ts' -g '*.tsx' -g '!vendor/**' -g '!node_modules/**' -g '!dist/**'`
- `rg -n "useKeyboardShortcuts|runAction\(|MENU_SHORTCUTS|mosh_menu|SettingsPanel|new_project|save_as|open_project|open_recent" ...`
- `rg -n "import \{[^}]*executeCommand|executeCommand<|executeCommand\(" ...`
- `find ... -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -print | sort`

## Findings

### CRITICAL

None.

### HIGH

1. Dev mock can still produce false-success command behavior.

- evidence:
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/bridge.mock.ts:263` defines the monolithic `dispatch(command, args)` switch.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/bridge.mock.ts:1065` to `:1066` has `default: return ok(command)`.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/bridge.mock.test.ts:17` to `:28` explicitly allowlists `paste_clip` as a "KNOWN DEV-MOCK GAP" even though it mutates real session state.
- slop category: boundary violation, over-defensive false success, missing behavior coverage.
- behavior risk: the browser/dev UI can report success for a mutating command without changing the mock snapshot. This creates false confidence in UI paths that only get exercised against Vite/mock.
- coverage/tests found: `bridge.mock.test.ts` guards literal UI commands against uncased mock dispatch, but the allowlist preserves a known mutating gap. `menuActions.test.ts:114` to `:121` only asserts that paste routes to `store.pasteClipboard`, not that mock `paste_clip` mutates the session.
- one-wave acceptance criteria:
  - `paste_clip` has an explicit mock implementation or the UI no longer relies on it in dev.
  - `bridge.mock.ts` default no longer silently returns `ok` for unknown mutating commands; intentional read/no-op commands are explicit.
  - Tests prove paste changes the mock snapshot through the same `store.exec -> bridge.mock` path used by UI.

2. File/menu/shortcut actions are split across duplicate dispatchers despite a claimed single action path.

- evidence:
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/menuActions.ts:1` to `:4` says every File/Edit menu item and keyboard shortcut funnels through `runAction()`.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/ui/TopbarTools.tsx:69` to `:70` uses `runAction` for the File menu.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/settings/SettingsPanel.tsx:178` to `:189` duplicates New/Save/Save As/Open/Open Recent with direct `exec(...)` and direct picker calls.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/ui/Arrange.tsx:247` to `:313` maps keyboard actions directly to `s.exec(...)` and store helpers for overlapping actions such as undo/redo/save/delete/copy/cut/paste/play.
- slop category: duplicate shortcut/action paths, boundary control drift.
- behavior risk: File menu, Settings project buttons, native menu, and dev keyboard can drift in command args, refresh timing, picker behavior, and delete/paste semantics. This directly threatens the "UI mutates only through one MoshOps action surface" rule, even though each individual call still goes through `store.exec`.
- coverage/tests found: `menuActions.test.ts:36` to `:141` covers `runAction`; `interaction/keymap.test.ts:46` to `:117` covers key resolution. No `SettingsPanel`/`Arrange` component or parity test was found for the actual duplicated dispatch paths.
- one-wave acceptance criteria:
  - Project actions in `SettingsPanel` route through `runAction` or are removed from Settings.
  - Overlapping keyboard actions in `Arrange` either call the same action executor or have a focused parity test that proves command args, refresh behavior, and modal suppression match the canonical path.
  - A regression test fails if a File/Edit action is added to one path but not the canonical dispatcher.

### MEDIUM

1. Multiple UI files exceed the 250 pure-LOC ceiling.

- evidence:
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/bridge.mock.ts`: 972 pure LOC.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/ui/Arrange.tsx`: 703 pure LOC.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/store.ts`: 554 pure LOC.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/ui/TopbarTools.tsx`: 395 pure LOC.
  - Additional over-limit files: `types.ts` 322, `ui/Moshi.tsx` 265, `ui/Dock.tsx` 255, `settings/schema.ts` 251.
- slop category: oversized modules.
- behavior risk: reviewability is low in exactly the files that own command mocking, arrangement interactions, store orchestration, and topbar tools. Small behavior changes are likely to land near unrelated responsibilities.
- coverage/tests found: there are 62 test files in scope, but coverage is uneven. There are utility tests for many extracted helpers; there are no `Arrange`, `TopbarTools`, `Moshi`, or `SettingsPanel` component tests found.
- one-wave acceptance criteria:
  - Split `bridge.mock.ts` by command domain with an explicit dispatcher table and no default false success.
  - Split `Arrange.tsx` into keyboard, ruler/lane gestures, track headers, clip cards, and modal helpers while keeping mutations behind `store.exec`.
  - Split `store.ts` into Zustand slices or cohesive helper modules for snapshot refresh, selection/clipboard, multiplayer, plugin catalogs, routing/devices, and view/theme bridge.
  - Each split has import-level tests or existing behavior tests proving no command/snapshot contract drift.

2. `Moshi.tsx` catches and swallows integration errors across nearly every vendor API call.

- evidence:
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/ui/Moshi.tsx:87` to `:108` catches construction failures and only nulls refs.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/ui/Moshi.tsx:111` to `:131` catches and swallows voice/body reaction failures.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/ui/Moshi.tsx:163` to `:173`, `:222` to `:223`, `:234` to `:247`, `:282` to `:297`, and `:337` repeat no-op catches around routine calls.
- slop category: over-defensive catches, oversized component, missing tests.
- behavior risk: if the vendored Moshi/voice APIs regress or throw on a state transition, the UI silently degrades with no user-visible state and no test signal. This is especially risky because the file owns always-on voice affordances and reactive agent feedback.
- coverage/tests found: search found settings/voice tests and `agent/voiceInput.continuous.test.ts`, but no `Moshi` tests or fake `window.Moshi`/`window.MoshiVoice` behavior tests.
- one-wave acceptance criteria:
  - Wrap vendored Moshi/voice calls in a small typed adapter that narrows known missing-API/startup failures and surfaces unexpected failures to `lastError` or a local disabled state.
  - Keep only justified boundary catches for vendor initialization/destruction.
  - Add component/adapter tests using fake `window.Moshi` and `window.MoshiVoice` that prove voice toggles, render state, cleanup, and failure handling.

3. Command log popover starts async loading during render and can get stuck loading on bridge rejection.

- evidence:
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/ui/TopbarTools.tsx:342` to `:346` defines `CommandLogTool` and `load`.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/ui/TopbarTools.tsx:350` to `:352` calls `void load()` from render when the popover body renders.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/ui/TopbarTools.tsx:346` sets `loading` false only after `exec("get_command_log")` resolves successfully.
- slop category: side effect during render, over-defensive missing error boundary, missing tests.
- behavior risk: a rejected bridge call leaves `loading` true and can retry from render on re-entry; React render should stay pure, and command-log errors should not wedge the popover.
- coverage/tests found: no `TopbarTools`, `CommandLogTool`, or command-log component tests found. `bridge.mock.ts:655` has a mock command-log case, but no UI error/loading behavior coverage.
- one-wave acceptance criteria:
  - Move command-log loading to an open-triggered `useEffect` or explicit refresh handler.
  - Use `try/finally` to clear loading and surface failure through `lastError` or local error text.
  - Add a test with a rejecting `exec` fake that proves no render-time loop and loading resets.

### LOW

1. `interaction/actions.test.ts` mostly mirrors implementation constants rather than behavior.

- evidence:
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/interaction/actions.test.ts:10` to `:18` asserts selected `EditorAction` keys exist.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/interaction/actions.test.ts:21` to `:24` asserts string values are unique.
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/ui/src/interaction/actions.ts:10` to `:53` is the exact constant under test.
- slop category: implementation-mirroring/tautological test.
- behavior risk: this test can stay green while an action maps to the wrong command, is never executable, or drifts from `runAction`.
- coverage/tests found: useful behavior tests exist for key resolution (`interaction/keymap.test.ts`) and menu dispatch (`menuActions.test.ts`), but no test ties `EditorAction` keyboard actions to actual command behavior.
- one-wave acceptance criteria:
  - Replace or supplement constant-existence checks with an execution/parity test for keyboard actions that overlap File/Edit actions.
  - Keep the uniqueness test only if persisted action strings are part of the public storage contract.

## Backlog Notes

- `store.ts` centralizes many valid app responsibilities but currently mixes bridge execution, snapshot pruning, peak loading, clipboard, multiplayer, plugin catalog, device/routing, and settings mirrors. Treat this as a planned refactor, not a drive-by cleanup.
- Many `catch {}` sites are legitimate browser/vendor boundaries (`localStorage`, pointer capture, Web Speech stop/abort). Do not remove them mechanically. The high-value cleanup is to narrow or centralize repeated catches where unexpected failure changes user-visible state.
