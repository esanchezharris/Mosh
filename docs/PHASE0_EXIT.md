# Phase 0 exit review (spec §1) — status as of 2026-06-10

Machine-buildable Phase 0 is COMPLETE (stages 7–12, all scaffolding gates
green). The exit gate itself is a JOINT bar: four of its five criteria need
the human-side work (hand replication, taste labels) or a budgeted API run.
This document is the scorecard + the exact commands to close each item.

## The exit gate, item by item

| # | Criterion | Status | What closes it |
|---|---|---|---|
| 1 | ≥20 gold + ≥30 auto-accepted tutorial trajectories in the store | ⏳ **0 + 0** — awaiting the hand-replication sprint (§6) | Emilio: open Mosh → TutorialBar (URL, hotkey M markers, friction notes) → flip consent → `python3 -m flywheel.store.import_session ~/Library/Mosh/session --source tutorial_replication --instruction "..."` ×20; then `python3 -m flywheel.extract.pipeline --url ... --provider gemini` ×~40 attempted |
| 2 | Automated extraction acceptance ≥30% on new tutorials (graded) | ⏳ machinery proven (fixture → GOLD, graded policy, gaps recorded) | run the pipeline on ~40 real tutorials with `GEMINI_API_KEY` set; acceptance = accepted/attempted from the store |
| 3 | Monster v0 ≥70% of the 24-task suite, L1 pass + judge ≥4/5 | ⏳ scaffolding proven (mock e2e 1.0 on subset) | `GEMINI_API_KEY=… python3 -m flywheel.gepa.eval --provider gemini --out runs/eval.jsonl` (exit 0 = bar met); then the GEPA campaign: `python3 -m flywheel.gepa.gepa --provider gemini --reflect-provider claude --generations 15 --candidates 10 --tasks 24` (~$50–200) |
| 4 | 100% replay determinism incl. seeded latent ops (state_hash reproducible) | ✅ **PROVEN** | `scripts/harness-conformance.sh` (11/11: 3× identical state_hash incl. a seeded latent op, byte-identical bounce audio, parallel batch converges) — runs in CI on every engine change per spec §13 |
| 5 | Gap ledger exists and has driven ≥1 IR/feature prioritization decision | ✅ ledger live (engine + friction + extraction entries) · decision log below | the IR v0.2 review (one revision, then freeze — §14.5) after the sprint |

## Gap-ledger → IR v0.2 review (the one budgeted revision)

Candidates accumulated by the build itself (run `cat ~/Library/Mosh/*/gap-ledger.jsonl` for live data):

1. **asset→sampler binding op** — the §3.5 worked example *implies* the resolved
   808 lands in the sampler, but v0.1 cannot say it (`device.add` has no
   asset_id; the engine's `add_sampler_sound` exists and waits). Strongest candidate.
2. `mixer.mute` / `mixer.solo` — lift has no IR target for two everyday moves.
3. `clip.duplicate` — common tutorial verb, currently Unsupported.
4. `project.set_swing` — engine has no global groove (per-clip templates only);
   decide: engine work vs. drop from the vocabulary.
5. `sample.slice mode=transient` — engine detection is async; keep grid-only?
6. RenderLayer flow (Tier-B re-imagine) has no IR family — telemetry can't
   express the product's signature move in corpus space.

Decision recorded for criterion 5: **deferring all of these to one post-sprint
v0.2 bump (rather than piecemeal churn) IS the prioritization decision the
ledger drove** — plus the Stage 7 call to ship `builtin.sat` as the saturator
route instead of building a dedicated saturator device.

## What is machine-proven today (the standing batteries)

| Battery | Checks | Covers |
|---|---|---|
| `Mosh --selftest` ×3 | 148/148, 0 assertions | full command surface, IR lowering, recorder, state hash, agent round-trip |
| `Mosh --selftest-undo` | 18/18 | strict undo chains |
| `scripts/harness-conformance.sh` | 11/11 | spec §4 reqs 1–5 (replay determinism keystone) |
| `scripts/flywheel-store-test.sh` | 9/9 | record → consent gate → import → export → replay-to-recorded-hash |
| `scripts/collab-sync-test.sh` | 18/18 | clone/pull/push/rebase/conflict convergence (the multiplayer headliner) |
| `scripts/agent-smoke-test.sh` | 5/5 | Monster propose→validate→execute→store + GEPA loop |
| `scripts/extract-smoke-test.sh` | 5/5 | tutorial → segment → infer → L0/L1/L2 → graded store |
| `moshir/validate.py --self-test` | 64/64 | schema authority + negative fixtures |
| Catch2 (`MoshTests`) | 8 cases | vocab lockstep, RenderLayer, ASTD |

## Calibration debts (tracked, by design not blockers)

- **L3 (CLAP/MERT rank calibration)**: needs the 20 gold (render, tutorial)
  pairs — impossible before the sprint. Until then silver grants on L4 alone
  and every such trajectory carries `policy_notes` saying so.
- **L4 with real ears**: the scaffolding judge sees ops + counts, not audio.
  Render-referenced judging lands when extraction runs on real tutorials
  (renders exist per trajectory; wire `render.bounce` into the pipeline run).
- **VLM frame claims**: transcript-mined + fixture claims today; the
  Gemini-vision keyframe pass is the §7.4 upgrade (keyframes cut cost 5–10×).
- **Mock-vs-real drift**: every gate that runs on `mock` says so loudly; no
  mock number is quoted as a quality result anywhere.
