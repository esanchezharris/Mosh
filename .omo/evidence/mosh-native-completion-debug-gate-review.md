# Gate Review: Mosh Native Completion Debug Plan

recommendation: APPROVE

originalIntent: Verify the branch `codex/mosh-native-completion-debug` as the final gate for fixing the native master-meter clipping issue, proving Space toggles transport in `/Applications/Mosh.app`, hardening deploy/codesign/xattr behavior, and preserving existing local merge gates after the final comment-only keymap cleanup.

desiredOutcome: The rebuilt and redeployed `/Applications/Mosh.app` contains the staged UI and bundled service, is ad-hoc signed, xattr-clean, and code-signature-valid; the topbar master meter remains bounded during clipping playback; Space in the installed app records `set_transport {"action":"toggle"}`; targeted UI, native build, installed selftest 3x, undo, ctest, and command-log gates all pass with current evidence.

userOutcomeReview: PASS. The final post-keymap evidence is current and complete. Manual/native evidence predates the comment-only `ui/src/interaction/keymap.ts` cleanup, but the post-comment rebuilt UI hash matches the installed UI hash (`db0997...` in `installed-app-match-final-post-keymap-comment.txt:5-7`), so the prior screenshots/log-tail remain valid for the same shipped UI bundle.

blockers: none

summary:
- Meter bounds: PASS via `Meter.tsx:44`, `mosh.css:410`, meter RED/GREEN, and `manual-final-launchctl-playing.png`.
- Installed native Space: PASS via `MenuController.cpp:158-164`, `MenuController.cpp:186-189`, `menuActions.ts:123-124`, and manual command-log toggle lines.
- Deploy/install: PASS via `deploy-final-post-keymap-comment.txt`, `codesign-xattr-pycache-final-post-keymap-comment.txt:1-5`, `installed-app-match-final-post-keymap-comment.txt:5-21`, and independent codesign/xattr/hash checks.
- Gates: PASS via targeted UI 49/49, UI build, Release build/restage, installed selftest 3x `1008/1008`, undo 18/18, ctest 100%, command-log contract, and clean `git diff --check`.
- remove-ai-slops/programming: PASS. No skipped tests, `.only`, type suppressions, fake-only proof, stale final evidence, or unnecessary production abstraction found. One `Meter.test.ts` selector assertion is implementation-proximal but accepted because real-surface and runtime DOM evidence are the approval basis.

checkedArtifactPaths:
- `run-mosh.sh`
- `service/run.sh`
- `src/app/MenuController.cpp`
- `src/app/MenuController.h`
- `src/app/SelfTest.cpp`
- `ui/src/hooks/useKeyboardShortcuts.ts`
- `ui/src/hooks/useKeyboardShortcuts.test.ts`
- `ui/src/interaction/keymap.ts`
- `ui/src/ui/Arrange.tsx`
- `ui/src/ui/Meter.tsx`
- `ui/src/ui/Meter.test.ts`
- `ui/src/ui/mosh.css`
- `.omo/ultrawork/evidence/reviewer.md`
- `.omo/ultrawork/evidence/targeted-ui-tests-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/ui-build-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/cmake-release-build-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/deploy-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/installed-selftest-3x-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/installed-selftest-undo-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/ctest-release-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/validate-command-log-contract-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/codesign-xattr-pycache-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/installed-app-match-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/git-diff-check-final-after-all-gates.txt`
- `.omo/ultrawork/evidence/manual-final-launchctl-playing.png`
- `.omo/ultrawork/evidence/manual-final-launchctl-space-log-tail.txt`
- `.omo/ultrawork/evidence/manual-final-launchctl-stopped.png`
- `.omo/ultrawork/evidence/manual-final-launchctl-stop-log-tail.txt`

exactEvidenceGaps: none blocking.

residualRisks:
- Native text-field Space behavior with a non-empty Moshi prompt is covered by the WebView-level unit test, not a separate installed-app manual typing capture.
- `Meter.test.ts` includes one selector-text assertion; it is acceptable here because real-surface screenshot evidence and runtime class behavior are the approval basis.
- `ui/src/ui/Arrange.tsx` is still oversized pre-existing code; this branch reduces its shortcut responsibility but does not refactor the module.
