#!/usr/bin/env python3
"""Phase-4 SFT trainer CLI — a thin, reproducible wrapper over mlx-lm LoRA.

Subcommands (JSON result to stdout; all training chatter to stderr, per the
service carve-out convention):

  train  --data DIR --out ADAPTER_DIR [--model ID] [--iters N] [--batch-size N]
         [--num-layers N] [--lr F] [--max-seq-length N] [--no-mask-prompt]
  fuse   --model ID --adapter ADAPTER_DIR --out FUSED_DIR

`train` shells `python -m mlx_lm lora --train` over a chat-format dataset dir
(train.jsonl / valid.jsonl) and records service/sft/.adapters/<x>/sft_run.json
(resolved args + base model + mlx-lm version + dataset manifest hash + timestamp)
so a run is reproducible. mlx-lm is Apple-Silicon only; this CLI must run under the
dedicated sft venv (~/Library/Mosh/venvs/sft) interpreter (see setup-sft.sh)."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time

DEFAULT_MODEL = "mlx-community/Qwen3-4B-Instruct-2507-4bit"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def mlx_lm_version():
    try:
        import mlx_lm  # noqa
        return getattr(mlx_lm, "__version__", "?")
    except Exception as e:  # pragma: no cover
        return f"import-error: {e}"


def manifest_hash(data_dir):
    p = os.path.join(data_dir, "manifest.json")
    if not os.path.isfile(p):
        return None
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:16]


def run_train(a):
    data = os.path.abspath(a.data)
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    for split in ("train.jsonl", "valid.jsonl"):
        if not os.path.isfile(os.path.join(data, split)):
            return {"ok": False, "error": f"missing {split} in {data} (run `npm run build-sft` first)"}

    cmd = [
        sys.executable, "-m", "mlx_lm", "lora",
        "--model", a.model,
        "--train",
        "--data", data,
        "--iters", str(a.iters),
        "--batch-size", str(a.batch_size),
        "--num-layers", str(a.num_layers),
        "--learning-rate", str(a.lr),
        "--fine-tune-type", "lora",
        "--adapter-path", out,
    ]
    if not a.no_grad_checkpoint:
        cmd += ["--grad-checkpoint"]  # trade compute for memory; drop it on a big-RAM Mac for ~2-3x speed
    if a.max_seq_length:
        cmd += ["--max-seq-length", str(a.max_seq_length)]
    if not a.no_mask_prompt:
        cmd += ["--mask-prompt"]  # loss on the completion only — the system prompt dominates each example

    log(f"$ {' '.join(cmd)}")
    t0 = time.time()
    # training progress → stderr so stdout stays clean JSON
    proc = subprocess.run(cmd, stdout=sys.stderr, stderr=sys.stderr)
    dur = round(time.time() - t0, 1)
    if proc.returncode != 0:
        return {"ok": False, "error": f"mlx_lm lora exited {proc.returncode}", "seconds": dur}

    run = {
        "schema_version": 1,
        "base_model": a.model,
        "adapter_path": out,
        "dataset_dir": data,
        "dataset_manifest_sha256": manifest_hash(data),
        "config": {
            "iters": a.iters, "batch_size": a.batch_size, "num_layers": a.num_layers,
            "learning_rate": a.lr, "fine_tune_type": "lora",
            "mask_prompt": not a.no_mask_prompt, "max_seq_length": a.max_seq_length, "grad_checkpoint": not a.no_grad_checkpoint,
        },
        "mlx_lm_version": mlx_lm_version(),
        "seconds": dur,
    }
    with open(os.path.join(out, "sft_run.json"), "w") as f:
        json.dump(run, f, indent=2)
    return {"ok": True, "adapter_path": out, "seconds": dur, "run": run}


def run_fuse(a):
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    cmd = [sys.executable, "-m", "mlx_lm", "fuse", "--model", a.model, "--adapter-path", os.path.abspath(a.adapter), "--save-path", out]
    log(f"$ {' '.join(cmd)}")
    proc = subprocess.run(cmd, stdout=sys.stderr, stderr=sys.stderr)
    if proc.returncode != 0:
        return {"ok": False, "error": f"mlx_lm fuse exited {proc.returncode}"}
    return {"ok": True, "fused_path": out}


def main():
    ap = argparse.ArgumentParser(description="Mosh Phase-4 SFT trainer (mlx-lm LoRA)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("train")
    t.add_argument("--data", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--model", default=DEFAULT_MODEL)
    t.add_argument("--iters", type=int, default=300)
    t.add_argument("--batch-size", type=int, default=1)
    t.add_argument("--num-layers", type=int, default=8)
    t.add_argument("--lr", type=float, default=1e-5)
    # 4096, not 2048: the system prompt is ~3k tokens, so 2048 truncated the note
    # target off the end and the model only ever saw a few notes (it collapsed to a
    # ~3-note pattern). 4096 fits the system prompt + a full pattern target.
    t.add_argument("--max-seq-length", type=int, default=4096)
    t.add_argument("--no-mask-prompt", action="store_true")
    t.add_argument("--no-grad-checkpoint", action="store_true", help="disable gradient checkpointing (faster; needs more RAM)")
    t.set_defaults(fn=run_train)

    f = sub.add_parser("fuse")
    f.add_argument("--model", default=DEFAULT_MODEL)
    f.add_argument("--adapter", required=True)
    f.add_argument("--out", required=True)
    f.set_defaults(fn=run_fuse)

    a = ap.parse_args()
    try:
        result = a.fn(a)
    except Exception as e:  # pragma: no cover
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(result))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
