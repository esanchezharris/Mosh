# Multiplayer Demo Coordinator Loop

This is the on-demand Codex coordinator for pushing Mosh toward a usable
multiplayer demo. It is deliberately smaller and more conservative than
`docs/auto-loop/`: it coordinates threads, PRs, and backlog picks before it starts
new work.

The coordinator does not run `.claude/workflows/auto-loop.workflow.js`, does not
remove `docs/auto-loop/STOP`, and does not bypass the repo's local verification
rules. Treat the old auto-loop as a source of backlog and gate precedent, not as
the active controller for demo work.

## Scope

Prioritize multiplayer-core demo readiness:

- relay smoke reliability and honest pass/fail signals
- lock and commit correctness
- presence, sync, and collaboration UX needed for a two-player demo
- installed-app multiplayer proof
- small demo documentation that makes the path repeatable

Do not let non-core FMS, training, recipe-research, broad UI polish, deploy,
signing, or hardware-only work spawn new coordinator tasks unless it blocks the
multiplayer demo.

## State Files

- `state.schema.json` defines the pass snapshot shape.
- `passes/*.json` stores bounded dry-run or live-pass snapshots.
- `LEDGER.md` is append-only and summarizes each pass in human-readable form.
- `../../scripts/demo-loop/validate-state.py` is the dependency-free snapshot
  sanity checker.

Every pass should leave enough state for another Codex thread to resume without
guessing which PRs, threads, or backlog rows were canonical at the time.

Validate snapshots with:

```bash
python3 scripts/demo-loop/validate-state.py docs/demo-loop/passes/*.json
```

## Pass Order

1. Refresh trunk truth.
   - `git fetch --prune origin`
   - `git status --short --branch`
   - `gh pr list --state open --limit 50 --json number,title,headRefName,baseRefName,isDraft,mergeable,reviewDecision,createdAt,updatedAt,url`
   - read `docs/auto-loop/backlog.jsonl`
   - inspect `docs/auto-loop/STOP`
   - use Codex `list_threads` with a narrow `ClaudeMosh` query

2. Dedupe before opening work.
   - Continue canonical active threads when they already cover the work.
   - Archive only completed duplicates, and only after recording the reason in
     `LEDGER.md`.
   - Open a new worktree thread only for one bounded PR-sized gap, with a clear
     prompt, expected gate, stop condition, and demo relevance.

3. Triage PRs.
   - `merge-candidate`: low-risk, demo-relevant, fresh, non-draft, and ready for
     local gate plus review.
   - `needs-gate`: likely useful but missing required local proof.
   - `draft`: intentionally not merge-ready.
   - `parked`: non-core or source-material only.
   - `human-gated`: native/runtime/deploy/secret/hardware-sensitive, conflicting,
     or too broad for autonomous merge.

4. Pick the next multiplayer-core backlog item.
   - Prefer `AL-020` first because it only fixes a verification signal.
   - Treat `AL-011` and `AL-010` as human-gated native/runtime work even when the
     implementation looks small.
   - If a matching PR or active thread exists, continue that lane instead of
     creating a duplicate.

5. Record one of three outcomes.
   - `MERGE_PREPARED`: PR is locally gated and ready for the permitted merge path.
   - `THREAD_CREATED`: a bounded worktree thread was created with a PR-sized task.
   - `IDLE`: no safe merge or single bounded next step exists.

## Merge Policy

Auto-merge is allowed only for cheap docs, UI, scripts, or test-signal PRs after:

- clean rebase onto latest `origin/main`
- local gate matching the touched surface
- adversarial review with zero blockers
- expected head SHA check immediately before squash merge
- `docs/auto-loop/STOP` absent at the merge decision point

Never auto-merge:

- native multiplayer runtime changes
- `src/moshops/**`, engine state, undo, snapshot, or Tracktion seam changes
- deploy, signing, package, credential, token, or secret paths
- hardware-only verification paths
- old auto-loop rulebook/gate changes
- broad research, FMS, reward, or training stacks

For human-gated PRs, the coordinator may prepare evidence and recommend a merge,
but it must not merge.

## New Thread Prompt Contract

When a new thread is necessary, use this shape:

```text
TASK: Work in a fresh worktree from current origin/main. Implement <backlog id/title>
for the multiplayer demo coordinator.

Scope:
- one PR only
- expected changed paths: <paths>
- do not touch deploy, secrets, old auto-loop workflow, or unrelated dirty work

Required proof:
- <focused tests>
- <cheap/native/installed-app gate>
- final PR body includes exact commands and results

Stop if:
- existing PR/thread already covers this
- the task requires native/runtime human-gated merge approval
- the required gate cannot be run honestly
```

## First Queue

1. `AL-020` - fail `mp-live-smoke` on `PARTIAL`.
2. `AL-011` - cover multiplayer lock-classifier drift; human-gated native lane.
3. `AL-010` - route live multiplayer commits through MoshOps; human-gated runtime
   lane.

Only after those are resolved should the coordinator widen to demo-adjacent UI
polish, FMS, training, or recipe-research work.
