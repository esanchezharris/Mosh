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
service/sft/setup-sft.sh          # creates ~/Library/Mosh/venvs/sft (mlx-lm), writes .sft.env
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
python serve_openai.py --base Qwen/Qwen3-4B-Instruct-2507 --adapter ./adapter --port 8000
```
Then eval from the Mac against the box (same metric, same eval set, vs the 0.757 baseline):
```bash
cd ui && OPENAI_BASE_URL=http://<box-ip>:8000/v1 OPENAI_API_KEY=x \
  npm run eval-sft -- --eval ../service/sft/.sft-data/sft-v2/test.eval.jsonl --n 150 --model sft --tag finetuned-cuda
```
This is the multi-epoch run the local Mac can't do — the real test of whether the
100k-arrangement corpus closes the content-generation gap.

## CUDA parity run for a3b-r4

The local `a3b-r4` run is pinned to `s2-mix-v4`, 12,889 steps, lr `1e-5`,
sequence length `4096`, completion-only loss, and the last 16 transformer layers.
The CUDA lane can now preserve those same recipe choices as closely as the
`trl + peft` stack allows:

```bash
cd service/sft
bash setup-sft-cuda.sh
chmod +x launch-r4-cuda.sh
./launch-r4-cuda.sh
```

That launcher defaults to:

```bash
python3 sft_cuda_train.py \
  --data ./.sft-data/s2-mix-v4 \
  --model Qwen/Qwen3-30B-A3B-Instruct-2507 \
  --out ./.adapters/a3b-r4-cuda \
  --epochs 1 \
  --max-steps 12889 \
  --batch-size 1 \
  --grad-accum 1 \
  --lr 1e-5 \
  --lora-r 16 \
  --max-seq-len 4096 \
  --last-layers 16 \
  --save-steps 200
```

Use `BIT4=1 ./launch-r4-cuda.sh` on a smaller card when you need QLoRA; keep the
default bf16 LoRA on an 80 GB box when possible.

Serve the finished adapter for the frozen evals with:

```bash
python serve_openai.py \
  --base Qwen/Qwen3-30B-A3B-Instruct-2507 \
  --adapter ./.adapters/a3b-r4-cuda \
  --model-id a3b-r4-cuda \
  --port 8000
```

## RunPod control surface for a3b-r4

The local control script is `service/sft/runpod_r4.py`. It never stores the
RunPod key in repo state; set it in the shell only when you execute a command:

```bash
export RUNPOD_API_KEY=...
python3 service/sft/runpod_r4.py create
python3 service/sft/runpod_r4.py status
python3 service/sft/runpod_r4.py bootstrap
python3 service/sft/runpod_r4.py train
```

Defaults:

- pod name: `codex-a3b-r4-cuda`
- image: `runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04`
- GPU priority: `NVIDIA A100 80GB PCIe` → `NVIDIA A100-SXM4-80GB` → `NVIDIA H100 PCIe` → `NVIDIA H100 80GB HBM3`
- cloud type: `ALL`
- pod volume: `200 GB`
- container disk: `100 GB`
- remote root: `/workspace/ClaudeMosh`

`create` injects the local SSH public key into the pod via RunPod's `PUBLIC_KEY`
environment variable. `bootstrap` uploads the exact `service/sft` launcher,
trainer, serve shim, README, and `s2-mix-v4` dataset tarball to the pod, then
runs `setup-sft-cuda.sh` remotely and verifies that `sft_cuda_train.py --help`
still exposes `--last-layers` and `--resume-from-checkpoint`.

`status` prints the current pod summary plus an SSH command once RunPod has
assigned a public IP and mapped port `22`. `train` is recovery-safe: it no-ops
if the trainer is already alive, otherwise it resumes from the newest
`checkpoint-*` directory when one exists. `stop` and `resume` call the RunPod
GraphQL lifecycle mutations for the same pod name or id.

For the full operational sequence, artifact preservation rules, and the current
live RunPod blocker state, see `service/sft/RUNPOD_a3b-r4.md`.

## CUDA adapter → MLX inference artifact

The safest post-training path is:

1. Keep the adapter dir from `sft_cuda_train.py` as the canonical training artifact.
2. Merge it into the full-precision Hugging Face base:

```bash
python - <<'PY'
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

base = "Qwen/Qwen3-30B-A3B-Instruct-2507"
adapter = "./.adapters/a3b-r4-cuda"
out = "./merged-a3b-r4-cuda"

model = AutoModelForCausalLM.from_pretrained(base, torch_dtype="auto", device_map="auto")
model = PeftModel.from_pretrained(model, adapter)
model = model.merge_and_unload()
model.save_pretrained(out, safe_serialization=True)
AutoTokenizer.from_pretrained(base).save_pretrained(out)
PY
```

3. Convert and quantize that merged model for Mac inference:

```bash
mlx_lm.convert --hf-path ./merged-a3b-r4-cuda --mlx-path ./mlx-a3b-r4-cuda-4bit -q
```

`mlx_lm.convert --help` in the current local environment confirms that `--hf-path`
accepts either a local path or a Hugging Face model identifier, so a private Hub
upload is optional for this conversion step.

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
# → OK  Qwen/Qwen3-4B-Instruct-2507  ·  no skew · mask = …/… tokens, EOS in span — loss on the completion only
# → OK  mlx-community/Qwen3-4B-Instruct-2507-4bit  ·  no skew · mask = …/… tokens, EOS in span — loss on the completion only
```

## Data-rights
The corpus derives arrangements/note data from third-party projects → **internal-only
cold-start**. Do not redistribute fine-tuned weights without a rights review
(arrangement-as-derivative-work is unresolved). Escalation trigger before any
non-local / RunPod training on scraped projects.

## Assist-feature demonstrations (fold into the NEXT dataset build)

`assist_demonstrations.jsonl` contains 15 engine-verified AI-assisted micro asks:
producer commands like "double the melody up an octave", "swing the hats",
"high-pass the melody", "compress the bass", and "mute everything but the drums
and bass". They are rendered by `ui/scripts/build_assist_sft.mts` in the same
`{messages:[system,user,assistant]}` chat-JSONL shape as the normal SFT corpus:
system = `buildSystemPrompt(DEFAULT_RULES, fixtureSnapshot)`, user = the ask,
assistant = the verified `{intent, commands}` reply.

Regenerate without touching a running training dataset:

```bash
cd ui
npx tsx scripts/build_assist_sft.mts
```

For r5, include them through `assembleMix.mts` so they are train-only and recorded
in the manifest:

```bash
cd ui
npx tsx scripts/assembleMix.mts \
  --base ../service/sft/.sft-data/<base> \
  --synth ../service/sft/.sft-data/synth \
  --assist ../service/sft/assist_demonstrations.jsonl \
  --out ../service/sft/.sft-data/s2-mix-v5
```

Do not append these rows to `s2-mix-v4` or any dataset an active job is training
on. The current r4 run is frozen and protected by `service/sft/monitor-r4.sh`.

## R5 prep while r4 runs

Use these scripts to prepare a candidate `s2-mix-v5-prep` dataset without
starting another MLX job or mutating the detached r4 runtime files.

First audit the live r4 target:

```bash
cd service/sft
python3 audit_r4_target.py --out .sft-data/s2-mix-v5-prep/r4_target_audit.json
```

The audit verifies the monitor command still targets `s2-mix-v4`, train/valid
counts are `12889/1650`, and the v4 train file contains the 155
`offset-coords.jsonl` rows plus the 60 `render-routing.jsonl` rows. It
intentionally treats empty stale `r4-renderparam.jsonl` as non-source material.

Then build the local r5 candidate:

```bash
cd service/sft
python3 prepare_r5_prep.py
```

`prepare_r5_prep.py` copies r4 `train.jsonl` and `valid.jsonl` into
`.sft-data/s2-mix-v5-prep`, appends the 15 assist demonstrations to train only,
runs `filter_by_length.py` on that prep directory only, and writes
`.sft-data/s2-mix-v5-prep/manifest.json` with source paths, row counts, hashes,
the r4 monitor snapshot, restart policy, and the evaluator sidecar path.

The sidecar is built by `build_evaluator_sidecar.py`. It reads existing local
label or bench JSONL sources only, includes ranker/Audiobox/CLAP fields only
when those fields already exist in the source rows, and writes Gemini as
disabled. It does not call Gemini, Audiobox, CLAP, SA3, MLX, or any fused model.

Restart policy remains explicit: keep r4 running unless `audit_r4_target.py`
proves the current target is wrong or incomplete. Assist rows, sidecar metadata,
and the existence of an r5 idea are not restart reasons.

## Session-render drift (2026-07-28)

The two session renderers were unified into `ui/src/agent/sessionRender.ts`, so
every system prompt now carries a `master: …` line (plus key/tempo-map/buses
when the session has them). See
`docs/superpowers/specs/2026-07-28-one-session-renderer-design.md`.

- `add_note_corrective.jsonl` and `assist_demonstrations.jsonl` were regenerated
  against the new render. Both builders are deterministic — re-run and byte-diff.
- **`r5_train_additions.jsonl` (105 rows) was NOT regenerated.** It has no
  builder; a hand rewrite of the `system` field would be mechanical but
  unverifiable, which is worse than a file that is known-stale. Its rows carry
  the pre-2026-07-28 render. Regenerate or re-curate it before the next
  local-seat training run — a train/serve prompt-shape mismatch is exactly the
  class of problem the r5 4-bit serve read already cost us.

The shipped cloud seat is unaffected: it reads the prompt live.
