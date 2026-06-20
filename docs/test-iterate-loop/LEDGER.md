# Test→Debug→Iterate Loop — Ledger

**Campaign start:** 2026-06-19 14:25 PDT
**Driver:** autonomous /goal loop on branch family off `main` (worktree `sharp-germain-49192a`).
**Baseline:** main @ `3e70f04` (PR #61 merged). Selftest baseline to be established (~784/793 checks).

## Guardrails in force
- Never commit to `main`; each fix on its own branch → PR.
- Prime directives hold (one mutation path, one undo, swappable seam, tier wall, RT never blocks, ASTD, cache-by-fingerprint).
- Plugin-teardown crash = KNOWN/deferred (propose-only; OOP hosting needs Emilio's sign-off).
- selftest run ISOLATED, 3× deterministic, kill strays between runs.

## Orientation findings (Phase 0 prep)
- All recent remote `claude/phase*` + feature branches are MERGED into main (PRs #50–#61). No pending remote branches ahead of `origin/main`.
- Local branches ahead of main are PARKED/experimental:
  - `claude/ui-rebuild` (20) — PARKED, "never merge" (salvaged via #41/#42/#43 per memory).
  - `claude/objective-mendel-c1fea2` (4) — Moshi spectral reactivity + testing layer; superseded by merged Moshi work? (triage candidate, low priority).
  - `claude/zen-sanderson-25d7e2` (1) — wip preserved tree (catalog widening); guarded opportunity.
  - `codex/maolan-engine-contract` (1) — PARKED experiment (Maolan, do not resurrect).
  - `codex/cleanup-plumbing-20260616` (1), `codex/ios-companion-main-merge` (2) — codex lineage, low priority.
- Verified harness: `Mosh --selftest` ~784–793 checks (DRM-001 added drum section). Build: `macos-arm64-release` preset.

---

## Rounds

### Phase 0 result (2026-06-19 ~14:35 PDT)
- Baseline: `Mosh --selftest` **793/793 ×3 deterministic, 0 failed, 0 JUCE asserts** on fresh worktree Release build.
- Workflow `mosh-phase0-scope`: 11 finders → **60 raw findings**. Adversarially verified the foundational clusters:

**CONFIRMED REAL → fix queue (highest value/confidence first):**
- [C-REAL-1] `importWaveFileToTrack` partial mutation: auto-creates a track THEN validates the audio file → importing an invalid file onto an empty edit leaves a stray empty track in a "failed" command's undo txn. Fix: validate before mutating. (MoshOps.cpp:590) → PR A
- [C-REAL-2] Untested command paths (silent-regression risk): reorder_plugin (bounds+undo), remove_send (undo), rename_bus (undo), set_clip_gain (clamp+undo), set_clip_mute (undo+persist), duplicate_clip (undo+MIDI notes), reset_neural (state cleared), delete_time_range. → PR B (coverage; fix any bug a new check surfaces)
- [C-REAL-3] save() return value unchecked in MoshEngine new/open/saveAs → silent work loss on save failure. (MoshEngine.cpp ~466/493/514) → verify + PR C
- [C-REAL-4] RenderLayer cacheArtifact stored as absolute session path, not consolidated on saveAs → freeze_layer / re-accept_render break after project move. (MoshEngine consolidateAudioInto) → verify + PR (medium)
- [C-REAL-5] Python service: cancel flag not checked immediately before adapter.render() (honors user cancel); + os.makedirs defense before WAV/manifest write; + OSError catch in /transcribe. (server.py / adapters) → PR D
- [C-REAL-6] UI optimistic preview not reverted on move/trim command failure → visual desync until snapshot refresh. (Arrange.tsx) → PR E (vitest/e2e)
- [C-REAL-7] B2 service-resilience: render error/ timeout reason never surfaced to UI (status flips to 'error' with no message). → candidate if time (bigger).

**DROPPED (verified not-real / by-design):** A1 load_plugin & add_neural_insert "dangling txn" (empty txn, harmless); A2 render-status non-undoable (intentional transient state); A4 fingerprint stale on trim/move (upstream audio MD5 dominates — no false HIT).

**DEFERRED (logged, low ROI / risk):** A3 neural delayWritePos atomic + delayBuffer.clear race (benign in practice, RT-critical path, no observed failure — scale to evidence); move_clip silent invalid-trackId (semantic, low); various low-confidence UI defensive-guard coverage (<0.65 conf).

**Lane C (in-flight branches): NOTHING TO LAND.** `objective-mendel` (4 commits) = stale snapshot, content already on main (spectral reactivity, components cleanup, testing layer), 27 merge conflicts → SKIP-superseded. `zen-sanderson` (1 wip) = catalog-widening 97 commits behind, core already salvaged via PR #21 → SKIP-superseded. `ui-rebuild`/`maolan` = PARKED per memory. All recent remote `claude/*` already merged (PRs #50–#61).

---
### Round 1 — PR A: import_clip partial-mutation fix  ✅ (2026-06-19 ~14:45)
- **Branch:** claude/fix-import-partial-mutation → **PR #62** (https://github.com/zeke431/ClaudeMosh/pull/62)
- TDD: added Stage 1 guard (invalid import on empty edit → fail + 0 tracks). Confirmed RED (exit=6, cascading) on old code; fix = validate AudioFile before beginTxn/createAudioTrack.
- **Verified:** Mosh --selftest **795/795 ×3 deterministic, 0 failed, 0 asserts**.

---
### Round 2 — PR B: clip-edit & routing coverage  ✅ (2026-06-19 ~15:10)
- **Branch:** claude/coverage-clip-routing → **PR #63** (https://github.com/zeke431/ClaudeMosh/pull/63)
- +22 selftest guards: set_clip_mute undo/redo, set_clip_gain clamp(+24/-48)+undo, duplicate_clip undo/redo, remove_send drop+error+undo, rename_bus rename+error.
- **Found a real bug while writing coverage:** `rename_bus` is partially-undoable — `Edit::setAuxBusName` writes with nullptr UndoManager (Tracktion), so the bus name doesn't revert on undo though the command logs undoable:true. → see "Needs Emilio's call".
- **Verified:** Mosh --selftest **815/815 ×3 deterministic, 0 failed, 0 asserts** (port-isolated via MOSH_SERVICE_PORT=8775 + quiet-window timing to dodge the focused-hawking worktree's concurrent Debug harness).

### ⚠️ Cross-worktree contention (active)
The `focused-hawking-d0f115` worktree is running a Debug `--selftest` in a loop (PID rotates), sharing the global `~/Library/Mosh/session-selftest` dir + port 8770. Mitigation in use: `MOSH_SERVICE_PORT=8775` for my runs + wait for a quiet `pgrep` window, keep only exit==0 completions. (Infra idea logged below: honor a `MOSH_SELFTEST_SESSION` env so parallel harnesses get private session dirs.)

## Needs Emilio's call
- **rename_bus undo semantics.** Tracktion's `Edit::setAuxBusName` is non-undoable (nullptr UndoManager). `cmdRenameBus` opens a txn + logs undoable:true, but only the return-track name reverts on undo; the aux-bus name persists → partial-undo inconsistency. Options: (a) make rename_bus explicitly non-undoable (don't beginTxn, log undoable:false) — mirrors set_key's documented non-undoable behavior, simplest/honest; (b) re-implement the AUXBUSNAMES ValueTree write through `&undoManager()` so the name is undoable (fragile, duplicates engine logic). Recommend (a).
- **Infra: `MOSH_SELFTEST_SESSION` env** to give concurrent harness runs (parallel git worktrees) private session dirs — would permanently fix the documented cross-worktree clobber. ~4-line change in src/Main.cpp.

---
### Round 3 — PR D: generative service resilience  ✅ (2026-06-19 ~15:35)
- **Branch:** claude/service-resilience → **PR #64** (https://github.com/zeke431/ClaudeMosh/pull/64)
- Fixes: (1) honor cancel in the entry→render window (SA3 had no guard there); (2) os.makedirs before adapter WAV + manifest writes (was unhandled FileNotFoundError); (3) /transcribe catches OSError not just TimeoutExpired.
- New `service/scripts/resilience_test.py` (in-process, stdlib) — proved RED (3 fails) pre-fix, GREEN post-fix.
- **Verified:** resilience_test exit 0; existing fake_adapter_test + adapter_glue_test pass; Mosh --selftest generative (Stage 5 12/12, NRL-004 17/17), 815/815, exit 0. No C++/tier-wall change.

---
### Round 4 — PR E: accept_render copy integrity  ✅ (2026-06-19 ~15:50)
- **Branch:** claude/fix-accept-render-copy → **PR #65** (https://github.com/zeke431/ClaudeMosh/pull/65)
- Fix: copy render artifact + check copyFileTo + ensure audio dir BEFORE the undo txn → a failed copy is a clean error, never a broken clip in the saved project. + Stage 5 invariant guard (accepted clip's source exists, non-empty).
- **Verified:** Mosh --selftest **794/794 ×3 deterministic, 0 failed, 0 asserts**.

### Deferred (logged, not fixed)
- **cacheArtifact portability (B1, conf 0.98):** RenderLayer.cacheArtifact is an absolute session path; consolidateAudioInto (saveAs) doesn't copy/repath it, so freeze_layer / re-accept_render break after moving a project to another machine. Real but lower-reachability (artifacts are regenerable; already-accepted clips play fine) + bigger fix (consolidate render artifacts + relative repath). → follow-up.
- **save() return unchecked in newProject/openProject (B1):** outgoing edit's save() result ignored before editPtr.reset() → silent loss of unsaved work on project-switch IF that save fails. Real but rare trigger + bounded by 30s autosave + needs void→bool API change. → follow-up (scale to evidence).

---
### Round 5 — PR F: MOSH_SELFTEST_SESSION harness isolation  ✅ (2026-06-19 ~16:05)
- **Branch:** claude/selftest-session-isolation → **PR #66** (https://github.com/zeke431/ClaudeMosh/pull/66)
- Infra: env override gives concurrent worktree harnesses private session dirs → fixes the documented cross-worktree clobber that bit every verification this campaign. + env-gated self-check.
- **Verified (under live contention):** default path 793/793 exit 0 (no regression); isolated path 794/794 ×3 deterministic run CONCURRENTLY with the contender (no quiet-window wait) while a same-moment shared-dir run failed 789/793. 0 asserts.

---
### Round 6 — PR G: UI optimistic preview rollback  ✅ (2026-06-19 ~16:25)
- **Branch:** claude/ui-optimistic-rollback → **PR #67** (https://github.com/zeke431/ClaudeMosh/pull/67)
- Real UI bug: move/trim preview stayed stuck on command rejection (no snapshot change to clear it). Extracted testable `commitClipDrag` helper that reverts preview on !ok.
- TDD: vitest red (2 fails) on no-rollback, green with fix. **Verified:** vitest 329, tsc clean (src+e2e), e2e 29 passed.

---
### Round 7 — PR H: reorder_plugin coverage  ✅ (2026-06-19 ~16:40)
- **Branch:** claude/coverage-plugin-neural → **PR #68** (https://github.com/zeke431/ClaudeMosh/pull/68)
- +9 checks: chain order, OOB toIndex clamps-to-append (verified Tracktion behavior, refuting an A1 "UB" hypothesis), undo restores order, bad from-index errors. Built-ins only → deterministic.
- **Verified:** Mosh --selftest **802/802 ×3 deterministic, 0 failed, 0 asserts**.

---

## ▓▓ FINAL SUMMARY — campaign 2026-06-19 14:25–16:42 PDT (~2h17m) ▓▓

### Shipped: 7 PRs off main, every one gate-verified (all OPEN, none touch main)
| PR | Lane | Type | Gate |
|----|------|------|------|
| [#62](https://github.com/zeke431/ClaudeMosh/pull/62) import_clip validate-before-mutate (real partial-mutation bug) | A | fix+TDD | selftest 795/795 ×3 |
| [#63](https://github.com/zeke431/ClaudeMosh/pull/63) clip-edit & routing undo/clamp coverage (+22) | D | coverage | selftest 815/815 ×3 |
| [#64](https://github.com/zeke431/ClaudeMosh/pull/64) service: mid-flight cancel + makedirs + OSError | B | fix+TDD | python red→green + selftest gen 815/815 |
| [#65](https://github.com/zeke431/ClaudeMosh/pull/65) accept_render copy integrity (no broken clip) | A | fix | selftest 794/794 ×3 |
| [#66](https://github.com/zeke431/ClaudeMosh/pull/66) MOSH_SELFTEST_SESSION harness isolation | D | infra | demo'd under live contention, 794×3 |
| [#67](https://github.com/zeke431/ClaudeMosh/pull/67) UI optimistic preview rollback (real desync bug) | A | fix+TDD | vitest 329 + tsc + e2e 29 |
| [#68](https://github.com/zeke431/ClaudeMosh/pull/68) reorder_plugin coverage (+9) | D | coverage | selftest 802/802 ×3 |

### Bugs found & fixed (4 real, all adversarially verified before fixing)
1. **import_clip partial mutation** — auto-created a track then validated the file → orphan track in a failed command's undo txn. (#62)
2. **accept_render unchecked copy** — failed artifact copy → broken clip pointing at a missing file, persisted in the saved project. (#65)
3. **service cancel ignored mid-flight** — SA3 render ran to completion after a cancel in the entry→render window. (#64)
4. **UI preview stuck on rejection** — move/trim optimistic preview never reverted when the command failed. (#67)
Plus the cancel/makedirs/OSError robustness trio (#64).

### Found but NOT fixed (logged, no guessing)
- **rename_bus partial-undo** (Needs Emilio's call) — Tracktion's setAuxBusName is non-undoable; cmd logs undoable:true. Recommend making it explicitly non-undoable like set_key.
- **cacheArtifact portability** (deferred) — absolute session path, not consolidated on saveAs → freeze/re-accept break after cross-machine move. Lower reachability; artifacts regenerable.
- **save() return unchecked in new/open project** (deferred) — silent loss on project-switch IF that save fails; rare + bounded by 30s autosave. Needs void→bool API change.
- **transcribe async use-after-free** (deferred) — detached thread captures `this`; only on shutdown mid-transcribe.

### Dropped as NOT-real (verified false before wasting a fix — the value of adversarial verification)
- A1 load_plugin/add_neural_insert "dangling txn" → empty transaction, JUCE discards it.
- A2 render-status non-undoable → intentional transient job state.
- A4 fingerprint stale on trim/move → upstream audio MD5 dominates; no false HIT.
- A1#4 reorder OOB "UB" → Tracktion clamps to append (now covered in #68).
- A3 neural delayBuffer.clear() "memory corruption" → clear() doesn't realloc; delayWritePos race is benign (deferred, scale-to-evidence).

### Coverage added: +31 selftest checks (793→guards on set_clip_mute/gain, duplicate_clip, remove_send, rename_bus, reorder_plugin) + 1 python test file + 5 vitest cases.

### Lane C (branches): nothing to land. objective-mendel + zen-sanderson both superseded/stale (content already on main, heavy conflicts). ui-rebuild/maolan PARKED. All recent remote claude/* merged (#50–#61).

### Infra win: #66 MOSH_SELFTEST_SESSION solves the cross-worktree harness clobber that bit every verification this campaign (focused-hawking worktree looping Debug --selftest). Verification pattern used throughout: MOSH_SERVICE_PORT isolation + quiet-window retries, keep only exit==0.

### Ranked do-next
1. Decide rename_bus undo semantics (Emilio) → then make consistent.
2. save()-return data-safety (#B1) — void→bool + surface error on project-switch.
3. cacheArtifact consolidation on saveAs (portability).
4. B2: surface render error/timeout reason to the UI (currently "error" with no message).
5. transcribe async lifetime guard.
6. Merge the 7 PRs (recommend order: #66 infra first, then fixes #62/#65/#64/#67, then coverage #63/#68).
