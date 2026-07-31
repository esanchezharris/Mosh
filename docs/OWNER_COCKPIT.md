# Owner playtest cockpit

The owner cockpit is a disabled-by-default, Apple-Silicon prototype for running
a private playtest from the shipped v2 Moshi panel. It starts a Node Agent Host
on loopback, gives the owner a once-per-session hosted-trace disclosure,
supports hold-to-talk Realtime voice, persists reports before approval, and can
coordinate a draft-only repair. It is not a remote tester control plane and it
does not create an alternate DAW mutation path.

## Setup

1. Install Node 20 or newer on the owner Mac. The app bundles the Agent Host
   JavaScript in `Mosh.app`, but this prototype still launches it with the
   installed `node` executable. A signed embedded runtime/helper is an owner
   gate.
2. Put credentials only in `~/.config/mosh/env` and keep that file mode `600`.
   Do not put values in this repository, a UI `.env`, screenshots, logs, or PR
   text.
3. Build normally. `MoshStageAgentHost` bundles
   `service/agent-host/dist/agent-host.mjs` into
   `Contents/Resources/agent-host/agent-host.mjs`.
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
| `MOSH_REPAIR_CONTROL_HELPER` | Owner-approved process/checkpoint helper | Required for app swap/rollback; signing and packaging remain an owner gate. |

External orchestration is fail-closed and enabled only when all six evidence,
GitHub, repository, worktree, and helper variables are present. Otherwise
approval remains `approved_pending_sync` and Fix Now is unavailable.

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
and `full_gate_pending`; it never merges.

Launching a repair build is a separate owner action. The helper must checkpoint,
stop transport, release audio, close the current app, and then launch the repair
build so two Mosh processes never overlap. Rollback closes candidates, restores
the checkpoint, and launches the prior app. Live GPT Realtime audio, deployed
Supabase evidence, the signed helper, and full owner feel/cutover remain explicit
owner gates.

## PR #478 supersession

The owner-cockpit branch is an independent replacement for PR #478's
agent-facing hunks. Merge it only after whole-branch review and the local gate,
serially with other open PRs. Do not resolve overlap by keeping #478's older
agent implementation. Packaging, Sparkle, and unrelated First-Stranger changes
from #478 are not superseded by this branch and must be dispositioned
separately. Neither the Agent Host nor a repair thread may merge a PR.
