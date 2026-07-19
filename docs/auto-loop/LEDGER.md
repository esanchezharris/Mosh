# Autonomous Deferred-Work Loop — Ledger

Append-only audit trail. One entry per merge / rejection / halt, written by
`scripts/auto-loop/merge-one.sh`. Extends the format of the prior campaign's ledger
(`docs/archive/test-iterate-loop/LEDGER.md`, PRs #62–#68).

**Driver:** the Workflow `.claude/workflows/auto-loop.workflow.js`, run locally on the
Mac. Auto-merges to `main` when the full gate is green + an adversarial self-review
approves. Fail-closed: anything else → PR left open, labeled `needs-human`, logged here.

## Guardrails in force
- Never commit to `main` directly; every change → branch → PR → squash-merge.
- Prime directives hold (one mutation path, one undo, swappable seam, tier wall, RT never
  blocks, ASTD defeatable, cache-by-full-fingerprint).
- Hard-exclusion paths are never auto-merged (dependency pins, CMake, deploy scripts,
  relay/Supabase auth, `src/plugins/hosting/**`, `MoshEngine`/`state` seams, specs, CI).
- Native selftest is ISOLATED (`MOSH_SELFTEST_SESSION` + `MOSH_SERVICE_PORT`), **×3
  deterministic**, 0 unexpected JUCE assertions, check-count ≥ baseline. A single flaky
  run never produces a merge.
- Kill switch: `docs/auto-loop/STOP`. Circuit-breaker: 3 consecutive merge failures → halt.

## Baseline
- _To be established on the first PREFLIGHT:_ `Mosh --selftest` check-count on `main`
  (the floor every native PR's ×3 must meet or exceed). Recorded here by the first cycle.

---

## Rounds

_(entries appended below by the loop)_

### 2026-06-23 21:45:24 PDT — PR #116: claude/auto-al-001  [MERGED ✅]
- **Branch:** claude/auto-al-001 → PR #116
- **Base:** origin/main @ b909e8a → squash-merged as cacb65c
- **Class:** cheap · gate: typecheck/vitest/e2e/swappability all ok (rebased + re-gated at merge time)
- **Review:** diffs read by Emilio's agent + loop independent adversarial review = APPROVE
- **Item:** AL-001 shared Escape stack (Esc closes only the topmost overlay)
- _Note: finalize reported a false failure (gh --delete-branch can't delete a worktree-checked-out branch); the merge itself succeeded. Fixed in merge-one.sh._

### 2026-06-23 21:45:24 PDT — PR #115: claude/auto-al-002  [MERGED ✅]
- **Branch:** claude/auto-al-002 → PR #115
- **Base:** origin/main @ cacb65c → squash-merged as bda1681
- **Class:** cheap · gate: typecheck:ok,vitest:ok,e2e:ok,swappability:ok (re-gated onto AL-001-merged main)
- **Review:** diffs read by Emilio's agent + loop adversarial review = APPROVE
- **Item:** AL-002 per-keymap rebind persistence (no cross-keymap bleed; v1→v2 migration)

**Gap in this ledger (2026-06-24 → 2026-07-16):** this file stopped being appended to per-round
after AL-002, even though dozens more `docs/auto-loop/backlog.jsonl` items merged in that window
(AL-003…AL-029, DRM-001/002, the 2026-07-10/11 hardening-sprint batch #289–#317, etc.) — see
[`PROGRESS.md`](../PROGRESS.md) for the authoritative per-milestone record of that work. Restoring
this file's per-round discipline is tracked informally; the entry below resumes it for the one
item in this session that came from `docs/auto-loop/backlog.jsonl` proper.

### 2026-07-17 10:50:37 PDT — PR #377: claude/auto-polish-warp-badge-position  [MERGED ✅]
- **Branch:** claude/auto-polish-warp-badge-position → PR #377
- **Base:** origin/main @ 7e2431bed → squash-merged as 40c206d43
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 10:54:31 PDT — PR #378: claude/auto-polish-v2-btn-disabled  [MERGED ✅]
- **Branch:** claude/auto-polish-v2-btn-disabled → PR #378
- **Base:** origin/main @ 40c206d43 → squash-merged as cd2a00e54
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 11:11:11 PDT — PR #380: claude/auto-polish-working-badge-reduced-motion  [MERGED ✅]
- **Branch:** claude/auto-polish-working-badge-reduced-motion → PR #380
- **Base:** origin/main @ cd2a00e54 → squash-merged as bf3c11669
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 11:31:59 PDT — PR #382: claude/auto-al-018  [MERGED ✅]
- **Branch:** claude/auto-al-018 → PR #382
- **Base:** origin/main @ bf3c1166 → squash-merged as 1d1930c5
- **Class:** cheap · gate: tsc:ok, vitest:ok (new `projectActionsUnification.test.ts` regression-covers
  a project action from each surface), no label/payload change
- **Review:** diffs read + adversarial review = APPROVE
- **Item:** AL-018 unify duplicated UI project-action dispatch (menu / shortcut / settings-panel
  now flow through one dispatcher; `ui/src/settings/SettingsPanel.tsx` + `ui/src/ui/TopbarTools.tsx`)

---

## Session digest — 2026-07-17 (throughput session, all merged to `main` same day)

Most of this session's merges came from sibling automation lanes outside this file's strict
`docs/auto-loop/backlog.jsonl` scope (an agentic/SFT lane using an `AG-*`/`FS-*` item-id
convention, and the `polish-loop`, which keeps its own log at
[`docs/polish-loop/polish-log.jsonl`](../polish-loop/polish-log.jsonl)) — logged here as a single
digest for one-stop throughput visibility rather than fabricated per-round entries this file's
generator (`scripts/auto-loop/merge-one.sh`) did not itself produce. Full descriptions are in the
[`PROGRESS.md`](../PROGRESS.md) 2026-07-17 entry.

- **Agentic/SFT lane, 12 PRs merged:** #365 AG-GUARD1, #366 FS-B0 (ownerMerge, wording
  pre-approved), #367 AG-ASSIST1, #368 AG-EVAL1, #369 AG-KB1, #370 AG-NOTE1, #371 AG-SK1,
  #372 AG-DOCS1, #373 FS-B1, #383 AG-KB-R2, #385 AG-KB3, #386 AG-EXEC1.
- **This ledger's own backlog, 1 PR merged:** #382 AL-018 (logged as its own round above).
- **polish-loop, 3 PRs merged (2 armed runs):** #377, #378, #380.
- **Open, native, owner-merge — explicitly NOT auto-merged:** #374 G7, #375 G1, #376 G4A, #384 G4b
  (stacked on #376). All four ran a partial local gate (Catch2/`MoshTests` + tsc/vitest green) but
  could not run the full `Mosh --selftest ×3` / `verify.py --gate` / e2e in-worktree — deferred to
  the owner per this ledger's fail-closed posture for native/high-stakes work.
- **Confirmed already-shipped, no PR opened:** FIT-003 (bounded plugin-scan — already landed via
  #348) and FS-T3 (project-file schema versioning — already satisfied by the June A1 hardening
  pass), both re-verified against `origin/main` rather than re-built.

### 2026-07-17 12:09:58 PDT — PR #389: claude/auto-polish-record-btn-aria-pressed  [MERGED ✅]
- **Branch:** claude/auto-polish-record-btn-aria-pressed → PR #389
- **Base:** origin/main @ 14cb71e1d → squash-merged as 27067ab40
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 12:13:29 PDT — PR #388: claude/auto-polish-lyric-fill-aria-label  [MERGED ✅]
- **Branch:** claude/auto-polish-lyric-fill-aria-label → PR #388
- **Base:** origin/main @ 27067ab40 → squash-merged as 4f21056b1
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 13:02:22 PDT — PR #391: claude/auto-polish-warp-apply-btn-class  [MERGED ✅]
- **Branch:** claude/auto-polish-warp-apply-btn-class → PR #391
- **Base:** origin/main @ 4f21056b1 → squash-merged as 16b48cbf6
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 13:05:47 PDT — PR #392: claude/auto-polish-clip-working-badge-status-role  [MERGED ✅]
- **Branch:** claude/auto-polish-clip-working-badge-status-role → PR #392
- **Base:** origin/main @ 16b48cbf6 → squash-merged as 162bb3217
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 13:25:52 PDT — PR #393: claude/auto-polish-takes-aria-pressed  [MERGED ✅]
- **Branch:** claude/auto-polish-takes-aria-pressed → PR #393
- **Base:** origin/main @ 162bb3217 → squash-merged as 7ace56656
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 13:44:20 PDT — PR #395: claude/auto-polish-v2-zoom-role-group  [MERGED ✅]
- **Branch:** claude/auto-polish-v2-zoom-role-group → PR #395
- **Base:** origin/main @ 7ace56656 → squash-merged as 32b4bec75
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 13:47:55 PDT — PR #396: claude/auto-polish-v2-composer-radius-token  [MERGED ✅]
- **Branch:** claude/auto-polish-v2-composer-radius-token → PR #396
- **Base:** origin/main @ 32b4bec75 → squash-merged as fa31ec3e4
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 14:12:57 PDT — PR #398: claude/auto-polish-rhyme-error-role-alert  [MERGED ✅]
- **Branch:** claude/auto-polish-rhyme-error-role-alert → PR #398
- **Base:** origin/main @ fa31ec3e4 → squash-merged as 0b6b1b347
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 14:39:10 PDT — PR #399: claude/auto-polish-empty-stage-role-status  [MERGED ✅]
- **Branch:** claude/auto-polish-empty-stage-role-status → PR #399
- **Base:** origin/main @ 0b6b1b347 → squash-merged as 353c09303
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 14:43:59 PDT — PR #400: claude/auto-polish-sel-header-accent-token  [MERGED ✅]
- **Branch:** claude/auto-polish-sel-header-accent-token → PR #400
- **Base:** origin/main @ 353c09303 → squash-merged as 1044a51b2
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 15:09:34 PDT — PR #402: claude/auto-polish-plugin-dock-empty-live-region  [MERGED ✅]
- **Branch:** claude/auto-polish-plugin-dock-empty-live-region → PR #402
- **Base:** origin/main @ 1044a51b2 → squash-merged as 5f428d1a0
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-17 15:36:00 PDT — PR #407: claude/auto-polish-fs-xl-transport-clock  [MERGED ✅]
- **Branch:** claude/auto-polish-fs-xl-transport-clock → PR #407
- **Base:** origin/main @ 5f428d1a0 → squash-merged as abf5e1495
- **Review:** APPROVE (polish-loop adversarial review)
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed

### 2026-07-18 — Full-repo audit pass (manual, not the loop)  [AUD-001..AUD-016 seeded]

Not a loop run: a requested full-repo audit, 10 parallel dimension auditors plus
independent verification of the highest-stakes claims. Findings that were confirmed
against code, CI logs or crash dumps are seeded as `AUD-*` rows in `backlog.jsonl`.

**Landed in the same pass** (PR #442):
- `main` had **no required status check** (`required_status_checks` → HTTP 404) despite
  `ci.yml:9` always naming the cheap gate as the intended one. That is why 40+
  consecutive red commits landed. Now required; `#403` (red) correctly reports `BLOCKED`.
- `merge-one.sh` no longer uses `--admin` — with `enforce_admins:true` it cannot bypass a
  required check, so every loop merge would have started failing. It now waits for the
  cheap gate and merges normally (fail-closed on failure/timeout/absent).
- `MOSH_SELFTEST_BASELINE` armed at **1656** (the hermetic CI count — a dev Mac reports
  ~1681 and pasting that number would red every run). The floor was implemented in
  `gate.sh` but never set anywhere, so a silent drop in check count was green.
- `docs/FEATURE_AUDIT.md` regenerated: **150/152, 0 gaps** vs the committed 134/152 with
  17 gaps. Every Export gap it listed had already shipped. A `daw_scoreboard_current`
  gate step now fails if the committed scoreboard drifts from the run.
- `CLAUDE.md` split 112 KB → 23 KB; 41 dated notes moved verbatim to `docs/worklog/`.

**Left open, deliberately:** `AUD-001`, the intermittent `--selftest` SIGSEGV that reds
main. It reproduces in CI (2 of 3 runs) but **not locally** — Debug+ASan is clean 3/3
serial and 5-way concurrent, and the Jul-16 Release binary is clean 6/6, which brackets
the regression to after 2026-07-16. No fix was written, because no root cause was
established. `macos-arm64-asan` / `-tsan` presets were added so the next attempt starts
with a tool rather than a guess.

**Not in scope, owner-gated:** `#403`/`#404`/`#405` are the First-Stranger critical path
(owner tasks O1/O4), not a backlog of loose ends.
