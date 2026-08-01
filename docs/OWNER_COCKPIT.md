# Owner playtest cockpit

The owner cockpit is a disabled-by-default, Apple-Silicon prototype for running
a private playtest from the shipped v2 Moshi panel. It starts a Node Agent Host
on loopback, gives the owner a once-per-session hosted-trace disclosure,
supports hold-to-talk Realtime voice, persists reports before approval, and can
coordinate a draft-only repair. It is not a remote tester control plane and it
does not create an alternate DAW mutation path.

## Setup

1. Install Node 24 on the owner Mac. The app bundles the Agent Host
   JavaScript in `Mosh.app`, but this prototype still launches it with the
   installed `node` executable. Embedding and signing the runtime remains a
   post-prototype packaging gate.
2. Put credentials only in `~/.config/mosh/env` and keep that file mode `600`.
   Do not put values in this repository, a UI `.env`, screenshots, logs, or PR
   text. Run `scripts/owner-cockpit/provision-evidence-secret.sh` once to create
   or preserve the local evidence credential and the non-secret owner paths. It
   prints only the SHA-256 digest that must match the private Supabase
   `mosh_owner_credentials` row; use `MOSH_ROTATE_EVIDENCE_SECRET=1` only when
   intentionally rotating both sides.
3. Build normally. `MoshStageAgentHost` bundles
   `service/agent-host/dist/agent-host.mjs` into
   `Contents/Resources/agent-host/agent-host.mjs`, and the native build stages
   the signed-handoff component at `Contents/Helpers/MoshRepairHelper`.
4. Launch through `./run-mosh.sh`, open Settings → Moshi, and enable
   **Owner playtest cockpit**. It defaults off in every profile.
5. Open the right Moshi rail and press **Start**. Starting is explicit: report
   phrases, Felt Wrong, the supervisor, and Realtime remain inactive before it.

For service-only development:

```sh
cd service/agent-host
npm ci
npm run build
npm run bundle
PORT=0 npm run dev
```

The startup JSON contains a generated bearer capability. Treat it as a secret.
The native app consumes it directly; do not paste it into a browser or log.

## Environment names

Names are documented here; secret values are deliberately not.

| Name | Purpose | Required posture |
| --- | --- | --- |
| `OPENAI_API_KEY` | Server-side supervisor, hosted tracing, and Realtime ephemeral-secret minting | Optional. Missing means an explicit `openai_unavailable`; local sessions/reports still work. |
| `MOSH_AGENT_HOST_MODEL` | Supervisor model override | Optional; server-side only. |
| `MOSH_AGENT_HOST_DATA_DIR` | Local playtest record root | Optional; defaults to `~/Library/Application Support/Mosh/playtests`. |
| `MOSH_AGENT_HOST_ENTRY` | Source-tree Agent Host entry override | Development only. Production uses the app resource. |
| `PORT` | Agent Host listen port | Native sets `0` for an OS-selected loopback port. |
| `MOSH_AGENT_HOST_CAPABILITY` | Fixed launch capability | Harness/manual diagnostics only. Native normally generates one per launch. |
| `MOSH_PLAYTEST_EVIDENCE_URL` | Private evidence Edge Function endpoint | Required for external synchronization. |
| `MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET` | Owner authentication for the evidence function | Secret; Agent Host only. |
| `MOSH_GITHUB_REPOSITORY` | Repository passed to authenticated `gh` | Required for external synchronization. |
| `MOSH_REPOSITORY_PATH` | Clean committed repair base checkout | Required for repair admission. |
| `MOSH_REPAIR_WORKTREE_ROOT` | Parent for isolated repair worktrees | Required for repair admission. |
| `MOSH_REPAIR_CONTROL_URL` | Private native MoshOps control origin | Native supplies this loopback-only value automatically. Never configure it in the WebView. |
| `MOSH_REPAIR_CONTROL_HELPER` | Signed repair-app handoff helper | Native supplies the bundled helper path automatically. It launches only after MoshOps checkpoint, transport stop, and audio release succeed. |

External orchestration is fail-closed and enabled only when the evidence,
GitHub, repository, worktree, native-control, and helper values are present.
Otherwise approval remains `approved_pending_sync` and Fix Now is unavailable.

## Security and mutation boundary

- The host binds the literal address `127.0.0.1`. Every `/v1/*` endpoint
  requires a random per-launch bearer capability; `/health` is the sole public
  readiness endpoint and reveals no configuration.
- The capability, loopback origin, primary OpenAI key, GitHub auth, and Supabase
  owner secret stay in native/service memory. The WebView receives only bounded
  result envelopes and, for Realtime, an ephemeral `ek_` client secret.
- The supervisor returns a validated plan and selected capability IDs. Direct
  safe tools and supervised commands both reuse the existing executor and
  MoshOps bridge. Agent Host, Realtime, report, Codex, evidence, Git, and
  process adapters cannot mutate DAW/session state.
- Raw audio, project files, screenshot bytes, credentials, and authorization
  headers are excluded from hosted traces and Codex context. Report metadata
  carries only bounded text, local screenshot paths, scalar digests/timeline
  position, and narrow recent MoshOps result envelopes.
- No live external write happens before the owner presses **Approve**. Report
  snapshots are durable locally first.

## Retention and disclosure

Each playtest lives under
`$MOSH_AGENT_HOST_DATA_DIR/sessions/<playtest-id>/`:

- `session.json`, `reports/*.json`, and `repairs/*.json` use atomic replacement.
- `events.jsonl` is append-only and intentionally contains no transcript text.
- `transcript.json` and `sdk-session.json` are removed when a non-retained
  session closes. Reports, repair metadata, and non-transcript audit events
  remain.
- If **Retain transcript** is checked at close, the two local conversation files
  remain.
- Hosted text/tool traces follow the provider's separate trace retention. The
  once-per-session disclosure says that those traces may outlive local purge;
  it also states that audio, screenshots, media, credentials, and project files
  are excluded.
- Realtime raw audio is never retained by Mosh.

## Diagnostics and failure behavior

```sh
# Service contract and real bundled fake-external lifecycle
cd service/agent-host
npm run build
npm test
npm run test:startup
npm run test:integration

# Health only; substitute the startup port
curl --fail http://127.0.0.1:<port>/health

# Packaged native lifecycle, private bearer boundary, and unavailable-without-key
cmake --build build --target Mosh
MOSH_NO_AUDIO=1 build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest
```

Expected explicit failures:

| Surface | Observable behavior |
| --- | --- |
| No `OPENAI_API_KEY` | Supervisor and Realtime return typed `openai_unavailable`; health, start/close, local report persistence, and purge continue. |
| Host missing/crashed/timeout | Cockpit shows an outage/typed host error; no mock success and no hidden fallback for complex turns. |
| Realtime failure | Mic tracks are released. Apple speech may run deterministic direct-safe commands and report drafting only; complex reasoning says unavailable. |
| Recording active | Spoken replies and mutating voice tools are refused until recording stops. |
| Evidence checksum/identity mismatch | Approval synchronization fails before GitHub. |
| Missing `gh` auth | Durable report remains `approved_pending_sync`; retry uses the same stable report marker. |
| Dirty or SHA-mismatched base | Fix Now fails with `dirty_base` or `base_sha_mismatch`; no worktree starts. |
| Active/stranded repair | A second repair fails closed with `repair_active` until owner recovery. |

For a retained diagnostic bundle, copy only the relevant redacted JSON records
and logs. Never copy `~/.config/mosh/env`, raw audio/project files, screenshot
bytes, startup capability output, or authorization headers.

## Repair and release gates

Fix Now requires an approved and synchronized bug/blocker, a clean committed
base whose SHA matches the report evidence, no active repair, and the configured
process helper. It creates one isolated
`codex/playtest-<issue>-<slug>` worktree, starts a network-off
workspace-write Codex thread, and may produce only a draft PR. A successful
repair records targeted RED/GREEN evidence, diagnostics, bundle/build paths,
the exact `sourceSha`, and `full_gate_pending`; it never merges. Every result
path must already exist as a canonical, non-symlink descendant of the recorded
repair worktree. The build must be a `studio.mosh.app` bundle whose Mosh
executable embeds that same source SHA. The launch request is accepted only
when its canonical path exactly equals the validated result build.

Launching a repair build is a separate owner action. The full process controller
now checkpoints through MoshOps, stops transport, releases the audio device, and
only then invokes the bundled handoff component. Active recording refuses the
checkpoint/release instead of interrupting a take. The handoff verifies
same-team signatures, caller ancestry, canonical worktree/app paths, bundle
identity, and embedded source SHA before terminating the current Mosh and
launching the repair, so two Mosh processes never overlap. It also carries a
stable repair ID into the repair app, allowing the restarted Moshi owner card to
recover the active repair and keep **Roll back** available. Rollback revalidates
and launches the prior app with the checkpoint while scrubbing the active-repair
environment. The card shows the active repair source SHA and offers explicit
**Launch repair build** and **Roll back** actions. The signed handoff and full
lifecycle pass the synthetic installed-app harness; a physical installed-app
swap remains an owner gate because it exercises the machine's real Developer ID
signature, audio device, and window lifecycle.

The Realtime owner gate has reached a signed WKWebView connection and the
native physical-input listening state. A human-spoken semantic turn is still
required because system-generated speech is correctly rejected as echo.
The deployed Supabase function and private bucket authenticate the owner token
against a service-role-only SHA-256 digest. The plaintext owner token exists only
in the mode-`600` local env file. The deployed upload and short-lived signed
preview flow have passed a live request; mismatched credentials fail closed.

The repair-control adapter repeats the bundle/path/source checks immediately
before invoking the helper. The deployment helper should also be owner-signed,
verify its own signature/designated requirement, reject unsigned callers, and
accept only the already validated absolute app path. Those helper checks are
defense in depth; they do not replace the Agent Host policy.

## PR #478 supersession

The owner-cockpit branch is an independent replacement for PR #478's
agent-facing hunks. Merge it only after whole-branch review and the local gate,
serially with other open PRs. Do not resolve overlap by keeping #478's older
agent implementation. Packaging, Sparkle, and unrelated First-Stranger changes
from #478 are not superseded by this branch and must be dispositioned
separately. Neither the Agent Host nor a repair thread may merge a PR.

### Exact PR #478 disposition

Read-only GitHub inspection on 2026-07-30 produced this commit-level map:

| PR #478 commit | Disposition |
| --- | --- |
| `d15cee8d65f0156516f0efbfaf991a859b777592` | Preserve all FS-K1 signing files. |
| `3b2da0c56eded3edeaa84dd386e44818252a6d6e` | Preserve all Sparkle files; resolve `CMakeLists.txt` by keeping both Sparkle and Agent Host staging. |
| `a51b70dbdaf466bab011a33241ad1281ff9704a1` | Preserve all BOM/package enforcement files. |
| `aa14563a528679b1c5ef5960f694dd407d35a8b5` | Preserve `run-mosh.sh`. |
| `2b30832fdc55f4f51d5fc18e640caf4d1bf8c8cf` | Preserve `docs/first-stranger-program/lanes/fs-b2.md`, `ui/src/agent/skills.ts`, and `ui/src/agent/skillsFsB2.test.ts`; this branch does not replace the five skills. |
| `037e9fe97cf6cceb306789291d01512a946fbfab` | Split by the exact file lists below. |
| `678b3923d431aeec486cc5ddcbcde1f10f9ebff8` | Preserve all program/status/setup files. |
| `6f76c574d7e9df4c17ac6da38996c47fd4a3655b` | Merge-only commit; no independent payload to transplant. |
| `39aa1414d8293acdc123f66ea45b529754fbed33`, `28e0a1e9db47329d9a809522b03cb269c095a415`, `b3d7bc2c9f0a8109425b369bbae83aac256261ce`, `44c56ea887d59162c133c13192e56408948e7cd1` | Preserve setup-cloud, Supabase-ignore, deployed proxy, and status changes. |
| `22060883a655780197493860e0330727871ced66`, `39c9b4607dcc20505db53a0e73f0b44c5762e084` | Preserve release-feed, dependency, spec, status, and ownership-doc changes. |

For `037e9fe...`, prefer this branch for these overlapping agent-facing files:
`docs/agent-bench/README.md`, `src/app/SelfTest.cpp`,
`src/webview/WebBridge.cpp`, `ui/scripts/agentBench.mts`,
`ui/src/agent/brain.ts`, `ui/src/agent/brainCore.test.ts`,
`ui/src/agent/brainCore.ts`, `ui/src/agent/loop/loop.ts`,
`ui/src/agent/loop/loopPrompt.test.ts`, `ui/src/agent/loop/loopPrompt.ts`,
`ui/src/agent/loop/runTask.ts`, `ui/src/bridge.ts`,
`ui/src/settings/schema.test.ts`, and `ui/src/settings/schema.ts`.
Preserve every other file in that commit: `AGENTS.md`,
`docs/AGENT_ONBOARDING.md`, all `docs/agent-bench/scoreboard.*` files,
`service/sft/build_add_note_corrective.py`, `src/brain/BrainProxy.cpp`,
`src/brain/BrainProxy.h`, `src/moshops/MoshOps.cpp`,
`tests/test_brain_proxy.cpp`, `ui/.env.example`,
`ui/scripts/lib/codexMcpSeat.mts`, `ui/scripts/lib/moshMcpServer.mts`,
`ui/scripts/lib/realEngine.mts`, `ui/src/agent/brainProvider.test.ts`,
`ui/src/agent/loopSeam.ts`, `ui/src/bench/agentBench.mock.test.ts`,
`ui/src/bench/agentTasks.ts`, `ui/src/bench/conversation.ts`,
`ui/src/bench/goalChecks.ts`, `ui/src/bench/loopRunner.ts`,
`ui/src/bench/singleShotRunner.ts`, `ui/src/bridge.mock.ts`, and
`ui/src/v2/TopBar.tsx`.

PR #524 is parked behind the Vocal Map playtest in PR #523 (VM-D015). After
#523 lands, rebase this owner-cockpit branch onto the resulting `main` and run
every SHA-bound owner and native gate before continuing. #522 overlaps
`src/webview/WebBridge.cpp`, `ui/src/bridge.ts`, `ui/src/agent/brain.ts`,
`ui/src/agent/loop/runTask.ts`, their tests, and `ui/package.json`; preserve its
no-demo production failure posture while adding the owner-only host routes.
#514 directly overlaps `ui/src/v2/RightRail.tsx`, where the Graphite rail
structure must retain the disabled-by-default owner cockpit slot. #507, #508,
and #510 form the ordered selftest stack and overlap this branch in
`CMakeLists.txt` and `src/app/SelfTest.cpp`; do not transplant or merge those
chapters out of stack order.
