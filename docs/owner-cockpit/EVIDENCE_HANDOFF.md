# Owner Cockpit Verification Handoff

This tracked summary is the durable reviewer index. Exact command transcripts,
RED/GREEN logs, and screenshots are generated under
`.omo/evidence/final-hardening/` during implementation and must be attached to
the pull request; reviewers must not depend on that ignored directory alone.

## Required observable scenarios

| Scenario | Invocation | Passing observable |
| --- | --- | --- |
| Repair path policy | `npm test -- --run test/repair-artifact-policy.test.ts test/repair-lifecycle.test.ts` in `service/agent-host` | Outsider, traversal, symlink, bundle-id, embedded-SHA, source-HEAD, and launch-path mismatches reject before process actions. |
| Repair startup recovery | Same focused service invocation | Initialize/thread/turn failures persist `failed`, emit `repair.start.failed`, remove the worktree best-effort, and allow retry; worktree-creation crash window remains queued/fail-closed. |
| Notification durability | `npm test -- --run test/codex-process.test.ts` in `service/agent-host` | Hostile output/diff/content/path/prompt/audio/image/base64/credential values are absent from JSONL and SSE. |
| RPC liveness | Same Codex process invocation | Nonresponding requests reject at deadline; stdin failures reject and a later request succeeds. |
| Realtime ownership | `npm test -- --run src/agent/realtimeVoice.test.ts` in `ui` | Secret/session/connect/mute setup failures stop every acquired track and close any created session. |
| Consent and legacy PTT | `npm test -- --run src/ui/AgentComposer.supervisor.test.ts` in `ui` | Inactive playtest returns the start-required result without supervisor routing; active cockpit recording refuses Realtime; inactive/off recording retains Apple record-to-review PTT. |
| Native disclosure and permissions | Focused native build plus `MOSH_NO_AUDIO=1 Mosh --selftest` | Supervisor cannot create a playtest/trace; disclosure precedes the active route; screenshot directory/file modes are 0700/0600. |
| Mock-bridge owner UI | `MOSH_TASK5_EVIDENCE_DIR=<private-dir> npx playwright test e2e/owner-cockpit.spec.ts` | Default-off, disclosure, report inbox, and unavailable state render; evidence directory/file modes are 0700/0600. This is mock-bridge UI evidence, not a live native proxy claim. |

## External owner gates

Live OpenAI Realtime, deployed Supabase evidence upload, signed repair helper,
real repair swap/cutover, and live native WebView observation remain owner-only
gates. No automated result may describe those as completed.
