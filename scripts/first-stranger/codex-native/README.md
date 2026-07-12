# Codex-native First-Stranger prototype

This is an additive, PR-only supervisor. It does not replace or modify the Claude
`stranger-loop`, the classic auto-loop, their classifier, or their gate. It has no
merge operation.

## Commands

```sh
bash scripts/first-stranger/codex-native-loop.sh check
bash scripts/first-stranger/codex-native-loop.sh status
bash scripts/first-stranger/codex-native-loop.sh run --lane FS-B1
bash scripts/first-stranger/codex-native-loop.sh run --next --max-items 2
bash scripts/first-stranger/codex-native-loop.sh resume FS-B1
```

With no command, the entrypoint performs the read-only `check`. `run` and
`resume` refuse before creating a worktree or Codex session unless this
machine-local file already exists:

```text
~/Library/Mosh/automation/first-stranger-codex/ARMED
```

The repository and this PR do not create that file. The owner may create it
manually after reviewing the supervisor. It must be a regular, non-symlink file
with mode 600, and `CN_HOME` must resolve outside the repository. Removing it
prevents new runs. Any of the following stop a live run before its next
state-changing supervisor action:

```text
~/Library/Mosh/automation/first-stranger-codex/STOP
docs/auto-loop/STOP
docs/first-stranger-program/STOP
```

## Safety model

- One worktree and branch (`codex/stranger-<fs-id>`) are created per lane under
  `~/Library/Mosh/work/first-stranger-codex/`.
- Planning and implementation share one persisted Codex thread in that same
  worktree. Different selected lanes run as separate concurrent `codex exec`
  processes.
- All phases ignore user config, pin the model/reasoning policy, capture JSONL,
  and require phase-specific JSON Schema output. Planning/implementation use
  `workspace-write`; hostile review is a fresh `read-only` session.
- Agent PATH guards permit read-only git inspection, block git mutation, and
  block GitHub CLI access. The workspace-write sandbox also has network access
  disabled. The supervisor rejects any unexpected agent-created commit.
- The routing guard is not a second test gate. It rejects never-touch paths,
  routes all non-safe product work to owner review, and permits `safe` only for
  `docs/**`, `ui/**`, and Python under `service/**`.
- The unchanged `scripts/auto-loop/gate.sh` remains authoritative. Native lanes
  additionally require `MOSH_SELFTEST_BASELINE` to be set.
- The supervisor pushes `GATED_SHA:refs/heads/<lane-branch>`, reads the remote
  ref back, and opens a draft PR only when the SHAs match.

Execution-only state and evidence live under:

```text
~/Library/Mosh/automation/first-stranger-codex/
  state/<fs-id>.json
  logs/<fs-id>/{plan,implement,gate,review,pr-body}.*
```

State files are mode 600 and bind the lane to its base SHA, current/gated head
SHA, phase, and persisted thread ID. Conversation resume is never treated as
proof that git state is current; `resume` rejects stale SHA state.

## Optional desktop schedule (not installed)

If the owner later opts in, create a Codex desktop scheduled task whose project
is a dedicated, clean worktree containing this supervisor and whose instruction
is:

```text
Run: bash scripts/first-stranger/codex-native-loop.sh run --next --max-items 2
Report the resulting draft PR URLs or the fail-closed refusal. Do not create the
ARMED sentinel, do not merge, and do not modify the primary checkout.
```

The task remains inert until the owner separately creates the external `ARMED`
file. Scheduling is not a safety boundary and must not be used to bypass a STOP.

## Verification

```sh
bash scripts/first-stranger/codex-native/test.sh
bash scripts/first-stranger/codex-native/integration-test.sh
```

The first suite covers routing, sentinels, schemas, private/stale state, exact
remote SHA comparison, git/GitHub agent guards, read-only `check`, and unarmed
refusal. The hermetic integration test creates temporary repositories and stubs
Codex, GitHub, classifier, and gate behavior to prove the full draft-PR path
without touching a real branch, session, push, or PR.
