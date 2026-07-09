# RunPod CUDA Cutover For `a3b-r4`

This runbook is the canonical operational path for reproducing the live `a3b-r4`
recipe on a transient RunPod CUDA box without touching the active MLX seat.

## Required local inputs

- base model: `Qwen/Qwen3-30B-A3B-Instruct-2507`
- dataset: `service/sft/.sft-data/s2-mix-v4`
- launcher: `service/sft/launch-r4-cuda.sh`
- trainer: `service/sft/sft_cuda_train.py`
- serving path: `service/sft/serve_openai.py`
- control script: `service/sft/runpod_r4.py`

## Provisioning target

- GPU class: one 80 GB NVIDIA GPU
- preferred order:
  - `NVIDIA A100 80GB PCIe`
  - `NVIDIA A100-SXM4-80GB`
  - `NVIDIA H100 PCIe`
  - `NVIDIA H100 80GB HBM3`
- image: `runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04`
- allowed CUDA versions: `11.8` by default, matching the image tag; override
  with `runpod_r4.py create --allowed-cuda-versions ...` if the image changes.
- cloud type: `ALL`
- pod volume: `200 GB`
- container disk: `100 GB`
- remote root: `/workspace/ClaudeMosh`

The control script injects the local SSH public key through RunPod's
`PUBLIC_KEY` environment variable so the pod is immediately reachable over SSH
once a public IP and port mapping are assigned.

## Pre-launch local checks

From the repo root:

```bash
bash -n service/sft/launch-r4-cuda.sh service/sft/setup-sft-cuda.sh
python3 -m py_compile service/sft/runpod_r4.py service/sft/sft_cuda_train.py service/sft/serve_openai.py
python3 service/sft/sft_cuda_train.py --help | rg "last-layers|layers-to-transform|layers-pattern|resume-from-checkpoint"
```

These checks confirm the parity launcher exists, the CUDA trainer still exposes
the layer-scoping surface, and the OpenAI-compatible serving shim is the active
path instead of `vllm`.

## Pod create / status

Keep the RunPod key in the shell only:

```bash
export RUNPOD_API_KEY=...
python3 service/sft/runpod_r4.py create
python3 service/sft/runpod_r4.py status
```

`create` is idempotent for the configured pod name. If the pod already exists and
is not terminated, the script returns the existing pod summary instead of
requesting another GPU.

## Bootstrap the box

Once `status` reports a public IP and SSH port:

```bash
python3 service/sft/runpod_r4.py bootstrap
```

This uploads:

- `service/sft/setup-sft-cuda.sh`
- `service/sft/sft_cuda_train.py`
- `service/sft/launch-r4-cuda.sh`
- `service/sft/serve_openai.py`
- `service/sft/README.md`
- `service/sft/.sft-data/s2-mix-v4`

Then it runs `setup-sft-cuda.sh` remotely and verifies:

- `nvidia-smi` is available on the pod
- pinned `torch` / `transformers` / `trl` / `peft` install cleanly
- `python3 sft_cuda_train.py --help` still exposes `--last-layers`
- `python3 sft_cuda_train.py --help` still exposes `--resume-from-checkpoint`

## Training launch

The launcher is the source of truth for recipe parity:

```bash
python3 service/sft/runpod_r4.py train
```

That remote command is recovery-safe:

```bash
python3 service/sft/runpod_r4.py train
```

Behavior:

- if training is already alive, it no-ops and returns the existing pid
- if training is down and checkpoint directories exist, it relaunches with the
  latest `checkpoint-*` as `RESUME_FROM_CHECKPOINT`
- if no checkpoint exists yet, it starts a fresh run with the canonical recipe

The launcher preserves the current `a3b-r4` defaults as closely as practical in
`trl + peft`:

- `--model Qwen/Qwen3-30B-A3B-Instruct-2507`
- `--data ./.sft-data/s2-mix-v4`
- `--out ./.adapters/a3b-r4-cuda`
- `--max-steps 12889`
- `--batch-size 1`
- `--grad-accum 1`
- `--lr 1e-5`
- `--max-seq-len 4096`
- `--last-layers 16`
- assistant-only loss enabled
- bf16 LoRA by default
- `--save-steps 200`

## Artifact preservation

Keep three layers after training:

1. Training source of truth:
   `service/sft/.adapters/a3b-r4-cuda/` plus `sft_run.json`
2. Conversion source of truth:
   merged Hugging Face model directory
3. Deploy artifact:
   MLX-converted quantized model for local Mac inference

Do not delete the adapter directory after merge or MLX conversion.

## Serving and frozen evals

Serve the finished adapter from the CUDA box with:

```bash
python3 service/sft/serve_openai.py \
  --base Qwen/Qwen3-30B-A3B-Instruct-2507 \
  --adapter /workspace/ClaudeMosh/service/sft/.adapters/a3b-r4-cuda \
  --model-id a3b-r4-cuda \
  --port 8000
```

Then point the frozen eval surfaces at `http://<pod-ip>:8000/v1` and record the
results separately from the live MLX run:

- frozen-300
- `evalA`
- grounded section B execution

## Post-training conversion

Merge the adapter into the Hugging Face base on the CUDA box, then convert the
merged local path to MLX:

```bash
mlx_lm.convert --hf-path ./merged-a3b-r4-cuda --mlx-path ./mlx-a3b-r4-cuda-4bit -q
```

`mlx_lm.convert` accepts a local Hugging Face-format directory, so no Hub upload
is required for this step.

## Current external blocker

As of July 8, 2026, the scripted create path is working locally, but RunPod did
not allocate a pod:

- `NVIDIA A100 80GB PCIe`: `SUPPLY_CONSTRAINT`
- `NVIDIA A100-SXM4-80GB`: `SUPPLY_CONSTRAINT`
- `NVIDIA H100 PCIe`: `SUPPLY_CONSTRAINT`
- `NVIDIA H100 80GB HBM3`: `INSUFFICIENT_BALANCE`

That means the repo-side cutover is ready, but live execution still requires
either available 80 GB capacity or more RunPod balance.

If RunPod stays blocked, the provider-neutral fallback is
`service/sft/CUDA_PROVIDER_PORTABLE_a3b-r4.md`.
