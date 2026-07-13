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
with mode 600, and `CN_HOME` must resolve outside both runner and canonical
control checkouts. Removing it
prevents new runs. Any of the following stop a live run before its next
state-changing supervisor action:

```text
~/Library/Mosh/automation/first-stranger-codex/STOP
docs/auto-loop/STOP
docs/first-stranger-program/STOP
```

For linked worktrees, the supervisor resolves the canonical control checkout
from the Git common directory's `config.worktree`. `CN_CONTROL_REPO` is an
explicit override. `check` and `status` report the resolved path and each STOP
source independently; missing or unreadable control/STOP state is fatal.

## Safety model

- One worktree and branch (`codex/stranger-<fs-id>`) are created per lane under
  `~/Library/Mosh/work/first-stranger-codex/`.
- Planning and implementation share one persisted Codex thread in that same
  worktree. Different selected lanes run as separate concurrent `codex exec`
  processes.
- All phases ignore user config and rules, pin the model/reasoning policy,
  capture JSONL, and require phase-specific JSON Schema output. The prepared
  native Codex permission profile allows reads only from the lane, Git's
  read-only shared object store,
  the minimal system runtime, and a private empty agent runtime. Planning and
  implementation may write the lane; hostile review receives read-only lane
  access. Every other user path is denied, and network is disabled.
- Agent PATH guards permit read-only git inspection, block git mutation, and
  block GitHub CLI access. The OS-enforced permission profile is the authority;
  the supervisor also rejects any unexpected agent-created commit or Git
  metadata rebinding. Shared Git metadata is read-only in every agent phase, so
  agents cannot plant hooks, edit config or refs, or alter another worktree.
  Runtime parents are read-only to the agent and every
  resumed HOME/TMP is revalidated as a real child directory. The profile adds
  read-only access only to the pinned command guards, the lock-stamped
  dependency target in the clean runner checkout, and the fixed Apple Silicon
  Homebrew runtime roots needed by Node, npm, TypeScript, Vitest, Playwright,
  and OpenSSL. Dependency writes,
  owner-home reads, and non-loopback network remain denied. The pinned npm
  guard uses `/bin/sh`, disables update checks, confines its cache to the
  private agent HOME, forces CI mode, and disables Vitest's dependency-local
  cache without changing Playwright invocations.
  Toolchain health also pins both agent/gate PATH values and resolves Node
  24.16.0, npm, and npm's command parser to the same reviewed Homebrew Cellar
  root. The Playwright cache is fixed to the local account's canonical
  `~/Library/Caches/ms-playwright` path, must not traverse a symlink, and must
  contain the Chromium 1228, Chromium headless-shell 1228, and FFmpeg 1011
  revisions declared by the lock-stamped Playwright package. Caller overrides
  or version drift make `check` fail.
- Real model execution is fail-closed. A live Codex 0.144.1 probe showed that
  the native file/network profile still permits a model-launched command to
  invoke macOS Keychain APIs. Wrapping Codex in a Mach-denying Seatbelt profile
  blocked that API but also made Codex's required nested lane sandbox fail.
  Therefore `check` reports `checks.agent_secret_boundary:false`, and armed
  `run` or `resume` stops before locking, worktree creation, fetch, or model
  invocation. Only the tightly bound, local-repository fixture can exercise
  orchestration without a model or GitHub. Its repository, common Git metadata,
  automation home, worktree root, Codex home, local bare remote, and executable
  stubs must all resolve inside one temporary fixture root. Production model execution requires
  a separately isolated agent backend; the credential-free gate worker below
  solves only gate execution and is not sufficient by itself.
- The routing guard is not a second test gate. It rejects never-touch paths,
  routes all non-safe product work to owner review, and permits `safe` only for
  `docs/**`, `ui/**`, and Python under `service/**`.
- The unchanged `scripts/auto-loop/gate.sh` remains authoritative and must both
  exit zero and emit `pass:true`. The supervisor runs it through macOS
  `sandbox-exec` with a scrubbed environment, reads limited to the exact
  worktree, owner-trusted lock-matched UI dependencies, Playwright browser
  cache, system/tool runtime, and fresh private HOME/TMP, and network denied
  except TCP loopback on Playwright's fixed port 5173. The lane worktree is
  read-only to the gate. A pinned npm guard forces
  Vite `strictPort`, so a raced-in listener makes the gate fail rather than
  silently moving the server. Before the gate, all agent-created ignored state
  is purged and trusted dependencies are rebound read-only; after the gate, all
  ignored state is purged again before hostile review. `check` compiles this
  profile before reporting it healthy. The supervisor rejects any gate-induced
  tracked change and accepts exactly one typed gate JSON object. PR-only v1 runs
  the full path only in hermetic tests. A live native-profile probe confirmed
  that the read-only Node/npm roots support TypeScript and focused Vitest, but
  the independent Keychain probe means that toolchain success is not a safe
  production agent boundary.
  Production gate execution is disabled by default, so every real lane stops at
  `needs-human` before gate execution. `check` reports
  `checks.gate_execution_enabled:false`. The test-only
  `CN_ENABLE_EXPERIMENTAL_SEATBELT_GATE=1` switch is never set by the supervisor,
  schedule example, or pilot and must not be treated as production support.
  Native and touched service-Python tests additionally need dynamic loopback
  isolation that Seatbelt cannot safely distinguish from owner-local services.
  A dedicated secret-free worker/VM and a safe agent-execution backend are both
  required before unattended draft publication is enabled. The
  implementation-ready, still-disabled gate-worker contract is documented in
  `GATE_WORKER_DESIGN.md`; its job and receipt schemas do not provision or
  enable a backend.
- The supervisor pushes `GATED_SHA:refs/heads/<lane-branch>`, reads the remote
  ref back, pins every GitHub call to the configured repository, and accepts a
  draft PR only when the remote base ref and GitHub `baseRefOid` equal the gated
  base SHA and its branch/head equal the gated head. Base drift or any existing
  draft mismatch makes the lane terminal `needs-human`.

Execution-only state and evidence live under:

```text
~/Library/Mosh/automation/first-stranger-codex/
  state/<fs-id>.json
  logs/<fs-id>/{plan,implement,gate,review,pr-body}.*
  agent-runtime/<fs-id>/worker/{home,tmp}/
  agent-runtime/<fs-id>/review/session.XXXXXX/{home,tmp}/
```

State files are mode 600 and bind the lane to its base SHA, current/gated head
SHA, exact worktree Git metadata, phase, and persisted thread ID. Conversation
resume is never treated as proof that git state is current; `resume` fetches and
rejects stale base/head, branch, or Git-binding state. Publication revalidates
the typed gate and hostile-review artifacts before any push.

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
bash scripts/first-stranger/codex-native/sandbox-test.sh
```

The first suite covers routing, sentinels, schemas, private/stale state, exact
remote SHA comparison, git/GitHub agent guards, read-only `check`, and unarmed
refusal. The hermetic integration test creates temporary repositories and stubs
Codex, GitHub, classifier, and gate behavior to prove the full draft-PR path
without touching a real branch, session, push, or PR.
The third suite uses `codex sandbox` directly, without a model, in a disposable
detached worktree. It proves the generated `cn_lane` profile supports the
pinned Node/npm toolchain, TypeScript, focused no-cache Vitest, and the
Playwright CLI while denying owner-auth reads, trusted-dependency writes, and
network access.

Both `check` and `status` expose `checks.agent_toolchain_profile` and
`checks.agent_secret_boundary` independently. The toolchain check is false if
the dependency root escapes the runner, its lock stamp drifts, or a required
Homebrew runtime root is missing, malformed, or unexpected. The secret-boundary
check is false in production until execution moves to the credential-free
worker. Either condition makes `check` exit nonzero without invoking a model.
