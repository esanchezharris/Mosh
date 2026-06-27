# Mosh Autonomous Deferred-Work Loop

A local, unattended loop that works the deferred backlog in parallel git worktrees,
opens PRs, and **auto-merges to `main` when the full verification gate is green and an
adversarial self-review approves**. Governing principle: **fail-closed** — any
ambiguity, flake, or unexpected condition means *do not merge* (leave the PR open,
label `needs-human`, log it, move on).

> Built from the approved plan `~/.claude/plans/is-the-mosh-app-drifting-bubble.md`
> and the proven precedent in `docs/archive/test-iterate-loop/LEDGER.md` (PRs #62–#68).

## TL;DR

```bash
# 0. one-time: warm the shared dep cache so worktree builds are incremental (long first run)
scripts/auto-loop/seed-cache.sh

# 1. establish the selftest baseline on main and run the loop (via the Workflow)
#    → launched with the Workflow tool: .claude/workflows/auto-loop.workflow.js
#    (or drive the scripts by hand — see "Manual operation" below)

# STOP anytime:
touch docs/auto-loop/STOP      # the loop drains the in-flight merge, then halts
rm    docs/auto-loop/STOP      # re-enable
```

## How it runs

One Mac, single-line `main` ⇒ **implementation fans out across parallel worktrees, but
build + selftest + merge run through a SERIALIZED merge-queue** (rebase → re-gate →
merge, one at a time). Every merge moves `main`, so the next item re-verifies on top.

```
PREFLIGHT  seed-cache.sh; baseline = Mosh --selftest check-count on main
LOAD       discover.sh ready → pick ≤3, cheap-class first, ≤1–2 native in flight
IMPLEMENT  (parallel worktrees) brainstorm/debug → TDD red → green → cheap gate →
           self-review → push branch → open DRAFT PR → enqueue
MERGE-QUEUE (serial) for each PR:
           merge-one.sh prepare  → rebase + classify(exclusion) + gate.sh
           → adversarial review (Workflow agent, default-to-REJECT)
           → merge-one.sh finalize  (gh pr merge --squash --admin) OR merge-one.sh reject
REFILL     if ready < threshold: bug-hunt fan-out → adversarial verify → discover.sh add
LOOP       until dry-after-empty-discovery | caps | STOP | 3 consecutive merge failures
```

## The gate (`gate.sh <cheap|native> <worktree>`)

Class is decided by `classify.sh` (fail-closed: unknown → native).

| class  | when                                                            | commands |
|--------|-----------------------------------------------------------------|----------|
| cheap  | every touched path ∈ `ui/`, `docs/`, `service/**.py`, `relay/**.py`, `scripts/auto-loop/` | `npm run typecheck` · `npm test` (vitest, incl. `commands.contract.test.ts`) · `npm run test:e2e` · touched-dir py tests · swappability **by classification** (no compiled paths ⇒ binary can't change) |
| native | anything under `src/`, `cmake/`, `CMakeLists.txt`/`CMakePresets.json`, `patches/`, `resources/`, `service/adapters\|colors\|sa3/` | configure+build (Release, dep-cache) · `ctest`/Catch2 · **`Mosh --selftest` ×3** · `verify.py` · `npm test` |

**The ×3 bar (load-bearing):** three isolated selftest runs (unique `MOSH_SELFTEST_SESSION`
+ `MOSH_SERVICE_PORT`), each must exit 0, report **F==0**, **0 `JUCE Assertion`**, identical
check-count N across all three, and **N ≥ baseline**. Non-determinism is a *defect* →
automatic REJECT; the loop never retries-until-three-agree.

## Auto-merge preconditions (ALL must hold)

Kill-switch absent · within budget · **zero exclusion-list paths** · merge-queue lock held ·
clean rebase onto latest `origin/main` with non-empty diff · class-correct gate fully green ·
×3 deterministic selftest (native) · swappability PASS (cheap) · contract test green ·
**adversarial review = APPROVE, 0 blockers** · re-check kill-switch + `origin/main` HEAD
unmoved immediately before merge.

## Hard exclusion list — always a PR, **never** auto-merged

`cmake/Dependencies.cmake` + version pins · `patches/**` · `CMakeLists.txt`/`CMakePresets.json` ·
`run-mosh.sh` + deploy/package scripts · `relay/server.py`/`room.py` + `supabase/migrations/**` +
any `*auth*`/`*token*`/`*secret*`/`*signed*`/`*credential*` path · `src/plugins/hosting/**`
(deferred OOP-crash class) · `src/engine/MoshEngine.{cpp,h}` + `src/state/**` (prime-directive
seams) · `CLAUDE.md` + specs `00`–`06` · `.github/**` · model-weight blobs. The loop **cannot
edit its own rulebook or gate.** (`classify.sh` flags these as `excluded:true`.)

## Kill switch & caps

- **`docs/auto-loop/STOP`** — checked at every iteration top *and* immediately before each
  merge. Present ⇒ finish the in-flight merge, enqueue nothing, halt. `docs/auto-loop/PAUSE`
  is a softer "don't start new work."
- Hard caps (configured in the Workflow): max merges / iterations / wall-clock + a
  circuit-breaker that halts after **3 consecutive merge failures**.
- Per-item: at most **1 self-fix attempt**, then escalate to `needs-human`.

## Files

| path | role |
|------|------|
| `scripts/auto-loop/lib.sh` | shared helpers (binary resolve, service/port cleanup, ledger, ui dep-drift detect) |
| `scripts/auto-loop/classify.sh` | change-class + exclusion detector (fail-closed) → JSON |
| `scripts/auto-loop/seed-cache.sh` | one-time: warm `.cpm-cache` + tracktion source → `~/.mosh-auto-loop/auto-loop.env` |
| `scripts/auto-loop/new-worktree.sh` / `rm-worktree.sh` | isolated worktree lifecycle |
| `scripts/auto-loop/gate.sh` | THE gate → machine-readable verdict JSON + exit code |
| `scripts/auto-loop/deps-freshness-selftest.sh` | unit test for the ui dep-drift detector (the shared-`node_modules` symlink trap) |
| `scripts/auto-loop/merge-one.sh` | merge-queue: `prepare` / `finalize` / `reject` |
| `scripts/auto-loop/discover.sh` | backlog store (`backlog.jsonl`) — list/ready/add/set-status |
| `docs/auto-loop/backlog.jsonl` | machine source of truth for WHAT (curated + discovered) |
| `docs/auto-loop/BACKLOG.md` | human-readable backlog (this seed + schema) |
| `docs/auto-loop/LEDGER.md` | append-only audit trail (one entry per merge/reject) |
| `docs/auto-loop/state.json` | live queue + per-item status (resume after restart) |
| `.claude/workflows/auto-loop.workflow.js` | the orchestrator (Workflow tool) |

## Manual operation (without the Workflow)

```bash
scripts/auto-loop/seed-cache.sh
WT=$(scripts/auto-loop/new-worktree.sh al-001)         # isolated worktree off origin/main
# … an agent implements AL-001 in $WT, commits, opens a draft PR #NN …
scripts/auto-loop/merge-one.sh prepare al-001 NN       # rebase + classify + gate → verdict JSON
# … review the diff; if good: …
scripts/auto-loop/merge-one.sh finalize al-001 NN <base_sha>
# … if not: …
scripts/auto-loop/merge-one.sh reject al-001 NN gate-red "selftest F=2 in run 2"
```

## Safety posture

Fail-closed everywhere: a false reject costs one `needs-human` label a human clears in
seconds; a false approve breaks an unattended `main`. The asymmetry justifies the
conservatism. Everything reuses gates the project already trusts (`--selftest` + its
`MOSH_SELFTEST_SESSION` isolation, `ctest`, `verify.py`, the contract test, the
swappability proof) — the loop only *composes* them; it invents no new gate.
