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

## Cloud (CUDA) run — RunPod / Vast.ai

mlx-lm is Apple-Silicon only; a rented NVIDIA box trains with **trl + peft**
instead, consuming the **same** chat-JSONL (`build-sft` output is portable). Flow:

```bash
# on the box (Linux + NVIDIA), after uploading the dataset dir + these scripts:
bash setup-sft-cuda.sh
python sft_cuda_train.py --data ./sft-v2 --out ./adapter --epochs 1        # 80GB: bf16 LoRA
#   40GB card → add --4bit (QLoRA).  short test → --max-steps 200
# serve OpenAI-compatible:
vllm serve Qwen/Qwen3-4B-Instruct-2507 --enable-lora --lora-modules sft=./adapter --port 8000
```
Then eval from the Mac against the box (same metric, same eval set, vs the 0.757 baseline):
```bash
cd ui && OPENAI_BASE_URL=http://<box-ip>:8000/v1 OPENAI_API_KEY=x \
  npm run eval-sft -- --eval ../service/sft/.sft-data/sft-v2/test.eval.jsonl --n 150 --model sft --tag finetuned-cuda
```
This is the multi-epoch run the local Mac can't do — the real test of whether the
100k-arrangement corpus closes the content-generation gap.

## Note-population — the content-quality fixes

The first runs nailed the deterministic ops (tempo, mixer, add-clip) but failed the
one task that needs real content generation: *"write a short pattern into the clip."*
Three separate bugs stacked up, each fixed here:

1. **Unfair metric.** The eval graded a populate reply by multiset recall against the
   source clip's *exact* note count (often 64), so a perfectly good 6-note pattern
   scored 6/64 ≈ 0.09. `ui/src/gepa/metric.ts` now uses `fairRecall`, which caps the
   required multiplicity of any one command at `SHORT_PATTERN_NOTES` (8) — a "short
   pattern" gets full credit; deterministic single-op gold is graded exactly as before.
2. **Truncated targets.** `max_seq_length` was 2048, but Moshi's system prompt is ~3k
   tokens — the note target was truncated off the end and the model never saw a full
   pattern (it collapsed to ~3 notes). Default is now **4096** (fits prompt + pattern).
3. **No assistant masking on CUDA.** trl's `assistant_only_loss` needs a chat template
   with `{% generation %}` tags; Qwen3's lacks them, so the first cloud run fell back to
   full-sequence loss — the ~3k-token system prompt dominated the gradient and the model
   learned to **defer** on note population. `sft_cuda_train.py` now injects the tags into
   the real template (byte-identical render → no train/serve skew). The mlx lane already
   masks via `--mask-prompt`.

Verify the masking fix GPU-free (tokenizer only):
```bash
source service/sft/.sft.env && "$SFT_PY" service/sft/verify_mask.py
# → OK  no skew · assistant mask = …/… tokens — loss on the completion only
```

## Data-rights
The corpus derives arrangements/note data from third-party projects → **internal-only
cold-start**. Do not redistribute fine-tuned weights without a rights review
(arrangement-as-derivative-work is unresolved). Escalation trigger before any
non-local / RunPod training on scraped projects.
