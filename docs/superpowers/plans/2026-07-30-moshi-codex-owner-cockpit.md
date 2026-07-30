# Moshi + Codex Owner Cockpit Implementation Plan

> Owner-approved plan captured 2026-07-30. This branch is independent from
> conflict-dirty PR #478 and supersedes that PR's agent-facing hunks. Packaging,
> Sparkle, and unrelated First-Stranger work from #478 stay out of scope.

## Global Constraints

- Owner-only macOS/Apple Silicon prototype. Remote tester auth, multiplayer
  authorization, and a cloud agent control plane are out of scope.
- MoshOps remains the only DAW mutation path. Agent, Realtime, report, and Codex
  code may propose or invoke MoshOps commands but may not mutate engine/session
  state directly.
- Bind the local host only to `127.0.0.1` and require a random per-launch bearer
  capability. Never log or return OpenAI, Supabase, or GitHub credentials.
- Read `OPENAI_API_KEY` from the process environment populated by
  `~/.config/mosh/env`. Never add a client-side key or bundled secret.
- OpenAI is the production reasoning/voice provider. Local and generic providers
  remain evaluation-only.
- Raw audio, project files, binary screenshots, and credentials must never enter
  OpenAI traces. Text transcripts and tool payloads may be hosted-traced.
- A report is durable locally before owner approval. GitHub creation and
  screenshot upload occur only after approval and must be idempotent.
- Codex coordinator work is read-only. Repairs start only from an explicit
  owner `fix now`, run one at a time in an isolated worktree, open draft PRs
  only, and never merge.
- Preserve the user's dirty main checkout and all unrelated worktrees.
- No silent production demo-brain fallback or false-success response.

## Task 1: Local Agent Host Contracts, Persistence, and Supervisor

Create an owner-only TypeScript service under `service/agent-host/`, using the
repo's npm tooling with pinned lockfile dependencies.

Required behavior:

- `npm run dev` starts an HTTP server on `127.0.0.1`; `PORT=0` or omitted selects
  a free loopback port. `/health` reports readiness without revealing config.
- Require `Authorization: Bearer <launch capability>` on every `/v1/*` endpoint.
  The capability is supplied by `MOSH_AGENT_HOST_CAPABILITY` or generated once
  at process startup and printed only to stdout as the machine-readable startup
  envelope.
- Implement and validate versioned records for `PlaytestSession`,
  `PlaytestReport`, `RepairJob`, `EvidenceRecord`, and append-only events.
- Persist each session beneath a configurable `MOSH_AGENT_HOST_DATA_DIR`,
  defaulting to the Mosh Application Support playtest directory. Use atomic
  file replacement for record snapshots and append-only JSONL for events.
- Implement:
  - `POST /v1/playtests`
  - `POST /v1/playtests/:id/close`
  - `POST /v1/supervisor/turns`
  - `POST /v1/realtime/client-secret`
  - `POST /v1/reports`
  - `POST /v1/reports/:id/approve`
  - `POST /v1/reports/:id/repairs`
  - `GET /v1/playtests/:id/events` as server-sent events
- Closing a non-retained session removes its local transcript but preserves
  reports, repair metadata, and non-transcript audit events.
- Create one OpenAI Agents SDK supervisor with typed structured output:
  `intent`, `say`, `commands`, `needsClarification`, and selected capability
  IDs. Use a persistent SDK session per playtest and hosted tracing.
- The supervisor never executes MoshOps itself. It receives only supplied
  capability schemas, state digest, recent result envelopes, and conversation
  context, then returns a validated plan.
- Mint Realtime ephemeral client secrets server-side. Never return the primary
  OpenAI API key.
- Missing OpenAI configuration returns an explicit typed unavailable response;
  health and local report APIs remain usable.

Tests must cover auth rejection, loopback binding, record validation, atomic
restart recovery, transcript purge/retention, SSE replay, unavailable OpenAI,
supervisor output validation with a fake model adapter, trace scrubbing, and
client-secret response scrubbing.

## Task 2: Capability Retrieval and Explicit Brain Failure

Change the existing Moshi prompt/runtime without changing the MoshOps command
contract.

Required behavior:

- Build a deterministic capability index from `AGENT_COMMANDS`, including
  command ID, category, description, triggers, argument schema, and safety
  posture.
- Retrieve a bounded relevant subset for each user turn. Always include the
  small direct-safe set (transport, locate, loop, metronome, undo, read-only
  status, report drafting); include other commands only by deterministic
  lexical/category matching.
- Render only the retrieved schemas into the supervisor request. Preserve the
  existing full-catalog renderer for benchmarks and explicit legacy tests.
- Direct-safe commands still execute through the existing validation/executor
  and MoshOps bridge. Generative, editing, ambiguous, and multi-step requests
  route through the supervisor.
- Replace production brain failure fallback with an explicit unavailable
  result. Keep demo/mock behavior only behind the existing dev/test surface.
- Add telemetry fields for retrieved command count, catalog character count,
  provider/model, latency, tool success, and repair count without logging user
  secrets or project/audio content.

Tests must prove bounded deterministic retrieval, direct-safe inclusion,
unsafe-command exclusion, meaningful prompt-size reduction, full-catalog
benchmark compatibility, MoshOps-only execution, and no production mock
fallback.

## Task 3: Owner Cockpit UI, Reports, and Realtime Voice

Add the owner-facing playtest controls to the shipped v2 Moshi surface while
keeping ordinary chrome neutral and reserving chartreuse for active agent work.

Required behavior:

- Add a local Agent Host client with capability-token injection through the
  native bridge, typed API errors, reconnect, and SSE event consumption.
- Start/close/retain a playtest session from Moshi and show the once-per-session
  hosted-trace disclosure.
- Draft reports only for explicit `log this`, `bug`, `blocker`, or `note`
  phrases, or the existing Felt Wrong hotkey. Persist first, then show the owner
  approval inbox.
- Capture the Mosh window immediately through a new native read-only bridge
  binding. Store the PNG locally and attach build SHA, dirty digest, timeline
  position, snapshot digest, and recent MoshOps result envelopes.
- Blocker/serious reports interrupt; minor notes wait until pause/session close.
  Nothing external occurs before approval.
- Implement GPT Realtime push-to-talk with `RealtimeAgent` and
  `RealtimeSession` over WebRTC. The browser receives only an ephemeral client
  secret. Keep the mic muted unless the button is held.
- Realtime's direct tools are the Task 2 safe allowlist. Complex turns call the
  host supervisor and then reuse the current validated executor.
- During playback, keep playback running and duck only Moshi's spoken response.
  During active recording, disable spoken replies and mutating voice tools and
  ask the owner to stop recording.
- On Realtime failure, use existing Apple speech recognition only for
  deterministic safe commands and report drafting; show complex reasoning as
  unavailable.
- Never retain raw voice audio. On session close, honor the host transcript
  retention decision.
- Use earcons plus terse speech for questions, explanations, report summaries,
  and repair status.

Tests must cover report trigger boundaries, durable-before-approval ordering,
host outage, Realtime failure fallback, mic mute lifecycle, recording refusal,
playback behavior, trace disclosure, inbox state, and screenshot metadata.

## Task 4: Evidence, GitHub, and Codex App-Server Orchestration

Implement adapters behind narrow interfaces so tests can run without external
writes.

Required behavior:

- Add a private `playtest-evidence` Supabase Storage integration. The host calls
  a narrowly scoped Edge Function using an owner secret; the function keeps the
  Supabase secret/service credential server-side, accepts PNG only with a
  bounded size, writes immutable object paths, returns evidence ID plus SHA-256,
  and mints short-lived signed preview URLs.
- Add a GitHub adapter that uses authenticated `gh`. Approved blocker/bug
  reports create one issue; minor notes append idempotently to one session
  issue. Missing auth leaves `approved_pending_sync`, and retries may not
  duplicate issues or comments.
- Spawn `codex app-server` as a local stdio JSON-RPC child. Create one read-only
  coordinator thread per playtest and stream its events into the session ledger.
- Coordinator context contains report/session text, local screenshot path,
  build SHA, dirty digest, snapshot digest, recent MoshOps envelopes, and issue
  context, but no project/audio payload.
- `fix now` creates at most one active `RepairJob`. Require a clean committed
  base SHA; create `codex/playtest-<issue>-<slug>` in an isolated worktree and
  start a workspace-write repair thread scoped to that worktree.
- Stream approvals and progress. Never auto-merge. A successful job records
  targeted RED/GREEN evidence, diagnostics, build path, draft PR URL, and
  `full_gate_pending`.
- Implement checkpoint/restart/rollback state as explicit repair events; do not
  run two Mosh apps simultaneously.

Tests must use fake Supabase, `gh`, git, and app-server processes to prove
approval gating, immutable evidence, secret scrubbing, GitHub idempotency,
read-only coordinator configuration, dirty-base refusal, one-job concurrency,
worktree isolation, draft-only PR posture, process restart recovery, and
rollback event ordering.

## Task 5: Integrated Verification, Documentation, and Owner Handoff

- Document local setup, environment variable names, data/trace retention,
  health diagnostics, failure behavior, and the #478 supersession/merge note.
- Add an integration harness that starts the real host on a temporary loopback
  port with fake OpenAI/Codex/GitHub/Supabase adapters and drives one full flow:
  start session, supervisor turn, draft report, approve, start repair, stream
  progress, close session, and verify transcript purge.
- Run targeted TypeScript/unit/e2e tests, native compile/tests, the local native
  gate, and the current unified agent benchmark on the exact branch SHA.
- Manually launch Mosh and prove the owner cockpit through the real UI:
  playtest disclosure, push-to-talk state, report draft/inbox, explicit
  unavailable state without credentials, and no mutation outside MoshOps.
- Open a draft PR only after review. Mark external Supabase deployment, signed
  helper packaging, live GPT Realtime audio, and full owner feel/cutover as
  explicit owner gates if credentials or hardware prevent them in automation.
- Never merge.
