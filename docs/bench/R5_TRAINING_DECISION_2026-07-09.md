# R5 training decision note - 2026-07-09

Status at 2026-07-09T06:08:53Z: do not restart r4. The prepared r5 data is a
candidate for the next run only.

## Decision

- Current restart decision: `continue-r4`.
- Reason: the r4 target audit passed. The live r4 command still targets
  `s2-mix-v4`, train/valid counts match `12889/1650`, and v4 train contains the
  required corrective rows.
- Restart condition: restart only if the current r4 target is proven wrong or
  incomplete, or if r4 later misses its registered gate.
- Non-restart reasons: assist demos, evaluator sidecar metadata, and the existence
  of an r5 idea are not enough to interrupt the live run.

## Live r4 check

`service/sft/monitor-r4.sh --no-gate` was read before this note.

- Progress: `2700/12889` (`20.95%`)
- Training: yes, on detached `s2-mix-v4`
- Gate: pending
- Latest line: `Iter 2440: Train loss 0.097`
- Action: `none`

No gate was run because the monitor did not report `action: run-gate-read`.

## Prepared r5 candidate

Manifest:
`service/sft/.sft-data/s2-mix-v5-prep/manifest.json`

- Base mix: detached `s2-mix-v4`
- Audit report:
  `service/sft/.sft-data/s2-mix-v5-prep/r4_target_audit.json`
- Evaluator sidecar:
  `service/sft/.sft-data/s2-mix-v5-prep/evaluator_sidecar.jsonl`
- Assist rows: `15`
- Pre-filter counts: train `12904`, valid `1650`
- Post-filter counts: train `12904`, valid `1650`
- Length drops: train `0`, valid `0`
- Candidate status: ready-to-run data only; not an active training launch.

r5-prep composition:

- `12889` copied r4 train rows
- `15` validated assist demo rows appended to train only
- `1650` copied valid rows

r4 target audit counts:

- v4 train: `12889`
- v4 valid: `1650`
- `offset-coords.jsonl`: `155` rows, present in train
- `render-routing.jsonl`: `60` rows, present in train
- stale `r4-renderparam.jsonl`: `0` rows

## Evaluator sidecar

The sidecar is metadata only. It must not mutate SFT labels or become scorer
power without a later owner-label benchmark.

- Sidecar rows: `108`
- Gemini: disabled
- External model calls during prep: none
- `ranker_score` rows: `25`
- Source field for `ranker_score`: `predictedKeep`
- Source file: `/Users/emiliosanchez-harris/mosh-beats/labels/labels.jsonl`

`ranker_score` distribution:

| group | n | min | max | mean |
|---|---:|---:|---:|---:|
| all | 25 | 0.6421 | 0.8423 | 0.720396 |
| pack-005 | 11 | 0.6421 | 0.8423 | 0.721064 |
| pack-006 | 14 | 0.6484 | 0.8338 | 0.719871 |

Lowest five:

| source_run | audio_path | ranker_score |
|---|---|---:|
| pack-005 | `01_dark_140_Aminor.wav` | 0.6421 |
| pack-005 | `06_chill_132_Dminor.wav` | 0.6462 |
| pack-006 | `01_aggressive_152_Gminor.wav` | 0.6484 |
| pack-006 | `09_chill_132_Csminor.wav` | 0.6490 |
| pack-005 | `02_dark_140_Eminor.wav` | 0.6538 |

Highest five:

| source_run | audio_path | ranker_score |
|---|---|---:|
| pack-005 | `11_emotional_148_Aminor.wav` | 0.8423 |
| pack-006 | `14_aggressive_152_Csminor.wav` | 0.8338 |
| pack-005 | `03_aggressive_152_Fminor.wav` | 0.8067 |
| pack-006 | `13_emotional_148_Eminor.wav` | 0.7804 |
| pack-005 | `12_dark_140_Csminor.wav` | 0.7561 |

## Clean staging plan

No files are staged by this note. If creating a clean branch or commit series, use
these boundaries.

### Commit A: r5 prep tooling and decision docs

- `service/sft/audit_r4_target.py`
- `service/sft/build_evaluator_sidecar.py`
- `service/sft/prepare_r5_prep.py`
- `service/sft/README.md`
- `docs/plans/2026-07-r5-assist-audio-eval-bridge.md`
- `docs/bench/PROGRAM_STAGE1_2026-07.md`
- `docs/bench/R5_TRAINING_DECISION_2026-07-09.md`

Generated data stays untracked/ignored:

- `service/sft/.sft-data/s2-mix-v5-prep/`

### Commit B: assist bridge

- `service/sft/assist_demonstrations.jsonl`
- `service/sft/assist_fixtures/fixture_roles.json`
- `service/sft/assist_fixtures/fixture_snap.json`
- `service/sft/assist_fixtures/ledger.json`
- `ui/scripts/build_assist_sft.mts`
- `ui/scripts/assembleMix.mts`
- `ui/src/agent/fastPath.ts`
- `ui/src/agent/fastPath.test.ts`
- `ui/src/ui/AgentComposer.tsx`

### Commit C: r4 monitor/gate support

- `service/sft/monitor-r4.sh`
- `service/sft/run-gate-r4.sh`
- `service/sft/GATE_READ_r4.md`
- `service/sft/TRAINING_HANDOFF.md`

### Exclude from this slice unless separately requested

- `docs/auto-loop/BACKLOG.md`
- `docs/auto-loop/backlog.jsonl`
- `docs/resumption/2026-06-30-clean-resumption-map.md`
- `docs/resumption/2026-07-08-codex-pr-branch-triage.md`

## Next trigger

Poll r4 with:

```sh
cd service/sft
./monitor-r4.sh --no-gate
```

Run `./run-gate-r4.sh` only when the monitor reports completion and
`action: run-gate-read`. If r4 passes, hold `s2-mix-v5-prep` as optional future
data. If r4 misses, use this prepared r5 candidate as the obvious next run base.
