# Docs Index

A map of what's canonical, what's a supporting reference, and what's a (possibly
stale) status snapshot. Light navigation aid — the specs themselves remain the
source of truth for **how**; `CLAUDE.md` is the source of truth for **what's done /
what's next**.

## Canonical — the spec set (source of truth for *how*)

Read in order, starting at `00`:

| Spec | Location | Covers |
|------|----------|--------|
| 00 | [`00_MOSH_MASTER_SPEC.md`](../00_MOSH_MASTER_SPEC.md) | Master build spec — start here |
| 01 | [`01_ENGINE_STATE_AND_SOURCE_GRAPH.md`](../01_ENGINE_STATE_AND_SOURCE_GRAPH.md) | Engine, state, source graph |
| 02 | [`02_MOSHOPS_CONTRACT.md`](02_MOSHOPS_CONTRACT.md) | MoshOps + the state feed (reconstructed; lives in `docs/`) |
| 03 | — | **Not written as a file.** The WebView UI (`03`) was built directly against the `02` contract; `CLAUDE.md` references `03_WEBVIEW_UI.md` but no such file exists. |
| 04 | [`04_PLUGIN_CHAIN_AND_REALTIME_NEURAL.md`](../04_PLUGIN_CHAIN_AND_REALTIME_NEURAL.md) | Plugin chain + Tier-A real-time neural |
| 05 | [`05_GENERATIVE_LAYER.md`](../05_GENERATIVE_LAYER.md) | Tier-B generative layer |
| 06 | [`06_BUILD_TOOLING_AND_RUN_PLAN.md`](../06_BUILD_TOOLING_AND_RUN_PLAN.md) | Build tooling + run plan |
| 07 | [`07_DEFERRED_AND_MODEL_NOTES.md`](../07_DEFERRED_AND_MODEL_NOTES.md) | Context / parking-lot (model landscape, deferred lanes) — not build work |

## Canonical — run state

- [`CLAUDE.md`](../CLAUDE.md) — the run manifest: prime directives, stage gates, and
  the `// VERIFY` ledger. The authority on what's done and what's next.
- [`ENGINE_API_NOTES.md`](ENGINE_API_NOTES.md) — resolved `// VERIFY` items against the
  pinned `tracktion_engine` clone (exact signatures, file-based fallbacks taken).

## Supporting references

- [`ARCHITECTURE_REVIEW.md`](../ARCHITECTURE_REVIEW.md) — architecture review handoff.
- [`AGENTS.md`](../AGENTS.md) — agent/contributor guidance.
- [`IPHONE_COMPANION.md`](IPHONE_COMPANION.md) — the iOS companion app notes.

## Status snapshots — may be stale, treat as historical

These are point-in-time logs, **not** maintained continuously. As of this index they
predate the Moshi-reactivity work, the UI rebuild, and the testing/cleanup pass — check
the git log and `CLAUDE.md` before trusting them.

- [`PROGRESS.md`](PROGRESS.md) — progress log (last substantive update 2026-06-09).
- [`FEATURE_AUDIT.md`](FEATURE_AUDIT.md) — feature audit dashboard (last update 2026-06-09).
