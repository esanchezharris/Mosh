# Project Fitness Check — repeatable audit spec

*The standing health audit for Mosh. A weekly scheduled cloud agent runs this; a human can run it by hand any time. It is **read + doc-write only** — it discovers, refills the backlog, and reports. It never runs the native gate or merges code (that needs the owner's Mac + real models). The owner's local **auto-loop** then burns down the `ready` items it files.*

## Why this exists
The `auto-loop` *implements* items already in `docs/auto-loop/backlog.jsonl` and only refills on depletion. Nothing was periodically *auditing* the project for new drift — stale ports, aging deferred work, doc lag. This checklist is that missing standing audit: run it on a cadence so the backlog stays fed and platform drift surfaces early instead of at release time.

## How to run
1. Work from the latest `origin/main` (fetch first). Reconcile against `main`, not a stale worktree — a fix may have already merged (e.g. the compiler bundle gap was open in a worktree but fixed on `main` by #241).
2. Measure each check below. Record the concrete evidence (file path, git date, count).
3. Diff against the newest prior `docs/fitness-check/REPORT-*.md` (the ledger) — report only what **changed** plus any threshold breach.
4. For each new/worsened finding, append a ticket to `docs/auto-loop/backlog.jsonl` (see *Refill rules*).
5. Write `docs/fitness-check/REPORT-<YYYY-MM-DD>.md` and open a PR with the report + backlog delta.

## The checks

| # | Check | How to measure | Threshold → flag |
|---|-------|----------------|------------------|
| 1 | **Platform freshness** | `git log -1 --format=%cs` on `run-mosh.ps1`, each Windows/Linux preset in `CMakePresets.json`, `service/adapters/stable_audio3_cuda.py`. Compare to `main` HEAD date. | Any active platform port > **14 days** behind HEAD with no commits → flag "port drifting". |
| 2 | **CI health** | Does `.github/workflows/` exist? If yes, is the newest run green? | No CI at all → standing flag until it lands. CI red > 3 days → flag. |
| 3 | **Deferred-item aging** | Scan `CLAUDE.md` "Deferred (do not build)" + working-note `NEXT:` / `parked` / `owner-gated`. Cross-check each against code (is it actually still undone?). | An item still open **> 30 days** after it was introduced → flag for a keep-or-cut decision. |
| 4 | **Doc drift** | `git log -1 --format=%cs -- CLAUDE.md ARCHITECTURE.md docs/` vs `main` HEAD date; count merged PRs since. (The dated `docs/worklog/` journal and `docs/PROGRESS.md` were pruned in the public-cleanup pass — they no longer exist, do not measure them.) | live docs > **10 days** or > **8 PRs** behind → flag refresh. |
| 5 | **Unfinished markers** | `git grep -nE 'TODO\|FIXME\|HACK\|XXX' -- 'src/**' 'ui/src/**' 'service/**'` count, minus test fixtures. Delta vs last run. | Net **+10** since last run → flag a cleanup sweep. |
| 6 | **Backlog health** | Parse `backlog.jsonl`: `ready` count, oldest-`ready` age (by report first-seen), `needs-human` count. | `ready` **== 0** → refill needed. `needs-human` growing unboundedly (> 15) → flag an owner triage. |
| 7 | **Gate / bundle health** | Last recorded `Mosh --selftest` count vs the baseline in the newest report. Run `python3 service/scripts/bundle_completeness_test.py` (hermetic, static). Note any real-model path that has drifted (adapter signature vs fake golden). | Selftest baseline regressed, bundle-completeness FAIL, or a `service/adapters/*` public signature changed without a golden update → flag. |

## Refill rules (writing tickets)
- **ID namespace:** `FIT-###`, continuing the max `order` in the file. (The loop keys on `status`/`order`; the prefix is cosmetic — the existing `G*` items prove prefix-independence. If the loop ever rejects a non-`AL` prefix, fall back to `AL-###`.)
- **`status`:** `ready` only if an **automated cheap or native gate can prove it done** and the diff touches **no** auto-loop-excluded path (`cmake/`, `run-mosh.sh` + deploy/package, `relay/**`, `*auth*`/`*secret*`, `src/plugins/hosting/**`, `src/engine/MoshEngine.{cpp,h}`, `src/state/**`, `CLAUDE.md` + specs, `.github/**`, model weights). Otherwise `needs-human`.
- **Dedup:** never file a ticket whose `title`/`files` substantially match an existing open item. Match on intent, not exact string.
- **`acceptance`** must be a concrete, checkable done-condition (the loop reads it). **`notes`** must carry `Fitness-check <date>:` + the evidence that triggered it.
- Platform initiatives ineligible for the loop (CI, Windows, Linux) still get a durable `needs-human` backlog entry **and** should be surfaced to the owner as a `spawn_task` chip when run interactively.

## Division of labor (do not blur)
- **This checklist (cloud/manual):** read, measure, refill backlog, write report, open PR. No native build, no gate, no merge.
- **`auto-loop` (owner's Mac):** picks `ready` items, implements in worktrees, runs the full `gate.sh`, adversarial-reviews, fail-closed auto-merges.
- **Owner:** decides `needs-human` items (excluded seams, platform ports, by-ear quality).
