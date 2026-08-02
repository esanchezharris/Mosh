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
| `MOSH_REPAIR_CONTROL_TEAM_ID` | Running Mosh app's signing team | Native derives this from the running signed app and supplies it only to Agent Host. Repair orchestration stays unavailable for unsigned/ad-hoc app builds. |

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
- Starting or reconnecting the owner cockpit reloads the playtest's durable
  reports through the authenticated report-list endpoint. Only each report's
  ID, kind, title, body, and approval state cross into the WebView, so an app or
  Agent Host restart restores the approval inbox without exposing evidence or
  host-only metadata.
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
| Report recovery unavailable or malformed | Cockpit startup fails visibly instead of presenting an empty, false-success inbox. The durable records remain on disk for the next retry. |
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
repair first reproduces the problem and proves focused RED/GREEN at the tested
build SHA, then transfers the minimal fix onto the current `origin/main` and
reruns focused GREEN and diagnostics. The host refreshes `origin/main` both
when reserving the repair and when accepting its result. Completion requires a
clean final worktree whose exact `sourceSha` descends from that refreshed main,
and records both the tested base SHA and target base SHA together with
diagnostics, bundle/build paths, and `full_gate_pending`; it never merges. Every
result path must already exist as a canonical, non-symlink descendant of the
recorded repair worktree. The build must be a `studio.mosh.app` bundle whose
Mosh executable embeds that same final source SHA. The launch request is
accepted only when its canonical path exactly equals the validated result
build.

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
lifecycle pass the synthetic installed-app harness. Interactive launches are
single-instance, while explicit selftest, script, voice, and plugin-scan child
modes remain independently runnable. A physical installed-app swap remains a
release-candidate owner gate because it exercises the machine's real Developer
ID signature, audio device, and window lifecycle.

The Realtime owner gate has reached a signed WKWebView connection and the
native physical-input listening state. A human-spoken semantic turn is still
required because system-generated speech is correctly rejected as echo.
The deployed Supabase function and private bucket authenticate the owner token
against a service-role-only SHA-256 digest. The plaintext owner token exists only
in the mode-`600` local env file. The deployed upload and short-lived signed
preview flow have passed a live request; mismatched credentials fail closed.

The repair-control adapter repeats the bundle/path/source checks immediately
before invoking the helper. It also re-verifies the helper immediately before
each handoff against the running Mosh app's Team Identifier and the exact
`MoshRepairHelper` code-signing identifier. The helper validates its own live
signature, rejects unsigned callers, and accepts only the already validated
absolute app path. Those helper checks are defense in depth; they do not
replace the Agent Host policy.

## Physical installed-app swap and rollback checklist

Run this gate for every release-candidate SHA. Use a Developer-ID-signed build
and a repair build signed by the same team; an ad-hoc development build is
expected to leave repair orchestration unavailable.

1. Install the signed candidate as `/Applications/Mosh.app`. Open an
   identifiable project, note its path and the candidate source SHA, and make a
   harmless unsaved change you can recognize after restart. Start playback,
   but do not record: active recording must refuse the swap.
2. In Settings → Moshi enable **Owner playtest cockpit**, press **Start**, and
   create a blocker with **Log this** or the Felt Wrong hotkey. In the owner
   inbox press **Approve**, then **Fix Now**. Wait until the repair card says
   `ready` and shows **Launch Repair**. A GitHub issue and repair worktree must
   exist only after approval.
3. Press **Launch Repair** once. Accept only if the event sequence shows
   `repair.checkpoint.created`, `repair.transport.stopped`,
   `repair.audio.released`, and `repair.build.handoff_accepted` in that order;
   playback stops; the original app closes; exactly one Mosh process remains;
   and the restarted app shows the repair banner with the expected source SHA
   and repair ID. Confirm the same project opens at the checkpointed state and
   the audio device can play again.
4. Retest the blocker, then press **Roll Back**. Accept only if the repair app
   closes, exactly one prior app starts, the repair banner is gone, the same
   checkpointed project returns, and the prior app reacquires working audio.
5. If launch fails before a checkpoint exists, the card says `launch failed`
   and does not offer a false rollback. Correct the signed build/result and
   retry **Launch Repair**. If failure happens after checkpointing, **Roll
   Back** remains available. If neither app is visible, relaunch the recorded
   prior application path and open the checkpoint path recorded in the repair
   job; do not start a second repair.

Record the two process counts, banner SHA/repair ID, project path, ordered event
names, and a short audio-playback observation. Do not attach the project,
audio, local credential file, or raw capability to the PR.
