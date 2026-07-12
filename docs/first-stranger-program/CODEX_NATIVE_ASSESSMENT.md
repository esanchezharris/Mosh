# Codex-native First-Stranger assessment

**Assessment date:** 2026-07-12

**Live Codex tested:** `codex-cli 0.144.1`

**Recommendation:** **(c) hybrid**, with a deliberately PR-only Codex v1

## What `stranger-loop` does, and why

The `stranger-loop` is intended to turn the six-week First-Stranger spec into continuous, auditable progress by reading the file-backed backlog, gap-verifying and planning ready lanes, implementing each lane in an isolated worktree, running the existing local gate plus hostile review, and then auto-merging only low-risk docs/UI/service-Python changes while routing engine, state, auth, packaging, CMake, and relay changes to owner-merge PRs; its unarmed nightly mode rehearses planning, while sentinels control live execution and shutdown. The reason for the loop is sound: the program has many dependency-ordered lanes, several owner blockers, no hosted merge gate that should be trusted, and a hard six-week window, so progress needs to be repeatable without making the agent—not the spec, backlog, lane plans, and local gate—the authority.

## Native capability mapping

The checks below came from the live CLI/help and a real `exec` → `exec resume` probe, not recollection. The probe emitted `thread.started`, produced schema-valid output, and resumed the same persisted session successfully.

| Claude Workflow feature | Current native Codex mechanism | What is equivalent | Limitation / difference |
|---|---|---|---|
| Parallel multi-agent fan-out | Native subagents and custom agent roles; this Codex app exposes `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, and related controls. Codex configuration also supports agent role profiles and concurrency/depth limits. | Independent agents can work concurrently with different instructions and tool policies. [Subagents](https://learn.chatgpt.com/codex/agent-configuration/subagents) | Direct subagent responses are not independently constrained by a JSON Schema. The documented CSV fan-out facility is experimental and was not exposed in this live tool surface. It should not be the production foundation of this loop. |
| Schema-validated structured output | `codex exec --output-schema FILE -o FILE` plus `--json` JSONL events | The terminal response is schema-constrained; the event stream is machine-readable. [Non-interactive mode](https://learn.chatgpt.com/codex/non-interactive-mode) | Schema enforcement is per top-level `exec`/`resume`, not per internal subagent. A supervisor still has to reject missing/invalid event or result files. |
| Resume from cache | Persisted session/thread IDs and `codex exec resume SESSION_ID`; `thread.started` exposes the ID | Later phases can continue the same conversation and retry a phase with its prior context. The live probe succeeded. | This is **conversation resume, not workflow-cache resume**. Codex does not natively know that a lane's base SHA, head SHA, phase output, or gate evidence is still valid. The supervisor must persist and validate that state. |
| Declarative phases / cached DAG | No production-ready direct equivalent in the CLI | SDK/app-server clients can build a phase machine around `exec`; JSONL makes observation practical. [Codex SDK](https://learn.chatgpt.com/codex/codex-sdk) | Codex has no Claude-Workflow-equivalent declarative, cache-aware phase graph here. Phase ordering, invalidation, retries, locks, and terminal states are application code. This is Codex's largest weakness for this use case. |
| Nightly scheduling | Codex desktop scheduled tasks / automations | The desktop app can wake an isolated task on a schedule. [Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app) | `codex` CLI has no built-in cron/launchd scheduler. Scheduling does not make an unsafe supervisor safe, and the task must remain inert without an external owner sentinel. |
| Lifecycle hooks | Codex hooks configured around lifecycle events | Hooks can observe or enforce policy at defined lifecycle points. [Hooks](https://learn.chatgpt.com/codex/hooks) | Hooks are not a workflow DAG, transaction manager, or merge authorization mechanism. User hooks also create configuration/trust variability, so this prototype ignores user config and keeps critical checks in deterministic shell. |
| Profiles / specialist roles | CLI config/profile layers (`-p`, `-c`) and custom agent role configuration | Fixed model/reasoning/sandbox settings and specialist instructions are native. | Profiles are configuration, not durable lane state. User profiles can drift; unattended execution should pin overrides and ignore user config. |
| MCP | Native MCP client/server configuration and CLI management | Codex can call external tools and services through MCP. | MCP expands capability and attack surface; First-Stranger's program truth should remain files, and git/GitHub mutation should remain in the deterministic supervisor. MCP is not needed for v1. |
| Isolation | `codex exec -C WORKTREE -s workspace-write` and `-s read-only`; git worktrees remain the repository-native isolation boundary | Each lane can have a separate filesystem root and sandbox; review can be strictly read-only. | Codex does not itself enforce “one lane per worktree.” The supervisor must create and bind the worktree, prevent cross-lane reuse, and verify the agent did not commit. |
| Programmatic orchestration | Codex SDK and app-server APIs; JSONL `exec` is also a stable shell integration point | Codex is stronger than a UI-only agent because a small supervisor can own state, events, schemas, and retries without parsing prose. | Building a full Workflow clone would duplicate a mature phase/cache system. The justified slice is a narrow PR supervisor, not a general workflow framework. |

### Where Codex is stronger

- Schema-constrained top-level CLI output and JSONL event streaming make a deterministic shell supervisor straightforward.
- Persisted session IDs give an explicit, tested continuation mechanism across plan and implementation phases.
- Read-only versus workspace-write sandboxes can be selected per phase, and user configuration can be excluded.
- Native subagents are available interactively without introducing program-specific agent state into the repository.
- The SDK/app-server path leaves room to replace the shell supervisor later if phase durability becomes a real bottleneck.

### Where Codex is weaker

- There is no native declarative phase graph with cache invalidation equivalent to the Claude Workflow used here.
- Resume preserves conversation context, not proof that a phase is still valid against the same git objects.
- Subagent fan-out does not provide per-child schema contracts in the live surface.
- Scheduling is a desktop facility, not a CLI orchestration primitive, and is not a safety boundary.
- Experimental bulk fan-out is not an acceptable dependency for unattended repository mutation.

## Review of PR #320's Claude design

The program artifacts are useful: `SPEC.md`, `backlog.jsonl`, and the lane plans form a legible, agent-agnostic execution contract. The orchestrator's intent to separate planning, implementation, gating, hostile review, and owner routing is also correct. I would **not install or arm the loop in its current form**, because several implementation details make the unattended auto-merge claim less fail-closed than the prose says. These observations are against [PR #320](https://github.com/zeke431/ClaudeMosh/pull/320) at head `315eab5c`.

1. `scripts/auto-loop/classify.sh` declares `relay/**/*.py` and `scripts/auto-loop/*` cheap-eligible. That conflicts with the stated safe allowlist (`docs/**`, `ui/**`, `service/**/*.py`) and lets the loop's own control code enter the cheapest class.
2. `MOSH_STRANGER_MODE=1` in `merge-one.sh` converts excluded changes into owner routes. That is reasonable for engine/auth/packaging product work, but wrong for rulebook changes: gate scripts, `CLAUDE.md`, specs 00–06, CMake pins, and `.github/**` should be hard rejected, not turned into a mergeable owner PR by the same loop.
3. A failed rebased-branch push is only warned about. `finalize` later verifies the base SHA but not that the PR's current head is the exact SHA that passed the gate and hostile review. A moved/replaced PR head could therefore be merged after different content was gated.
4. The program-specific `docs/first-stranger-program/STOP` sentinel is not rechecked inside `finalize`, leaving a state-changing tail after the program has been stopped.
5. The live sentinel is repository-local (`docs/first-stranger-program/ARMED`), falls under the docs allowlist, and has no deterministic “this change cannot arm the loop” guard. A merged lane could self-arm a later nightly run.
6. Planning writes lane plans in the active checkout, but implementation creates a separate worktree from `origin/main`. A newly generated plan is not present in that worktree, and planning/implementation are not one lane in one worktree as SPEC §0 requires.
7. “Plan-only” and status refresh mutate tracked files in the active checkout without a branch/cleanliness/freshness preflight or a whole-run lock. On the owner's dirty primary checkout that risks mixing automation state with unrelated work.
8. Backlog, ledger, and status mutations are local and uncommitted, so their state is neither durable nor guaranteed to match the PR. Duplicate-lane detection only recognizes the classic `auto(...)` title convention and omits Codex-titled lane PRs.
9. The native class in `gate.sh` runs build/Catch2/selftest/verification/conformance/vitest, but omits Python tests, TypeScript checking, and Playwright even though the Workflow describes the full SPEC §0 battery. The gate must remain the single gate, but its claimed coverage should match what it actually runs.
10. `lanes/fs-k3.md` tries to avoid the CMake-pin prohibition by moving the Sentry pin to a new CMake file; that changes the location, not the prohibited act. `lanes/fs-t2.md` also reopens settled SPEC wording around the recovery journal and save prompt. Lane plans may refine execution, but may not override the decision-complete spec.
11. Live GitHub metadata on PR #320 showed paid `macos-14` hosted runners, while repository policy says hosted Actions were removed and may not be re-enabled without a budget decision. Those results can be informational, but they cannot substitute for the local gate or silently reverse the policy.
12. Owner-route completion is incomplete operationally: the owner PR may exist while backlog/ledger/status remain stale, which weakens the advertised audit trail.
13. The existing `codex-lane.sh --exec` path uses the dangerous sandbox/approval bypass in the active repository. It is acceptable only as an explicit human-invoked compatibility driver, not as the unattended native foundation.

The most serious defects are the gated-head race, mutable in-repo arming, rulebook changes becoming owner routes, and planning outside the lane worktree. Together they mean the current loop can perform a state-changing action on content or authority that was not the content or authority actually reviewed.

## Recommendation: hybrid, PR-only Codex v1

Keep the Claude Workflow and `codex-lane.sh` unchanged for compatibility, but do not install or arm the Claude loop as currently written. Add a narrow Codex-native supervisor that uses native schemas, JSONL, session resume, sandbox selection, and concurrent independent `exec` sessions, while deliberately giving up auto-merge. The deterministic supervisor—not an agent—creates one external worktree per lane, persists execution state outside the repository, commits, invokes the unchanged `scripts/auto-loop/gate.sh`, verifies a fresh hostile review, pushes only the exact gated SHA, checks the remote SHA, and opens a draft PR. Every lane is PR-only in v1.

This is a hybrid rather than a replacement because Codex's native primitives remove much of the agent-process plumbing, but do not replace phase/cache orchestration. A small supervisor is justified; recreating Claude Workflow's general DAG and cache would be a worse system.

### Invariant check

| Required invariant | Hybrid posture |
|---|---|
| 1. Fail-closed routing | A separate routing guard permits `safe` only for `docs/**`, `ui/**`, and `service/**/*.py`; all relay/engine/state/auth/packaging/CMake/product-unknown work is `owner`; rulebooks/pins/parked/control paths are `never`. V1 has no merge operation at all. |
| 2. Reuse the gate | The supervisor calls the unchanged `scripts/auto-loop/gate.sh` with the class returned by the existing classifier and requires a native selftest floor. The routing guard authorizes whether a diff may become a PR; it is not a second verification gate. |
| 3. SPEC §0 / never-touch | Planning and implementation happen in the same external lane worktree; agent git/GitHub mutations are blocked and checked; rulebook, pin, `.github`, parked, sentinel, and cross-lane changes are rejected before commit. |
| 4. Agent-agnostic program | SPEC, backlog, and lane plans remain authoritative. Only execution/thread/SHA/phase evidence lives under `~/Library/Mosh/automation/first-stranger-codex/`; no agent-specific program state is added to the backlog schema. |

The additive prototype is documented at `scripts/first-stranger/codex-native/README.md`. It does not modify either existing loop, does not create a schedule or sentinel, and cannot merge a PR.
