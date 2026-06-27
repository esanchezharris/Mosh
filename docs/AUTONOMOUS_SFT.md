# Autonomous SFT — train a local model to drive Mosh

Turn a large corpus of real DAW projects into a **local LLM that emits Moshi's
`{intent, commands}` replies**, so it can drive the DAW through `BrainProxy` with no cloud
brain. This is the Phase-4 rung: it teaches **content generation** (note/clip population) —
the thing GEPA proved prompt-tuning alone cannot ([MOSHI_TRAINING_RUNG_SCOPE.md](MOSHI_TRAINING_RUNG_SCOPE.md)).

The loop is **autonomous**: the only reward is the deterministic verifier
(clean-apply × gold-command-name recall) — no human labels, no audio model. The *chosen brain*
is used once, offline, to make the data richer (back-translation), not in the training loop.

```
DAW projects ──importers──► command programs ──slice──► (utterance → commands) tasks
  (.flp/.als/.rpp/.mid)      (ui/src/import)             (ui/src/sft/buildDataset)
                                                              │
                       brain back-translation ◄──────────────┘   (ui/src/sft/backtranslate)
                       (natural producer phrasings)
                                                              │
                                                              ▼
              chat JSONL ──mlx-lm LoRA──► adapter ──fuse──► local model ──serve──► BrainProxy slot
              (build-sft)  (service/sft)                                   (OPENAI_BASE_URL)
                                                              │
                                       verifier eval (clean-apply) ◄───────┘  baseline=cloud vs finetuned=local
```

## One command

```bash
service/training/autotrain.sh        # corpus → dataset → train → fuse → serve → eval
```
Each stage is idempotent (skips when its artifact exists; `FORCE_DATA=1`, `FORCE_TRAIN=1`, … to redo).
Knobs: `ITERS`, `BATCH`, `LAYERS`, `MIDI_SAMPLE`, `MIDI_LIMIT`, `DAW_LIMIT`, `BT_VARIANTS`, `EVAL_N`.

## Prereqs (one-time)

```bash
service/flp/setup-flp.sh             # PyFLP venv (Python 3.10) — only needed for .flp
service/sft/setup-sft.sh             # mlx-lm venv (Apple Silicon)
# brain key in ui/.env.local (OPENAI_API_KEY + MOSHI_BRAIN_PROVIDER=openai) —
# used for back-translation AND the cloud-baseline eval.
```

## The pieces (and what's new)

| Stage | Code | New? |
|---|---|---|
| Acquire corpus | `service/corpus/get_datasets.sh` (Lakh+Groove MIDI), `scrape_packs.py` (DAW repos) | **new** |
| Ingest project files | `ui/src/import/` (`.flp/.als/.rpp/.mid` → MoshOps commands) | existing |
| Slice → tasks | `ui/src/sft/buildDataset.ts` (`sliceProgramFull`) | existing |
| **Back-translation** | `ui/src/sft/backtranslate.ts` — brain rewrites each templated *shape* into diverse natural phrasings (slot-preserving), reused across the corpus | **new** |
| Build chat JSONL | `ui/scripts/buildSft.mts` (`--backtranslate K --bt-variants N`) | extended |
| LoRA train / fuse | `service/sft/sft_cli.py` (mlx-lm, Qwen3-4B-Instruct-2507-4bit) | existing |
| Serve (brain slot) | `mlx_lm server` → `BrainProxy` `OPENAI_BASE_URL` (zero C++) | existing |
| Eval (reward) | `ui/scripts/evalSft.mts` + `ui/src/gepa/metric.ts` | existing |
| Orchestrate | `service/training/autotrain.sh` | **new** |

### Back-translation — the brain-unlocked step

The importer slices carry only mechanical utterances ("set the tempo to 132", "write a short
pattern into the clip on the X track"). `backtranslate.ts` replaces a templated utterance's
variable parts (track names, numbers) with slots `{0},{1}`, asks the brain for N natural
producer phrasings that keep the slots ("Can you lock the BPM to {0}?", "Lay a short idea into
the clip on {0}"), then fills the slots per slice. Because it back-translates each distinct
*shape* once (cached to `bt_cache.json`), ~10 brain calls cover the whole 180k-file corpus, and
the target commands stay the verified ground truth — classic instruction-backtranslation.

## Why this is autonomous

The reward (`evalSft` / `metric.ts`) is the **verifier**: does the model's reply parse, are the
commands in the catalog, do the args validate, does it clean-apply through the mock backend, and
do the command names match the gold multiset? All deterministic, audio-free, free. No human in
the loop. The cloud brain only synthesizes utterances offline; the trained model never depends on
it at run time.

## Serving the trained model as Moshi's brain

```bash
source service/sft/.sft.env
"$SFT_PY" -m mlx_lm server --model service/sft/.fused/sft-v1 --port 8080 &
curl -s http://127.0.0.1:8080/v1/models      # → the served id
# point Mosh at it (zero rebuild): in ui/.env.local or the launch env —
export MOSHI_BRAIN_PROVIDER=openai OPENAI_BASE_URL=http://127.0.0.1:8080/v1 \
       OPENAI_MODEL="<served id>" OPENAI_API_KEY=local
```

## Artifacts (all gitignored)

- `~/mosh-corpus/` — the corpus (MIDI + DAW projects). Provenance: `service/corpus/SOURCES.md`.
- `service/sft/.sft-data/sft-v1/` — `train/valid/test.jsonl`, `test.eval.jsonl`, `bt_cache.json`, `manifest.json`.
- `service/sft/.adapters/sft-v1/` — LoRA weights + `sft_run.json` (reproducible config).
- `service/sft/.fused/sft-v1/` — standalone served model.
- `service/sft/.sft-data/sft-v1/eval_results.{baseline,finetuned}.json` — the DoD comparison.

## Results (first full run, 2026-06-27)

The loop runs end-to-end and **balanced training is a real, measured win**, but the local 4B is
**behind** the cloud — honest numbers below. (Earlier in this run a "0.89, beats cloud" figure
appeared; it was a **serving artifact** — see the tokenizer gotcha — not the model's real score.)

Decode-fair clean-apply (`metric.ts` = clean-apply × gold-command-name recall) on the frozen,
**balanced** v2 eval set (`--max-tokens 2500`, n=300, identical subsample):

| model | clean-apply | deferrals |
|---|---:|---:|
| original unbalanced LoRA (iter-200) | 0.416 | 51 |
| **balanced LoRA (v2, iter-400, correct tokenizer)** | **0.619** | 57 |
| cloud `gpt-5.4-mini` | **0.875** | 18 |

What balancing fixed (vs the unbalanced run): capping note-population at 8 and giving each command
type comparable exposure drove **arg-type errors 77 → 17** and lifted the model **0.42 → 0.62**.
Remaining gap (of 300): **57 "acts-shy"** (acknowledges a question-phrased ask — "Can you bump the
tempo?" — without emitting the command), **66 wrong-command**, **17 arg-type**. These are
content/behavior gaps that need more/targeted training (question-form utterances, command-selection
signal), not a decode trick — a 4B closing on a frontier cloud model is a real hill.

**Dataset:** v2 = 7,315 balanced train examples (add_midi_clip 96→1,350, mixer ~1,476,
tempo/timesig ~2,800, populate ~1,300 capped at 8), built from `~/mosh-corpus` (179k Lakh MIDI +
~73 parseable DAW projects) with brain back-translation (~12 shapes, ~22 brain calls).
**Training:** batch 1, 16 layers, lr 2e-5, max-seq 2560, ~9 s/iter on an M1 Max, converged by
iter-400 (~1 h). Harvest = best checkpoint by the clean-apply metric (early-stop on metric, not loss).

### ⚠️ Serving gotcha — tokenizer must match training
`mlx_lm.server`, when **online**, can resolve `/v1/models` to a *similarly-named* HF model and load
**its** chat template (here it grabbed `Huihui-Qwen3.5-4B-...`, whose template differs from our
`Qwen3-4B-Instruct-2507-4bit` base by a few chars). A mismatched template silently swings the score
(it inflated 0.62 → 0.89 by nudging the model to act). **Always serve with the model's own tokenizer:**
run the server with `HF_HUB_OFFLINE=1` (the fused model carries the correct, byte-identical template),
and verify `/v1/models` reports `mlx-community/Qwen3-4B-Instruct-2507-4bit`. Eval/serve flakiness was
also caused by **two mlx servers colliding on port 8080** — run one eval at a time, clean.

## Continuously autonomous (next)

The harvest infra (`ui/src/harvest/`) captures live `(utterance → commands)` tuples from real
app sessions. Fold them into `build-sft --tuples ~/Library/Mosh/session/tuples.jsonl`, retrain,
and re-evaluate against the frozen set — the loop self-improves from real usage with the same
deterministic reward.
