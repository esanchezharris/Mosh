# Docs index

The map of Mosh's documentation. **New here? Read [`../ARCHITECTURE.md`](../ARCHITECTURE.md) first.**

## Start here

- [`../README.md`](../README.md) — what Mosh is + how to build/run.
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — the verified 2-minute **map**: module layout + the
  two contracts (MoshOps command surface, snapshot/events). The source of truth for *where things
  are*; "if it drifts, fix it here."
- [`../ARCHITECTURE_REVIEW.md`](../ARCHITECTURE_REVIEW.md) — the **decisions** doc: every
  significant architectural choice at a conceptual level, with rationale and the rejected
  alternative, for red-teaming. The source of truth for *why it's built this way*. (Map vs.
  rationale — two different lenses; both current.)

## Status / what's done

- [`../CLAUDE.md`](../CLAUDE.md) — the run manifest: prime directives + per-stage gate ledger.
  Source of truth for *what's done / what's next*. Auto-loads each session.
- [`CURRENT_STATUS.md`](CURRENT_STATUS.md) — short handoff summary (the TL;DR of PROGRESS).
- [`PROGRESS.md`](PROGRESS.md) — chronological milestone log (newest at bottom).
- [`VERIFICATION.md`](VERIFICATION.md) — the hardware-verification runbook (does it make sound,
  mic/voice, two-peer multiplayer) and its results.
- [`MULTIPLAYER.md`](MULTIPLAYER.md) — the 2-player collaboration model: what syncs vs. stays
  local (independent playheads), track locks + commit-on-move, audio-clip/SA3 stem sync, the
  connect/join UX, and known limits. Read before a live session.
- [`PLAYTEST_SETUP.md`](PLAYTEST_SETUP.md) — guest-facing setup for a live playtest (install an
  unsigned build past Gatekeeper, join a session).

## Specs (the detailed design — "how")

Repo root, each with a status banner. `02` lives here in `docs/`; there is no standalone `03`
(the WebView UI is covered by ARCHITECTURE.md + `02`).

- [`../00_MOSH_MASTER_SPEC.md`](../00_MOSH_MASTER_SPEC.md) — start of the spec chain.
- [`../01_ENGINE_STATE_AND_SOURCE_GRAPH.md`](../01_ENGINE_STATE_AND_SOURCE_GRAPH.md)
- [`02_MOSHOPS_CONTRACT.md`](02_MOSHOPS_CONTRACT.md) — the command catalog + result envelope.
- [`../04_PLUGIN_CHAIN_AND_REALTIME_NEURAL.md`](../04_PLUGIN_CHAIN_AND_REALTIME_NEURAL.md)
- [`../05_GENERATIVE_LAYER.md`](../05_GENERATIVE_LAYER.md)
- [`../06_BUILD_TOOLING_AND_RUN_PLAN.md`](../06_BUILD_TOOLING_AND_RUN_PLAN.md)
- [`../07_DEFERRED_AND_MODEL_NOTES.md`](../07_DEFERRED_AND_MODEL_NOTES.md) — parking lot / model
  landscape (context, not build work).
- [`../AGENTS.md`](../AGENTS.md) — the agent capability surface (commands Moshi can execute).

### Finish My Song (lyric completion → mumble → own-voice)

- [`FINISH_MY_SONG_LYRICS_SPEC.md`](FINISH_MY_SONG_LYRICS_SPEC.md) — the **"why"**: v1 scope (lyrics only).
- [`FINISH_MY_SONG_LYRICS_BUILD_SPEC.md`](FINISH_MY_SONG_LYRICS_BUILD_SPEC.md) — the **"how"**: the
  validator-loop architecture, component stack, command surface (supersedes the scoping spec on detail).
- [`FINISH_MY_SONG_ROADMAP.md`](FINISH_MY_SONG_ROADMAP.md) — the full arc: Phase 1 (text) → Phase 2
  (mumble→skeleton) → Phase 3 (own-voice render, parked).

## Engine & feature reference

- [`ENGINE_API_NOTES.md`](ENGINE_API_NOTES.md) — Tracktion Engine API resolutions + the file-based
  fallbacks taken (resolved against the pinned clone `2877b621`).
- [`IPHONE_COMPANION.md`](IPHONE_COMPANION.md) — the remote companion architecture + endpoints.
- [`type-beat-trainer.md`](type-beat-trainer.md) — the LoRA type-beat trainer (scaffold + fake
  backend; real on-device training deferred).
- [`MOSHI_IMPORTERS.md`](MOSHI_IMPORTERS.md) — the DAW project-file importer (`.rpp`/`.als`/`.flp`
  → `moshIR` → MoshOps replay; code in `ui/src/import/`).
- [`MOSHI_TRAJECTORY_FORMAT.md`](MOSHI_TRAJECTORY_FORMAT.md) — the agent-training tuple format +
  the JSONL-log harvester / live loop (code in `ui/src/harvest/`).
- [`../service/README.md`](../service/README.md) — the generative service endpoints
  (`/submit`, `/colors`, `/transcribe`, `/sketch`) across Fake / Mac-SA3 / PC-CUDA adapters.
- [`../supabase/README.md`](../supabase/README.md) — the cloud multiplayer relay
  (Postgres + Edge Function); local stdlib relay lives in `relay/`. Native side: `src/multiplayer/`.
- [`FEATURE_AUDIT.md`](FEATURE_AUDIT.md) — the **DAW-parity scoreboard**, regenerated from a live
  conformance run (`scripts/daw-conformance/`) against the real command surface (134/152 in-scope
  eval rows pass). Supersedes the 2026-06-09 baseline audit, now archived under
  [`archive/feature-audit-2026-06-09/`](archive/feature-audit-2026-06-09/).
- [`reality-pack/`](reality-pack/) — the versioned cross-DAW reality model (canonical DAW ontology,
  152 conformance invariants, the eval suite) the scoreboard + conformance gate replay against.
- [`auto-loop/`](auto-loop/) — the autonomous deferred-work loop's backlog + ledger
  (`backlog.jsonl`, the G1–G14 parity gaps that drive it).

## Future roadmap (post-v0, not yet built)

- [`plans/`](plans/) — the "wave" specs grounded in the pinned engine:
  [automation](plans/wave-automation.md), [metering](plans/wave-metering.md),
  [recording](plans/wave-recording.md), [sends](plans/wave-sends.md),
  [settings](plans/wave-settings.md).

## Design

- [`../design-lab/`](../design-lab/) — the Moshi-character design taste reference
  (`HOUSE_STYLE.md`, `LOOKBOOK.md`). A living reference, not build status.

## Archive (frozen, kept for history)

- [`archive/consolidation/`](archive/consolidation/) — 2026-06-08/09 consolidation-wave reports.
- [`archive/hardening/`](archive/hardening/) — 2026-06-11/12 DAW-hardening reports.
- [`archive/superpowers/`](archive/superpowers/) — completed design-sprint specs/plans (voice
  triggers, project-file safety, drums, docs on-ramp, agent rail).
- [`archive/test-iterate-loop/`](archive/test-iterate-loop/) — the 2026-06-19 bug-fix campaign
  ledger (PRs #62–#68).
- [`archive/ponytail-audit-report.md`](archive/ponytail-audit-report.md) — the 2026-06-19
  architecture-aware cleanup audit.

> Recoverable git history also lives in `archive/*` **tags** (not files): e.g.
> `archive/ui-rebuild-9f72c67`, `archive/fervent-gagarin-aefecc` — deleted experiment branches,
> recoverable with `git checkout -b <name> <tag>`.
