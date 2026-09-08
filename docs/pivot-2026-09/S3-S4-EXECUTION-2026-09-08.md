# Producer v0 S3 repair and scripted S4 execution checkpoint

Goal: a locally committed, gate-passing descendant of `882aceaa1eba39829a629a03dc15b81a7ca8ef3a` that closes the selected bounded agent path's S3 failures, then demonstrates the synthetic first request and room-only revision through the application. No push, merge, installation, deployment, model calls, or owner-audio processing.

## Owner decision, 2026-09-08

The owner explicitly authorized execution of `Moshi_Autonomous_Execution_Mandate_2026-09-08.md`. For this milestone it supersedes the earlier diagnostic-only, one-repair-only, stop-after-ownership and separate-prompt requirements. Multiple related frontend/native/ledger/UI repairs and review cycles are authorized, followed automatically by model-independent S4. Historical verdicts and instructions remain unchanged. S2 and compressor qualification remain closed with their original limits.

The frozen rack permits Lead fader −6/0/+3 dB, existing high-pass bypass/80/120 Hz, and printed-room fader 0/−6 dB. Compression and all unselected state remain protected. Actual target identities must be selected from each session; synthetic IDs are never a real-song configuration.

## Reconciliation

- Initial checkout: clean `codex/astaattempt`, `882aceaa1eba39829a629a03dc15b81a7ca8ef3a`, primary `/Users/emiliosanchez-harris/Mosh`.
- Prior binary SHA-256: `ee7dd32575d6c4cf44534147bdaac89627f3be71472f358dc3f888838c86316b`.
- Immutable failure evidence: `~/Library/Mosh/mix-2026-09-songA-first-pass/s3-selected-path-882aceaa-20260908/` (99-file sealed manifest).
- Other worktrees and shared processes are preserved. The prior gate covers only the prior source/binary; changed UI/native code requires a new integrated gate and review.

## Decisions and acceptance failures

The Producer v0 session configuration selects a bounded mode of the existing runLoopTask → runAgentLoop → createTaskExecutor path. It compiles the complete known-control patch before one synchronous native apply. Generic dependent construction/produce workflows remain separate and are not claimed qualified.

Reuse identified native transactions and their existing JSONL ledger. Add durable opaque request/project/payload binding, native project-epoch/revision preconditions, short atomic application, exact rollback and guarded owned undo. Persist ambiguous recovery truthfully; never infer full completion from the generic journal's count, especially for excluded plugin recovery operations.

Remaining acceptance failures: manual ownership during waits; task undo of newer manual work; logical redelivery/concurrency/conflicts; native-write staleness; cancellation presentation; durable task recovery. All require native-backed regression evidence before S3 passes.

## Execution state

1. COMPLETE: reconcile baseline and retained failures; read spec/mandate/current instructions; independent read-only native/frontend analysis.
2. COMPLETE (pending native acceptance): implement bounded proposal collection, configured rack and UI entry, durable native request lifecycle, and focused regressions. Native writer owns MoshOps/tests; frontend collector writer owns its module/tests; lead owns integration/UI/evidence; the frontend writer owns the rack module and setup component.
3. IN PROGRESS: native application S3 scenarios, repair/review iterations, scripted S4 composer/revision/undo/reopen.
4. PENDING: local candidate commit, complete native gate with repeated selftests, exact-candidate required review/runtime audit and final handoff.

Next action: commit the request-discovery repair, build the clean descendant, and execute the prepared native-backed S3/S4 harness.

## Implementation checkpoint

- Complete proposal collection rejects malformed members and all host-invalid commands before mutation. All provider planning uses one frozen native context; one native call owns the full patch, with no provider or observation wait inside it.
- Native request context/reservation/apply/status/cancel/owned-undo reuse identified Tracktion transactions and their existing ledger. Identity binds request ID, backing-project path hash, original host payload and proposed patch digest. Concurrent same-ID/same-payload frontend deliveries join the running promise; other active submissions refuse. Terminal retries consult native status before provider execution or stale checks. New composer submissions receive new IDs.
- Producer configuration is explicit, in memory, and checked against fresh native project identity on every task. Exact room-preservation revision has host-enforced room-only scope. Existing legacy construction/produce workflows remain outside this qualification.
- Drawer exposes request identity, retained task history, and native-owned undo refusal. Request lookup and supported pre-state resolution are available in the rack setup after reopen. Historical tasks cannot claim arbitrary selective undo after restart.
- New owned journal rows must preserve replay accounting for faders and be removed only for proven rollback or explicit owned task undo. Existing unrelated journal entries and prior ledger history remain intact.
- New durable request metadata stores hashes/status/counts, not raw provider or owner payloads. This Producer path does not call legacy transcript archival or memory retrieval.

Focused evidence so far (working tree, not acceptance): native Catch2 186 assertions / 25 cases; native syntax-only compilation; 106 frontend tests across collector, rack, adapter and existing loop/executor/task suites, plus 9 request lifecycle integration unit tests; full UI typecheck. Full frontend suite exposed one process-supervisor timeout (4738 pass, 1 fail, 1 existing skip); raw failure preserved at `~/Library/Mosh/task-evidence/s3-s4-mandate-20260908/ui-integration-tests.log`. Its focused rerun passed all 6 tests; the canonical gate remains a separate check, with no timeout/coverage relaxation.

Previous executable preserved byte-for-byte at `~/Library/Mosh/task-evidence/s3-s4-mandate-20260908/baseline-Mosh`, SHA-256 `ee7dd32575d6c4cf44534147bdaac89627f3be71472f358dc3f888838c86316b`. The new harness and all subsequent raw evidence live under that same existing task-evidence root. Native runtime, gate, exact-candidate reviews and S4 acceptance are still pending; no readiness verdict yet.

Native selftests add 22 assertions for request ownership, replay, stale rejection, rollback and owned-journal preservation. Drawer tests add 2 assertions scenarios for visible refusal and proven undo status; focused UI undo/lifecycle/adapter suite is 22/22. Native wrapper journal rows carry request/project identity, preserve unrelated rows byte-for-byte, and are removed from both current and pending recovery tails only after proven task rollback/undo. A durable native-commit flag permits a formerly ambiguous committed task to regain committed status only when its exact post-state is proved.

## First integration review and repair

Integration candidate `714b42fca161bc5fd8017a447872978770a95065` built successfully with `cmake --build --preset macos-arm64-release-app`. Binary SHA-256 `526761514d478c12794c73d30d9cdb9a88c0b49f526479ddff28527b68436be4`; UI HTML SHA-256 `6fd0e35d0c1997784c46eb9eef6a5f6ba23eb2d3ad3994090f46e0551df4672c`. Build log and preserved binary/UI are in the task-evidence root. Remote main was rechecked as `0e57fe520d486568e90b674fbc6427e089871f1d`.

Independent source audit at that exact SHA found a P2 recovery usability gap: ordinary generated request IDs were not discoverable after interruption before the final result. The original audit and old-binary raw `get_agent_context` reproducer remain preserved (`integration-audit-714b42fc.md`, `discovery-before-results.jsonl`). This was source review, not runtime acceptance.

The repair adds current-project native request inventory, immediate visible identity while preparing, and actual setup controls to discover/select/inspect/resolve requests after restart. Native outcome remains authoritative. It also retains prior task history access when the newest task failed before receiving an execution result. Focused lifecycle/adapter/drawer tests pass 23/23; three actual setup DOM regressions pass, and UI typechecking passes. Native selftests now add 23 checks in total, including inventory visibility. The harness adds an ordinary composer-generated ID crash/discovery test with no supplied recovery ID. Native execution and final descendant review remain pending.

## Undo observation repair

Candidate `c31ad2b93910a57f258a6cf55a1fd44837b5651c` built successfully; its executable/UI and identity are preserved under task-evidence/candidate-c31ad2b9. A fresh source audit found another P2: confirmed native undo was discarded when subsequent refresh failed; lost native delivery also falsely reported refusal. Four new regressions failed before repair (`p2-task-undo-red.txt`). The adapter now retains proven undone separately from observation, performs exactly one durable lookup for lost delivery, preserves explicit refusal reasons, and reports unavailable outcomes as unconfirmed. Focused adapter/drawer tests pass 17/17; UI typecheck passes. The audit and failing tests remain preserved. No native mutation or undo implementation changed in this repair.

The native harness now includes a real task-undo UI observation-failure phase. Its oracle requires expected renders/snapshots, checks exact source/binary/phase-bundle identities, and validates actual enabled 80 Hz readback and effective S4 faders. Seven isolated negative/positive verifier controls pass. Next action: freeze this UI repair, build the clean integrated candidate, then run native S3 and scripted S4 acceptance.
