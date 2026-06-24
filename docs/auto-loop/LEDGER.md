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
