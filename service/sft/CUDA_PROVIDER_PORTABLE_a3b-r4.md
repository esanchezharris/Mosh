# Provider-Portable CUDA Cutover For `a3b-r4`

This is the minimum reproducible package and command surface for moving the
current `a3b-r4` CUDA reproduction to any 80 GB NVIDIA provider, not just
RunPod. The live MLX `r4` seat stays untouched.

## What to upload

Create the portable tarball locally:

```bash
python3 service/sft/runpod_r4.py bundle
```

Default output:

```text
service/sft/.artifacts/a3b-r4-cuda-bundle.tgz
```

That bundle contains the minimum files needed to reproduce training and run the
frozen evals against a remote OpenAI-compatible endpoint:

- `service/sft/setup-sft-cuda.sh`
- `service/sft/sft_cuda_train.py`
- `service/sft/launch-r4-cuda.sh`
- `service/sft/serve_openai.py`
- `service/sft/.sft-data/s2-mix-v4`
- `ui/scripts/evalSft.mts`
- `ui/scripts/evalV2Grounded.mts`
- `ui/scripts/lib/realEngine.mts`
- `ui/package.json`
- the active `service/sft` runbooks

The current main checkout does not carry `s2-mix-v4`; the bundler falls back to
the authoritative detached runtime worktree copy automatically so the archive is
still complete.

## Remote box requirements

- Linux with one 80 GB NVIDIA GPU
- CUDA-visible driver stack
- enough disk for:
  - base model download
  - `s2-mix-v4`
  - checkpoints every 200 steps
  - merged model output
- SSH access

## Remote bootstrap

On the remote box:

```bash
mkdir -p /workspace/ClaudeMosh
tar xzf a3b-r4-cuda-bundle.tgz -C /workspace/ClaudeMosh
cd /workspace/ClaudeMosh/service/sft
bash setup-sft-cuda.sh
nvidia-smi
python3 sft_cuda_train.py --help | grep -E -q -- '--last-layers|--resume-from-checkpoint'
```

## Canonical training command

From `/workspace/ClaudeMosh/service/sft`:

```bash
./launch-r4-cuda.sh
```

The launcher preserves the intended recipe:

- model family: `Qwen/Qwen3-30B-A3B-Instruct-2507`
- data: `./.sft-data/s2-mix-v4`
- out: `./.adapters/a3b-r4-cuda`
- max steps: `12889`
- batch size: `1`
- grad accumulation: `1`
- learning rate: `1e-5`
- max sequence length: `4096`
- layer scope: last 16 transformer layers
- assistant-only loss enabled
- bf16 LoRA by default
- checkpoint cadence: every 200 steps

## Remaining parity gaps vs the live MLX `r4` lane

These are the real gaps that remain after the current CUDA parity work:

1. Trainer stack is different by design.
   MLX uses `mlx_lm lora`; CUDA uses `trl + peft`, so this is recipe parity, not
   byte-identical training parity.
2. Resume orchestration differs, but recovery is now built in.
   The MLX lane uses a local watchdog. The CUDA lane now resumes from the newest
   `checkpoint-*` directory when relaunched through `runpod_r4.py train`, but it
   does not have an always-on out-of-process watchdog yet.
3. Checkpoint cadence differs.
   MLX watchdog progress is reasoned about in 100-step saved segments; CUDA now
   saves every 200 steps for remote recovery.
4. Base artifact differs.
   The live MLX lane trains from a local 4-bit MLX model path; CUDA trains from
   the Hugging Face bf16 base and only later converts back to MLX for Mac
   inference.

Everything else material is aligned in the current repo state: dataset, step
budget, LR, sequence length, completion-only loss behavior, and last-16-layer
adaptation.

## Remote serve command

After training:

```bash
cd /workspace/ClaudeMosh/service/sft
python3 serve_openai.py \
  --base Qwen/Qwen3-30B-A3B-Instruct-2507 \
  --adapter ./.adapters/a3b-r4-cuda \
  --model-id a3b-r4-cuda \
  --port 8000
```

Manual QA for the serve surface:

```bash
curl -fsS http://127.0.0.1:8000/v1/models
curl -fsS http://127.0.0.1:8000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"a3b-r4-cuda","messages":[{"role":"user","content":"reply with {}"}],"max_tokens":32}'
```

## Exact frozen eval commands against the remote endpoint

Run these from the repo's `ui/` directory on any machine that can reach the
remote box and the local Mosh binary:

```bash
cd /path/to/ClaudeMosh/ui
export OPENAI_BASE_URL=http://REMOTE_HOST:8000/v1
export OPENAI_API_KEY=local
export OPENAI_MODEL=a3b-r4-cuda
export MOSHI_BRAIN_PROVIDER=openai
```

Comparator leg, frozen-300:

```bash
npm run eval-sft -- --eval ../service/sft/.sft-data/frozen300/test.eval.jsonl --rules plain --no-think --n 300 --model a3b-r4-cuda --tag a3b-r4-cuda-C
```

Per-command floor leg, `evalA`:

```bash
npm run eval-sft -- --eval ../service/sft/.sft-data/eval-v2/evalA.eval.jsonl --rules plain --no-think --model a3b-r4-cuda --tag a3b-r4-cuda-A
```

Grounded section B:

```bash
npx tsx scripts/evalV2Grounded.mts --base http://REMOTE_HOST:8000/v1 --model a3b-r4-cuda --tag a3b-r4-cuda --no-think
```

`serve_openai.py` ignores the incoming `model` field for generation, but the UI
eval scripts still require a concrete `OPENAI_MODEL` or `--model` value. Use
`a3b-r4-cuda` consistently so the reports are labeled cleanly and the real-engine
helpers accept the configuration.

## Safe live monitor

From the local repo, poll the remote lane without touching the training process:

```bash
export RUNPOD_API_KEY=...
python3 service/sft/runpod_r4.py monitor
python3 service/sft/runpod_r4.py monitor --watch --interval 20
```

That monitor is read-only. It reports the live pod, SSH target, remote trainer
pid, latest checkpoint, inferred training step, elapsed runtime, ETA, checkpoint
loss/token-accuracy/grad-norm, and the latest remote log lines.

## Post-training conversion back to Mac inference

Keep these three artifacts:

1. `./.adapters/a3b-r4-cuda/`
2. `./merged-a3b-r4-cuda/`
3. `./mlx-a3b-r4-cuda-4bit/`

Merge on the CUDA box, then convert from the merged local path:

```bash
mlx_lm.convert --hf-path ./merged-a3b-r4-cuda --mlx-path ./mlx-a3b-r4-cuda-4bit -q
```
