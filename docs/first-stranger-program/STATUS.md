# First-Stranger Program — Status board

> **PAUSED AND SUPERSEDED — 2026-07-30.** This is the preserved board at the
> pause boundary. The tracked `STOP` prevents nightly, workflow, Codex-lane,
> merge-queue, and dashboard-regeneration paths from advancing it.

_Preserved at the 2026-07-30 pause boundary from
`docs/first-stranger-program/backlog.jsonl`. Do not regenerate while `STOP` is
present._

| status | count |
|---|---|
| ready | 5 |
| blocked | 10 |
| gap-closed | 1 |
| done | 3 |

## Ready at the pause boundary (historical; the loop will not work these)

| id | lane | title | class | blockedOn |
|---|---|---|---|---|
| FS-B0 | B | r5-freeze memo | cheap | - |
| FS-B1 | B | Skill schema + mock harness + contract test | cheap | - |
| FS-T2 | T | Autosave + crash recovery | native | - |
| FS-K4 | K | Wire the K1 packaging check + BOM enforcement | native | - |
| FS-K3 | K | Sentry crash reporting (opt-in) | native | - |

## Awaiting at the pause boundary (historical; owner disposition required)

_No backlog row is marked `awaiting-owner`. Pre-existing First-Stranger PRs
#471, #473, #475, and #478 are paused; their disposition is recorded in
`docs/vocal-map-program/STATUS.md`._

| id | lane | title | class | blockedOn |
|---|---|---|---|---|

## ⛔ Blocked on you (clear the O-task, then flip the lane to `ready`)

| id | lane | title | class | blockedOn |
|---|---|---|---|---|
| FS-T1 | T | Brain-key token proxy (Edge Function + BrainProxy retarget) | native | O4 |
| FS-K1 | K | Sign + notarize + staple DMG | native | O1 |
| FS-K2 | K | Sparkle 2 auto-update scaffold | native | O1 |
| FS-S0 | S | Session sizing spike (report only) | cheap | owner-hardware |
| FS-S1 | S | R2 content-addressed take path | native | FS-T3,FS-S0,O4 |
| FS-S2 | S | 4-player session | native | FS-S1,FS-S0 |
| FS-B2 | B | First ~10 skills from the demo beats | cheap | O2 |
| FS-B3 | B | Router v1 (cloud brain via the T1 proxy) | native | O2,FS-T1 |
| FS-ST1 | ST | Arena harvest → port owner picks into ui/src/v2 | cheap | O5 |
| FS-ST2 | ST | 'Toy, not tool' polish pass on the v2 shell | cheap | O5,FS-ST1 |

### Owner critical path (O1–O6)

| task | what it is | blocks lanes |
|---|---|---|
| O1 | Apple Developer enrollment ($99, ~1–2 days) — gates Lane K signing/notarization | FS-K1, FS-K2 |
| O2 | Demo script (the specific session/song, beat by beat) — gates B skills | FS-B2, FS-B3 |
| O3 | FMS verdict (score the 8 seeds; PASS = ≥2/8 demo-worthy AND ≥4/8 directionally right) | - |
| O4 | Accounts & secrets (Cloudflare R2 + Supabase function secret + commercial API key; rotate the bundled key; register Stable Audio) | FS-T1, FS-S1 |
| O5 | Arena harvest hour (judge ~38 candidates; pick what fits the script) | FS-ST1, FS-ST2 |
| O6 | Housekeeping (½ day): fast-forward main; commit/discard stray files; prune stale worktrees; tag+park the SA3 LoRA branch | - |
| hw | 2 machines + a live relay (S0 sizing spike) | FS-S0 |

> Historical unblock command (do not run while paused):
> `AL_BACKLOG_JSONL="$PWD/docs/first-stranger-program/backlog.jsonl" scripts/auto-loop/discover.sh set-status <id> ready`

## ✅ Done

| id | lane | title | class | blockedOn |
|---|---|---|---|---|
| FS-000 | setup | Land SPEC + DEPENDENCY_BOM into docs/ | cheap | - |
| FS-B1a | B | Reconcile the two skill catalogs (ui/src/agent/skills.ts vs service/skills/) | cheap | - |
| FS-B2a | B | Turn provenance in mosh-log.jsonl (the ask, not just the commands) | native | - |

---
_Kill switch: `touch docs/auto-loop/STOP` (or
`docs/first-stranger-program/STOP`) halts the loop. The configured
`docs/first-stranger-program/LEDGER.md` target did not become a tracked file
before this pause._
