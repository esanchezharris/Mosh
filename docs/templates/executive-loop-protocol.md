# Executive Loop Protocol

Use this template when running a conservative executive loop against Mosh. Keep it
repo-visible, additive, and read-only unless the task explicitly authorizes a change.

## 1. Trunk First

- Start from a clean branch or worktree off `origin/main`.
- Fetch trunk before deciding anything: `git fetch origin --prune`.
- Treat `origin/main` as the only trunk truth.
- Preserve unrelated dirty work and evidence; do not overwrite or delete it.

## 2. Merge Discipline

- Prefer small, reviewable changes.
- Use squash-merge only for low-risk, bounded work that already passed the required gate.
- Do not merge stale WIP history, old branch stacks, or copied PR context.
- Rebase or refresh onto the latest `origin/main` immediately before merge.
- Fail closed on ambiguity, flakiness, missing proof, or unclear ownership.

## 3. Human-Gated Surfaces

Do not auto-touch or auto-merge these surfaces without an explicit human decision:

- Native audio/runtime code
- Secrets, signing, deploy, or credential material
- Production reward / GRPO / training control paths
- Hardware-gated verification or device-only proof
- `.claude/workflows/auto-loop.workflow.js`
- Any other repo rulebook or gate file

## 4. Duplicate Guard

- Check whether the same source thread, task, or PR already exists before starting work.
- If a duplicate thread or PR is found, stop the duplicate path and continue from the canonical one.
- Prefer one live thread and one PR per bounded task.

## 5. Memory Entry Format

If you need a memory note, keep it small and explicit:

```md
- [project / task] short summary
  - desc: one-sentence reason this note matters
  - learnings: one or two concrete takeaways
  - risks: only if there is a real blocker or drift risk
```

- Use a timestamped filename and a short slug.
- Keep the note focused on durable context, not the whole conversation.

## 6. Final Reporting Checklist

Before you finish, report all of the following:

- `MERGED/CHANGED` files
- `VERIFICATION` performed
- `BLOCKERS` that remain
- `PR URL` if one was opened
- Any residual risk or skipped check

## 7. Stop Conditions

Stop and escalate if the task requires:

- Owner input
- Secrets or credentials
- Destructive cleanup
- Hardware-only validation
- Re-arming or invoking the loop workflow script
