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
- [`rfc/`](rfc/) — the **append-only go-forward decision log**: ARCHITECTURE_REVIEW.md is the
  frozen v0 record; architectural decisions made after it get an RFC here (problem, options,
  decision, mandatory verification plan). Ledger: [`rfc/INDEX.md`](rfc/INDEX.md).

## Status / what's done

*The IA here is deliberate: ONE rolling status doc (`CURRENT_STATUS.md`), dated frozen
snapshots under `resumption/`, and dated session notes under `worklog/`. Handoff docs are
history, not status.*

- [`../CLAUDE.md`](../CLAUDE.md) — the run manifest: prime directives + per-stage gate ledger.
  Source of truth for *what's done / what's next*. Auto-loads each session.
- [`CURRENT_STATUS.md`](CURRENT_STATUS.md) — **the one rolling status/handoff doc** (refreshed
  in place; start here for "where are we right now").
- [`resumption/`](resumption/) — dated, frozen status snapshots (each was ground truth on its
  date; none is updated after). Includes the 2026-07-02 ground-truth status & context
  extraction ([`2026-07-02-ground-truth-status-and-context.md`](resumption/2026-07-02-ground-truth-status-and-context.md),
  moved from `docs/CURRENT_STATUS_AND_CONTEXT.md` on 2026-07-28) and the 2026-06-30
  resumption maps.
- [`STATUS_HANDOFF_2026-07-11.md`](STATUS_HANDOFF_2026-07-11.md) — frozen dated snapshot:
  the 2026-07-11 audited ground-truth handoff (repo state, in-progress threads, owner
  decisions, infra hazards). History — superseded by `CURRENT_STATUS.md`.
- [`worklog/`](worklog/INDEX.md) — the dated session notes / post-mortems (one file per
  note). The history spine; grep it before assuming a problem is new.
- [`PROGRESS.md`](PROGRESS.md) — the older chronological milestone log (frozen history;
  being retired in the 2026-07-28 docs wave).
- [`CONSOLIDATION_2026-07-09.md`](CONSOLIDATION_2026-07-09.md) — the Codex→Claude
  consolidation ledger (every PR/branch/worktree dispositioned; the git-store rescue);
  [`CONSOLIDATION_LOOP.md`](CONSOLIDATION_LOOP.md) is the reusable procedure.
- [`fitness-check/`](fitness-check/) — the standing weekly project-audit loop's reports.
- [`VERIFICATION.md`](VERIFICATION.md) — the hardware-verification runbook (does it make sound,
  mic/voice, two-peer multiplayer) and its results.
- [`MULTIPLAYER.md`](MULTIPLAYER.md) — the 2-player collaboration model: what syncs vs. stays
  local (independent playheads), track locks + commit-on-move, audio-clip/SA3 stem sync, the
  connect/join UX, and known limits. Read before a live session.
- [`TESTER_QUICKSTART.md`](TESTER_QUICKSTART.md) — the full guest-facing, non-developer
  walkthrough: install past Gatekeeper, first-launch permissions, sound check, join a
  session, what to try first (incl. the SA3/preview engine badge), the optional real-AI
  local setup, known quirks, and how to send diagnostics if something breaks.
- [`PLAYTEST_SETUP.md`](PLAYTEST_SETUP.md) — short host-side pointer to
  `TESTER_QUICKSTART.md` (this used to be the guest doc itself; it's now a redirect).

## Programs & loops (active work)

- [`vocal-map-program/`](vocal-map-program/) — **the active program**: the
  vocal-first 2026-09-17 playtest milestone, decision-complete spec, rolling
  status, research roster, and append-only decision log.
- [`first-stranger-program/`](first-stranger-program/) — paused and superseded
  historical program state; its automation is stopped and its backlog, lanes,
  board, and evidence are preserved. Its configured ledger target never became
  a tracked file before the pause.
- [`playtest-prep/`](playtest-prep/) — playtest preparation checklists and evidence.
- [`demo-loop/`](demo-loop/) + [`demo/`](demo/) — demo-session state and artifacts.
- [`polish-loop/`](polish-loop/) — the autonomous UI micro-polish loop's charter + ledger.
- [`superpowers/`](superpowers/) — active design-sprint specs and plans (completed ones move
  to [`archive/superpowers/`](archive/superpowers/)).
- [`agent-bench/`](agent-bench/) — MoshAgentBench: the multi-step agent eval ("can the agent
  actually *operate* Mosh"), graded by executed state on the real headless engine —
  scoreboards, baselines, and session reports.
- [`testing/`](testing/) — testing notes and protocols.

## Training program (beats, taste, SFT)

- [`RESTART_HANDOFF.md`](RESTART_HANDOFF.md) — the real-recipes restart handoff (generation by
  retrieval/recombination of real ingredient recipes; RL frozen).
- [`TRAINING_JOURNAL.md`](TRAINING_JOURNAL.md) — the owner taste-pack journal (generated by
  `scripts/verify-hardware/build_journal.py` from the label ledger — regenerate, don't edit).
- [`bench/`](bench/) — the staged training program: pre-registrations, gate reads, scoreboards,
  spend ledger, round changelog ([`bench/PROGRAM_STAGE1_2026-07.md`](bench/PROGRAM_STAGE1_2026-07.md)
  is the execution record; SFT gate reads live in `../service/sft/GATE_READ_*.md`).
- [`AUTONOMOUS_SFT.md`](AUTONOMOUS_SFT.md) — the autonomous SFT pipeline design
  (corpus → back-translation → LoRA → verifier eval).
- [`research-policy/`](research-policy/) — owner decisions on research-tracked corpus material.
- [`CORPUS_PROVENANCE.md`](CORPUS_PROVENANCE.md) — corpus source provenance.

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
- [`fms-lyrics-bench/`](fms-lyrics-bench/) — the FMS lyrics-first program charter + decision
  ledger; its `SCOREBOARD.md` is machine-regenerated by `service/lyrics/bench/bench_cli.py`
  (never hand-edit).

## Engine & feature reference

- [`ENGINE_API_NOTES.md`](ENGINE_API_NOTES.md) — Tracktion Engine API resolutions + the file-based
  fallbacks taken (resolved against the pinned clone `2877b621`).
- [`IPHONE_COMPANION.md`](IPHONE_COMPANION.md) — the remote companion architecture + endpoints.
- [`type-beat-trainer.md`](type-beat-trainer.md) — the LoRA type-beat trainer (scaffold + fake
  backend; real on-device training deferred).
- [`REAL_RECIPES_SOURCE_SELECTION.md`](REAL_RECIPES_SOURCE_SELECTION.md) — Phase 0 tutorial/source
  selection rubric for bootstrapping recipe-library material without committing media.
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
- [`WINDOWS_PARITY.md`](WINDOWS_PARITY.md) + [`WINDOWS_RUNBOOK.md`](WINDOWS_RUNBOOK.md) — the
  per-feature Windows-parity decision record and the Windows build runbook.
- [`2026-07-07-linux-build-spike.md`](2026-07-07-linux-build-spike.md) — the exploratory
  Linux (x86_64) build spike (FIT-011).
- [`DEPENDENCY_BOM.md`](DEPENDENCY_BOM.md) — the dependency bill of materials;
  [`2026-07-10-cpm-cache-icloud-eviction.md`](2026-07-10-cpm-cache-icloud-eviction.md) records
  why dep caches live OUTSIDE the iCloud-synced source tree.
- [`release/SIGNING_RUNBOOK.md`](release/SIGNING_RUNBOOK.md) — the signing & notarization
  runbook: local build → Gatekeeper-clean DMG/zip a stranger can double-click.
- [`telemetry/PRIVACY.md`](telemetry/PRIVACY.md) — the crash-reporting/telemetry privacy
  contract (opt-in, default OFF; module `src/telemetry/`).
- [`brain-proxy/RUNBOOK.md`](brain-proxy/RUNBOOK.md) — the owner runbook for the brain-key
  token proxy (getting LLM provider keys out of the shipped bundle).

## Templates

- [`templates/executive-loop-protocol.md`](templates/executive-loop-protocol.md) — the
  conservative executive-loop protocol template: trunk-first fetch, low-risk squash-merge rules,
  human-gated surfaces, duplicate-thread/PR guard, memory note format, and final reporting
  checklist.

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
