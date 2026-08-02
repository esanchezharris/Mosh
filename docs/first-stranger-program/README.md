# First-Stranger Program — automation

> **Paused and superseded on 2026-07-30.** The tracked [`STOP`](STOP) sentinel
> keeps the nightly loop inert. The active milestone is the
> [Vocal Map Playtest Program](../vocal-map-program/README.md). This directory,
> including its backlog, lane plans, status board, and evidence, is preserved as
> historical program state. No tracked program `LEDGER.md` existed at pause; the
> configured ledger path remains only as historical loop wiring.

The [SPEC.md](SPEC.md) is the preserved, decision-complete plan for the former
6-week program. Its unattended `stranger-loop` implementation is retained in
Git history. Public cleanup removed the workflow file; the tracked `STOP` and
fail-closed legacy launchers prevent delegation or state mutation.

> **Historical 2-minute map.** The former loop read
> [`backlog.jsonl`](backlog.jsonl), planned each ready lane, implemented it in an
> isolated worktree, ran the full local gate and hostile review, then routed it.

## Preserved routing policy

| bucket | what it is | what the loop does |
|---|---|---|
| **Safe** | `docs/` + `ui/` + `service/**.py`, not excluded, not owner-taste-gated | **auto-merges to `main`** (gate green + review APPROVE) |
| **Owner** | engine, `src/state`, auth/secrets, packaging, `cmake`, relay, or `ownerMerge` lanes | gates + reviews, then opens a **`needs-owner-merge` PR** — **never auto-merges** |
| **Never-touch** | the loop's own rulebook (gate scripts, `CLAUDE.md`, specs `00`–`06`, dep pins, `.github`) | hard-rejected — the loop can't edit its own gate or the spec |

The program is ~80% owner-bucket by design (it's engine/auth/packaging work weeks before real users),
so the loop mostly acts as a **gated PR-drafting engine**: progress accrues overnight as green,
reviewed PRs you merge with one click. It can never merge high-stakes work on its own.

## Preserved controls

The commands below document the former operating surface. While the tracked
`STOP` exists, the remaining launchers and mutation helpers fail closed and the
status board is not regenerated. There is no active workflow to invoke.

- **Status board:** [`STATUS.md`](STATUS.md) — ready / blocked / awaiting-your-merge lanes + the O1–O6
  owner critical path + open owner PRs. It is preserved, not regenerated.
- **Former scheduler:** `scripts/first-stranger/install-launchd.sh` installed a
  nightly job; installation now stops before writing a plist.
- **Former one-shot entrypoint:** `scripts/first-stranger/nightly.sh --once`
  now stops before calling the workflow.
- **Former lane-unblock command:**
  `AL_PROGRAM_STOP="$PWD/docs/first-stranger-program/STOP" AL_BACKLOG_JSONL="$PWD/docs/first-stranger-program/backlog.jsonl" scripts/auto-loop/discover.sh set-status <id> ready`
  fails closed while the tracked program `STOP` exists.
- **Halt anything:** `touch docs/auto-loop/STOP` (shared kill switch, checked every cycle + before each merge).

## Files

| path | role |
|------|------|
| `SPEC.md` / `../DEPENDENCY_BOM.md` | the program + its verified license BOM (K4) |
| `backlog.jsonl` | preserved machine source: 17 planned lanes plus 2 off-backlog findings |
| `lanes/fs-*.md` | per-lane gate-registered plans (written by the loop's Plan phase) |
| `STATUS.md` | owner-blocker dashboard (auto-generated) |
| `STOP` / `ARMED` | per-program kill switch / live-arm sentinels |
| `scripts/first-stranger/{nightly,status,install-launchd}.sh` | scheduler + dashboard + installer |

The preserved scripts share the classic auto-loop harness, but the
First-Stranger entrypoints are stopped. The public-cleanup release removed the
former `.claude` workflow files entirely, so there is no Plan, Implement, Merge,
or Dashboard workflow path to invoke. The shared classic auto-loop scripts
remain available to other programs and independently honor the tracked STOP.
