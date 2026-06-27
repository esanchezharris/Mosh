# polish-loop — autonomous UI polish

A bounded, conservative loop that **self-identifies the next genuinely-natural UI polish**, implements it, opens **one
PR per polish**, and (when armed) **auto-merges to `main`** on a green cheap gate + a hostile adversarial review. It
reuses the proven `auto-loop` harness (isolated worktrees, `gate.sh`, the serial merge-queue, the kill-switch + ledger)
and only adds the missing front-end: an **Identify** phase (scout fan-out → conservative curator) governed by
[`RUBRIC.md`](RUBRIC.md).

## How it works (per cycle)

1. **Identify · Scout** — ~4 read-only agents sweep `ui/src/v2/**`, each on a distinct lens (missing a11y/interactive
   states · `--v2-*` token/spacing consistency · unfinished empty/loading/error states · reduced-motion + alignment
   nits) and propose 0–3 candidates each.
2. **Identify · Curate** — one conservative agent dedupes (vs `polish-log.jsonl` + `git log` + `gh pr list`), applies
   [`RUBRIC.md`](RUBRIC.md), and returns **≤ `maxPerCycle`** polishes **or `stop:true`** when nothing is genuinely natural.
3. **Implement** — each polish in its own worktree (`claude/auto-polish-<slug>`): minimal frontend-only change + a test
   guard → cheap checks → **draft PR** `polish(v2/...): …`.
4. **Merge-queue + Review** — `merge-one.sh prepare` (rebase + exclusion + cheap gate) → **hostile adversarial review**
   (is it a genuine in-scope polish? no scope-creep, no regressions) → `finalize` (squash-merge) when armed.

Fail-closed throughout: gate red or any reviewer doubt → the PR is left open + labeled `needs-human`, never merged.

## Run it

The owner triggers bounded runs (no standing cron). Via the Workflow tool:

```
# 1) Rehearse first — identify + implement + PR + gate + review, but DO NOT merge:
Workflow  name: polish-loop   args: { "dryRun": true,  "cycles": 1, "maxPerCycle": 2 }

# 2) Arm it — auto-merge clean polishes to main, a few PRs at a time:
Workflow  name: polish-loop   args: { "dryRun": false, "cycles": 3, "maxPerCycle": 1, "maxMerges": 3 }
```

**Args:** `cycles` (default 3) · `maxPerCycle` (default 1 → one polish = one PR) · `maxMerges` (default 3) ·
`scouts` (default 4) · `scope` (`a11y` | `visual-ux` (default) | `discretion`) · `dryRun` (default **true**).

## Safety

- **Frontend-only** (the swappable seam) — enforced by `classify.sh`; the C++ binary stays byte-identical.
- **Cheap gate** authorizes every merge: `typecheck + vitest + e2e`.
- **Hostile review** (default-REJECT) runs before every merge.
- **Kill switch:** create `docs/polish-loop/STOP` (or the shared `docs/auto-loop/STOP`) to halt gracefully.
- **Circuit-breaker:** 3 consecutive merge failures halt the run. Bounded by `cycles`/`maxMerges`.
- Merges are recorded in the shared `docs/auto-loop/LEDGER.md`; shipped polishes are tracked in `polish-log.jsonl`.

## Files

- `.claude/workflows/polish-loop.workflow.js` — the workflow.
- `docs/polish-loop/RUBRIC.md` — what counts as a natural polish (the "don't go overboard" definition).
- `docs/polish-loop/polish-log.jsonl` — append-only record of shipped polishes (dedupe seed).
