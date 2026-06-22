# Moshi Phase-4 SFT lane (command-emission LoRA)

Fine-tune a local LLM (LoRA) to emit Moshi's `{intent, commands}` replies, so it can
drive the DAW through `BrainProxy` without the cloud brain. This is the rung that
teaches **content generation** (note/clip population) — the thing GEPA proved
prompt-tuning cannot ([docs/MOSHI_TRAINING_RUNG_SCOPE.md](../../docs/MOSHI_TRAINING_RUNG_SCOPE.md)).

Standalone lane (like `ui/src/gepa/`), **not** wired into the audio-LoRA scaffold in
`service/training/`. Serving reuses `BrainProxy`'s `OPENAI_BASE_URL` seam — zero C++ change.

> **Apple Silicon only.** mlx-lm is arm64 + Metal. The full RunPod/CUDA run is a
> separate deferred rung (reuse the scaffold's `MOSH_TRAINING_REMOTE_URL` protocol).

## Prerequisites
- Apple-Silicon Mac. The 4-bit Qwen3-4B LoRA smoke-train fits ~16 GB unified memory
  with the default light knobs (`--num-layers 8 --batch-size 1 --grad-checkpoint`);
  32 GB+ gives headroom to scale up.
- A directory of real DAW projects (`.rpp` / `.als` / `.flp`) for dataset volume — the
  in-repo `~/mosh-demo-projects` corpus is tiny (proves plumbing, not quality).

## 1. Setup (one-time)
```bash
service/sft/setup-sft.sh          # creates service/sft/.venv (mlx-lm), writes .sft.env
source service/sft/.sft.env       # exports SFT_PY
```

## 2. Build the dataset (chat JSONL)
```bash
cd ui && npm run build-sft -- --corpus ~/mosh-demo-projects --out ../service/sft/.sft-data/sft-v1 && cd ..
# real volume: add --corpus <your big DAW-projects dir> (and --tuples ~/Library/Mosh/session/tuples.jsonl)
```
Writes `train/valid/test.jsonl` (chat), `test.eval.jsonl` (verifier eval set), `manifest.json`.

## 3. Smoke-train the LoRA (local)
```bash
"$SFT_PY" service/sft/sft_cli.py train \
  --data service/sft/.sft-data/sft-v1 \
  --out service/sft/.adapters/sft-v1
# then fuse to a standalone served model:
"$SFT_PY" service/sft/sft_cli.py fuse \
  --adapter service/sft/.adapters/sft-v1 \
  --out service/sft/.fused/sft-v1
```

## 4. Serve + eval (the DoD number)
```bash
# serve the fine-tuned model OpenAI-compatible
"$SFT_PY" -m mlx_lm server --model service/sft/.fused/sft-v1 --port 8080 &

# IMPORTANT: mlx_lm.server does NOT ignore the request `model` field — it must match
# a served model id (a mismatch returns empty content). Check the exact id:
curl -s http://127.0.0.1:8080/v1/models     # → use the "id" of your fused model

# point Mosh's brain (or just the eval) at it — OPENAI_MODEL must be that served id
export MOSHI_BRAIN_PROVIDER=openai OPENAI_BASE_URL=http://127.0.0.1:8080/v1 \
       OPENAI_MODEL="<id from /v1/models>" OPENAI_API_KEY=local

# DoD: clean-apply of the fine-tuned model vs the cloud baseline, over the SAME eval set
cd ui
npm run eval-sft -- --eval ../service/sft/.sft-data/sft-v1/test.eval.jsonl --tag finetuned --model "<id from /v1/models>"
#   (run --tag baseline first with OPENAI_BASE_URL pointed at the cloud brain)
```
(Serving with `--adapter-path` instead of fusing also works, but the request `model`
must then be the base id and adapter routing is less explicit — fuse-then-serve is the
recommended, unambiguous path.)

## Artifacts
- `.adapters/sft-v1/` — LoRA weights + `sft_run.json` (training config, base model, dataset hash).
- `.sft-data/sft-v1/manifest.json` — dataset version + source hashes + split seed (reproducible).
- `.sft-data/sft-v1/eval_results.{baseline,finetuned}.json` — the Phase-4 DoD comparison.

All of `.venv/`, `.sft-data/`, `.adapters/`, `.fused/`, `.sft.env` are gitignored.

## Data-rights
The corpus derives arrangements/note data from third-party projects → **internal-only
cold-start**. Do not redistribute fine-tuned weights without a rights review
(arrangement-as-derivative-work is unresolved). Escalation trigger before any
non-local / RunPod training on scraped projects.
