# First-Stranger Program — automation

> **Paused and superseded on 2026-07-30.** The tracked [`STOP`](STOP) sentinel
> keeps the nightly loop inert. The active milestone is the
> [Vocal Map Playtest Program](../vocal-map-program/README.md). This directory,
> including its backlog, lane plans, status board, ledger, and evidence, is
> preserved as historical program state.

The [SPEC.md](SPEC.md) is a decision-complete, 6-week program to get Mosh in front of its first
non-owner user (playtest #1, ~wk 6). This folder wires that program into an **unattended loop** — the
`stranger-loop` — so it drives itself where safe and hands you a clean review queue everywhere else.

> **2-minute map.** The loop reads [`backlog.jsonl`](backlog.jsonl) (the program lanes), and for each
> ready, unblocked lane it: **plans** it (a gate-registered plan under [`lanes/`](lanes/) + verifies the
> gap still exists, per spec §0) → **implements** it in an isolated worktree → runs the **full local
> gate** (`--selftest` ×3 + Catch2 + verify.py + vitest/e2e) → a **hostile review** → then **routes** it.

## The one rule that matters: routing

| bucket | what it is | what the loop does |
|---|---|---|
| **Safe** | `docs/` + `ui/` + `service/**.py`, not excluded, not owner-taste-gated | **auto-merges to `main`** (gate green + review APPROVE) |
| **Owner** | engine, `src/state`, auth/secrets, packaging, `cmake`, relay, or `ownerMerge` lanes | gates + reviews, then opens a **`needs-owner-merge` PR** — **never auto-merges** |
| **Never-touch** | the loop's own rulebook (gate scripts, `CLAUDE.md`, specs `00`–`06`, dep pins, `.github`) | hard-rejected — the loop can't edit its own gate or the spec |

The program is ~80% owner-bucket by design (it's engine/auth/packaging work weeks before real users),
so the loop mostly acts as a **gated PR-drafting engine**: progress accrues overnight as green,
reviewed PRs you merge with one click. It can never merge high-stakes work on its own.

## Driving it

- **Status board:** [`STATUS.md`](STATUS.md) — ready / blocked / awaiting-your-merge lanes + the O1–O6
  owner critical path + open owner PRs. Regenerated each cycle by `scripts/first-stranger/status.sh`.
- **Schedule it:** `scripts/first-stranger/install-launchd.sh` (owner-run) → nightly at 02:00.
  - **Not armed (default):** each night just re-plans + gap-verifies + refreshes the board. Zero risk.
  - **Arm it:** `touch docs/first-stranger-program/ARMED` → nightly does the real loop (auto-merge safe,
    owner-PR everything else). Review a rehearsal first.
- **Run once now:** `scripts/first-stranger/nightly.sh --once` (or `--plan` / `--live` / `--check`).
- **Unblock a lane** once its owner task (O1–O6) is done:
  `AL_BACKLOG_JSONL=$PWD/docs/first-stranger-program/backlog.jsonl scripts/auto-loop/discover.sh set-status <id> ready`
- **Halt anything:** `touch docs/auto-loop/STOP` (shared kill switch, checked every cycle + before each merge).

## Files

| path | role |
|------|------|
| `SPEC.md` / `../DEPENDENCY_BOM.md` | the program + its verified license BOM (K4) |
| `backlog.jsonl` | machine source of truth: the 17 lanes (status, `blockedOn`, `ownerMerge`) |
| `lanes/FS-*.md` | per-lane gate-registered plans (written by the loop's Plan phase) |
| `STATUS.md` | owner-blocker dashboard (auto-generated) |
| `LEDGER.md` | append-only audit trail (merges / owner-routes / rejects) |
| `STOP` / `ARMED` | per-program kill switch / live-arm sentinels |
| `.claude/workflows/stranger-loop.workflow.js` | the orchestrator |
| `scripts/first-stranger/{nightly,status,install-launchd}.sh` | scheduler + dashboard + installer |

The loop reuses the classic auto-loop harness verbatim (`scripts/auto-loop/gate.sh`, `merge-one.sh`,
`classify.sh`, worktree lifecycle) with two additive, env-gated seams: `AL_BACKLOG_JSONL`/`AL_LEDGER`
(its own backlog + ledger) and `MOSH_STRANGER_MODE=1` (gate exclusion-list diffs + route them to you
instead of auto-rejecting). The classic `auto-loop` and `polish-loop` are unaffected.
