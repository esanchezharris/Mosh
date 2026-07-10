# The Consolidation Loop — clearing a backlog of PRs/branches safely

*Codified from the 2026-07-09 Codex→Claude consolidation (ledger: `docs/CONSOLIDATION_2026-07-09.md`).
Paste-able into any session, any agent. The bar is fail-closed: nothing merges without the gate.*

## Standing per-PR procedure

1. **Re-check state right before acting** — `git fetch` + `gh pr view` (a concurrent session may
   have moved main or the PR).
2. **Stage the true merge result**: in a worktree OUTSIDE iCloud (`git worktree add
   ~/Library/Mosh/work/gate --detach origin/main`), `git merge origin/<pr-branch>`.
   **Never trust `-q`/`| tail` on the merge command** — check `git status` for `UU` files
   explicitly; a masked conflict once ran a whole gate on a marker-polluted tree.
3. **Read the full diff yourself** (`gh pr diff N`). Codex/other-agent PR descriptions are
   honest but incomplete — look for smuggled hunks (files the title doesn't explain), and
   check whether a "clean" auto-merge silently dropped a sibling PR's semantics in files
   both touched (read the merged function, not just the diff).
4. **Tiered gate, scaled to the diff** (quote outputs in the ledger, never "should pass"):
   - always: `tsc --noEmit` + full vitest (`--pool=forks --maxWorkers=1 --minWorkers=1`)
   - UI touched: Playwright e2e on `ui/playwright.isolated.config.ts` (port 5191); if a spec
     fails, A/B it against plain main in the SAME environment before blaming the PR —
     background builds/transfers on the box produce 30s-timeout flakes
   - native touched: Catch2 + `Mosh --selftest` ×3 deterministic
     (`MOSH_NO_AUDIO=1 MOSH_ENABLE_SA3=0 MOSH_ENABLE_TRANSFORM=0 MOSH_ENABLE_SOULX=0`,
     unique `MOSH_SELFTEST_SESSION` + `MOSH_SERVICE_PORT` per run) + assertion/leak scan
     (`grep -c juce_UndoManager`, `VST3HostContextHeadless`)
   - engine `patches/` touched: apply to the deps clone with `git apply --unidiff-zero`,
     fresh-configure gotcha: `FETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE` **bypasses
     PATCH_COMMAND** — patch the source copy yourself
   - service touched: the relevant `*_test.py` goldens ×3 + `bash -n` on shell scripts
   - audio-adjacent: `verify.py --gate`
5. **Green ⇒ squash-merge** (`gh pr merge N --squash --delete-branch`), tick the ledger.
   - Stacked PRs: squash-merging the BASE auto-closes the stacked PR — re-land it by
     cherry-picking onto main (`git cherry-pick <tip>` → push → new PR → merge).
6. **Red ⇒ smallest honest fix on the PR branch** (push a commit, re-gate) if the failure is
   mechanical; **park with findings** (comment on the PR: what failed, the revive checklist)
   if it needs a product/taste decision; **close with a written reason** if superseded.
   Never delete the only copy of unmerged work — park keeps the branch.

## Branch triage rules (no-PR branches)

- `git rev-list --count origin/main..origin/<b>` per branch. 0 ahead ⇒ delete.
- Ahead + a MERGED PR maps to the branch (`gh pr list --state merged --limit 200
  --json headRefName`) ⇒ delete. Ahead + open PR ⇒ leave until the PR resolves.
- Ahead + no PR ⇒ read `git log -1 --format='%ad %s'`: real unmerged fixes become PRs
  into the queue; superseded/parked history gets `archive/<name>` tag + branch delete;
  unknown-but-recent gets kept + listed in the report.
- Worktrees: commit+push any dirty state FIRST (durability before judgment), then
  `git worktree remove` + delete merged local branches.

## Traps hit on 2026-07-09 (do not re-hit)

- zsh: `$var:refs/...` triggers the `:r` history modifier — use `${var}:refs/...`;
  `$SSH_LINE` unsplit — call binaries with explicit args.
- Pipeline exit codes: `cmd | tail -3 && echo OK` prints OK on failure. Capture
  `echo "step=$?"` per step, no pipes on gating commands.
- `grep -c X file || true` in a summary line: exit 1 when count is 0 — harmless but makes
  the wrapper look failed; don't let it be the last command.
- iCloud (~/Documents) actively corrupts `.git` (loose objects vanish, " 2" ref/file
  duplicates, deleted paths resurrect). The store now lives at
  `~/Library/Mosh/repo/ClaudeMosh.git` (worktrees point at it via `gitdir:` files).
  Never move it back; keep heavy build/gate work under `~/Library/Mosh/work/`.
- macOS has no `timeout`; background long jobs and poll their logs.
- The e2e dev server vs preview split: specs must pass in BOTH `npm run dev` mode and
  `MOSH_E2E_PREVIEW=1` where the PR claims preview support.

## Definition of done

`gh pr list` shows only intentionally-parked PRs (each carrying a park comment with a
revive checklist); `git ls-remote --heads` has no branch without a disposition; every
merge line in the ledger quotes its gate numbers.
