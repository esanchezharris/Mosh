# Task 1 Report: Local Agent Host Contracts, Persistence, and Supervisor

## Status

DONE

Implementation commit: `6f30a642`

## Files changed

- `docs/superpowers/plans/2026-07-30-moshi-codex-owner-cockpit.md`
  - Added unchanged, as required, in the first Task 1 commit.
- `service/agent-host/package.json`
  - Added the standalone pinned npm package and dev/build/test scripts.
- `service/agent-host/package-lock.json`
  - Added the npm lockfile generated from exact direct dependency versions.
- `service/agent-host/tsconfig.json`
  - Added strict Node ESM TypeScript configuration.
- `service/agent-host/src/contracts.ts`
  - Added Zod-validated version 1 contracts for playtests, reports, repairs,
    evidence, audit events, supervisor turns, plans, and Realtime secrets.
- `service/agent-host/src/persistence.ts`
  - Added atomic JSON snapshot replacement, append-only JSONL events,
    per-playtest storage, transcript retention/purge, and disk-backed Agents SDK
    sessions.
- `service/agent-host/src/openai.ts`
  - Added the structured-output OpenAI Agents SDK supervisor, hosted tracing,
    trace input scrubbing, capability allowlist validation, injected test
    adapter seam, and Realtime ephemeral-secret adapter.
- `service/agent-host/src/service.ts`
  - Added the playtest/report/repair/supervisor lifecycle without any MoshOps
    execution path.
- `service/agent-host/src/server.ts`
  - Added the loopback-only authenticated HTTP API and persisted SSE replay.
- `service/agent-host/src/main.ts`
  - Added environment configuration, dynamic-port startup, generated/supplied
    launch capability, and the machine-readable readiness envelope.
- `service/agent-host/test/agent-host.test.ts`
  - Added 11 focused integration/unit tests covering every required Task 1
    test category.
- `service/agent-host/test/startup-smoke.mjs`
  - Added a real child-process `npm run dev` smoke test.

## Design choices

- Used Node's built-in HTTP server to keep the local host small and avoid an
  unnecessary web-framework surface.
- Bound with the literal address `127.0.0.1`; omitted or zero `PORT` delegates
  dynamic port selection to the OS.
- Compared launch capabilities with `timingSafeEqual` and authenticated every
  `/v1/*` route before dispatch.
- Kept transcript text out of audit events. Closing a non-retained session can
  therefore delete `transcript.json` and `sdk-session.json` while preserving
  all non-transcript audit JSONL, reports, and repairs.
- Used write-to-random-temp plus same-directory rename for every mutable JSON
  record snapshot. Audit events remain append-only JSONL.
- Used a disk-backed implementation of the current Agents SDK `Session`
  interface, keyed by playtest ID, so supervisor memory survives host restart.
- Created one structured-output `Agent` whose output is validated twice:
  against the Zod plan schema and against the exact supplied capability IDs.
  It has no tools and cannot execute MoshOps.
- Enabled the Agents SDK hosted tracing path. Model input is built only from the
  allowed supervisor fields and recursively strips credential, raw-audio,
  project-file, screenshot-binary, and authorization fields/tokens.
- Kept supervisor and Realtime providers behind narrow injected adapters. Tests
  use fakes and make no OpenAI request.
- Parsed and reconstructed the Realtime secret response, returning only
  `value` and `expires_at`, so primary-key or arbitrary adapter fields cannot
  cross the HTTP boundary.
- Missing `OPENAI_API_KEY` omits both production adapters and returns the typed
  `openai_unavailable` response while health and report persistence remain
  functional.

## Verification

Evidence directory:
`.omo/evidence/task-1-agent-host/`

### Pinned clean install

- Scenario: install exactly the committed lockfile dependency graph.
- Invocation: `npm ci`
- Binary observable: exit 0, 159 packages installed, 0 vulnerabilities.
- Artifact: `.omo/evidence/task-1-agent-host/npm-ci.log`

### Strict TypeScript build

- Scenario: compile production and test sources against the installed OpenAI
  Agents SDK APIs.
- Invocation: `npm run build`
- Binary observable: exit 0, no TypeScript diagnostics.
- Artifact: `.omo/evidence/task-1-agent-host/typecheck.log`

### Focused Task 1 suite

- Scenario: auth rejection; loopback binding; record/API validation; atomic
  restart recovery; persistent SDK session; transcript purge and retention;
  report approval/repair persistence; SSE replay; typed unavailable OpenAI;
  fake supervisor output validation; trace scrubbing; client-secret response
  scrubbing.
- Invocation: `npm test`
- Binary observable: exit 0, 1 test file passed, 11 tests passed.
- Artifact: `.omo/evidence/task-1-agent-host/unit-tests.log`

### Real process startup

- Scenario: launch the actual `npm run dev` entry point with `PORT=0`, no
  OpenAI configuration, a temporary data directory, and a known test launch
  capability; then probe health and authenticated/unauthenticated playtest
  creation.
- Invocation: `npm run test:startup`
- Binary observable: exit 0; host `127.0.0.1`; dynamic port selected; health
  HTTP 200; missing bearer HTTP 401; correct bearer HTTP 201.
- Artifact: `.omo/evidence/task-1-agent-host/startup-smoke.log`

### Secret and diff hygiene

- Scenario: scan the staged non-test production diff for common OpenAI/GitHub
  credential token shapes and check whitespace errors.
- Invocation:
  `git diff --cached --check` plus staged `rg` token scan excluding deliberate
  fake test values.
- Binary observable: exit 0 and `SECRET_SCAN_PASS`.
- Artifact: `.omo/evidence/task-1-agent-host/staged-secret-scan.log`

## Self-review findings

- Fixed route traversal/invalid-record risk by UUID-validating every route ID
  before constructing a persistence path.
- Added restart evidence for the disk-backed Agents SDK session rather than
  relying only on playtest snapshot recovery.
- Added HTTP-level malformed report validation in addition to direct schema
  validation.
- Added report approval and missing-Realtime assertions so every implemented
  route family has focused coverage.
- Added a real `npm run dev` child-process test after the in-process suite to
  verify the production entry point and startup envelope behavior.
- Confirmed the staged change set contains only the owner-cockpit plan and
  `service/agent-host/**`; ignored dependencies and evidence are not committed.

## Concerns

No blocking concerns. Per the task instruction, no live OpenAI call was made.
The production Agents SDK and Realtime adapters are compile-checked against
version `0.14.1` and exercised through injected fakes; credentialed hosted trace
delivery and Realtime minting remain intentionally outside this Task 1 run.
