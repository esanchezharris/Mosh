# Codex handoff — driving the First-Stranger Program

This is the entry point for **Codex** (or any agent that isn't the Claude `stranger-loop`) to do
the program work. The work is agent-agnostic on purpose: the spec, the backlog, and the per-lane
plans are plain files, and the gate is a shell command. You don't need the Claude Workflow runtime.

## The one rule

> **Implement a lane → run the gate → open a PR → never merge.** The owner merges.

The Claude loop auto-merges only *safe* (docs/ui/service-py) diffs and routes everything else to an
owner-merge PR. As Codex you skip that bucketing entirely: **always open a PR, never merge.** Most
lanes touch engine / `src/state` / auth / packaging / relay and are owner-gated by design.

## Do one lane

1. **Pick a lane.** The ready, unblocked lanes:
   ```sh
   AL_BACKLOG_JSONL="$PWD/docs/first-stranger-program/backlog.jsonl" \
     scripts/auto-loop/discover.sh ready | jq -r '.[] | "\(.id)\t\(.title)"'
   ```
   Or the owner names one. See `STATUS.md` for the board and which owner tasks (O1–O6) block what.
   Skip anything `status:blocked` — its `blockedOn` (an O-task or another lane) isn't cleared yet.

2. **Read its plan.** `docs/first-stranger-program/lanes/<fs-id>.md` — the gate-registered plan
   (context, the exact gate that proves it, the files, the §0 rules, the merge bucket). Also read
   `SPEC.md` §0 (the binding rules) and its lane section. If the plan says `gapExists = false`, the
   lane is already done — stop and tell the owner.

3. **Work in its own git worktree** (one lane per worktree — never cross lanes in a branch):
   ```sh
   git worktree add ../mosh-<fs-id> -b codex/<fs-id> origin/main
   ```

4. **Obey SPEC §0** (non-negotiable):
   - **MoshOps is the only mutation seam** — every user-visible change is a MoshOps command
     (validate → undo txn → events → JSONL → result). No direct Tracktion/state mutation.
   - **Nothing a build reads lives under `~/Documents`** — caches/artifacts go under `~/Library/Mosh/`.
   - **Build recipe** (verified):
     ```sh
     cmake --preset macos-arm64-release \
       -DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache \
       -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src
     ```
   - Keep the Info.plist TCC keys intact (the `MoshFixInfoPlist` step). Don't touch parked threads
     (`arena/`, the SA3-LoRA branch, FMS spike worktrees) or the **loop rulebook**
     (`scripts/auto-loop/*.sh`, `CLAUDE.md`, specs `00`–`06`, `cmake/Dependencies.cmake` + pins, `.github/`).

5. **TDD.** Write the failing gate/test **first** (a `Mosh --selftest` check / Catch2 for `src/`,
   vitest for `ui/`, a python unit for `service|relay`), confirm RED, implement to GREEN, keep it minimal.

6. **Gate — this is the merge gate.** One command runs the full authoritative gate:
   ```sh
   scripts/auto-loop/seed-cache.sh                                  # once: warm the dep cache
   scripts/auto-loop/gate.sh native ../mosh-<fs-id> origin/main     # build + Catch2 + selftest ×3 + verify.py
   ```
   It must be green with **`--selftest` ×3 deterministic** (identical check-count ≥ the spec floor
   ≈1254–1260, 0 failed, 0 JUCE assertions). For a `ui/`+`service/**.py`-only lane use `gate.sh cheap …`
   (typecheck + vitest + e2e). The quick local check in `AGENTS.md` (`Mosh --selftest`) is a subset.

7. **Open a PR, don't merge.**
   ```sh
   git -C ../mosh-<fs-id> push -u origin codex/<fs-id>
   gh pr create --draft --base main --head codex/<fs-id> \
     --title "codex(<FS-ID>): <title>" \
     --body "Lane <FS-ID>. Gate: <paste the ×3 tallies>. Blocked-on-owner: <O# or none>."
   ```
   Report the gate verdict + PR number. **Stop there — the owner reviews and merges.**

## Blocked-on-owner lanes

Some lanes can be *implemented* but not *gate-verified end-to-end* until the owner clears an O-task
(e.g. FS-T1's proxy needs O4's deployed Supabase function + commercial key; FS-K1/K2 need O1 Apple
Dev enrollment). For those: do the implementable code, run the *standard* gate (build + selftest — it
proves you didn't break `main`), open the PR, and note the outstanding blocker in the PR body. Don't
improvise around the blocker.

## One-command prompt

`scripts/first-stranger/codex-lane.sh <FS-ID>` prints a ready-to-paste prompt encoding all of the
above for a given lane (or `--next` for the next ready one). Add `--exec` to run it via
`codex exec` non-interactively (full-auto; the owner arms that). It never merges.

## What Codex does NOT inherit

The Claude `stranger-loop` orchestration — parallel multi-agent fan-out, the nightly launchd
auto-merge, the `.workflow.js` — is Claude-Code-specific and does not port. That's fine: it only ever
*auto-merged safe diffs*, and Codex opens PRs for everything anyway. The `codex-lane.sh` driver is the
sequential Codex analog (one lane at a time, PR-only).
