#!/usr/bin/env python3
"""CUDA LoRA SFT for the Moshi command-emission model — the RunPod / Vast.ai path.

mlx-lm (the local Mac trainer) is Apple-Silicon only, so a rented NVIDIA box uses
this trl + peft trainer instead. It consumes the SAME chat-format JSONL the mlx
lane produces (`npm run build-sft` → train.jsonl / valid.jsonl with {"messages":[…]})
so nothing about the dataset changes — only the trainer. Run ON the box after
setup-sft-cuda.sh. Result (adapter) is then served OpenAI-compatible with vLLM and
the eval points OPENAI_BASE_URL at it (see service/sft/README.md).

JSON result to stdout; training chatter to stderr."""
import argparse
import json
import os
import sys
import time


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="dir with train.jsonl / valid.jsonl")
    ap.add_argument("--model", default="Qwen/Qwen3-4B-Instruct-2507")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--max-steps", type=int, default=-1)
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--grad-accum", type=int, default=2)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--max-seq-len", type=int, default=2048)
    ap.add_argument("--4bit", dest="bit4", action="store_true", help="QLoRA (fits a 40GB card); omit on 80GB for bf16 LoRA")
    ap.add_argument("--no-assistant-loss", action="store_true", help="train on the full sequence instead of assistant turns only")
    ap.add_argument("--no-grad-ckpt", action="store_true", help="disable gradient checkpointing (faster; fine on 80GB)")
    ap.add_argument("--save-steps", type=int, default=0, help="checkpoint every N steps (0 = only at end; set >0 so SSH drops can't lose work)")
    a = ap.parse_args()

    import torch
    from datasets import load_dataset
    from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
    from peft import LoraConfig
    from trl import SFTTrainer, SFTConfig

    train_f = os.path.join(a.data, "train.jsonl")
    if not os.path.isfile(train_f):
        print(json.dumps({"ok": False, "error": f"missing {train_f} (run `npm run build-sft` and upload the dataset dir)"}))
        sys.exit(1)
    data_files = {"train": train_f}
    valid_f = os.path.join(a.data, "valid.jsonl")
    if os.path.isfile(valid_f):
        data_files["validation"] = valid_f
    ds = load_dataset("json", data_files=data_files)
    log(f"loaded {len(ds['train'])} train examples")

    tok = AutoTokenizer.from_pretrained(a.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    quant = None
    dtype = torch.bfloat16
    if a.bit4:
        quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=dtype, bnb_4bit_use_double_quant=True)
    # transformers 5.x renamed torch_dtype -> dtype; passing the old name is silently
    # ignored and the model loads in fp32 (2x memory -> OOM). Use dtype.
    model = AutoModelForCausalLM.from_pretrained(a.model, quantization_config=quant, dtype=dtype, device_map="auto")

    peft_cfg = LoraConfig(r=a.lora_r, lora_alpha=a.lora_r * 2, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM", target_modules="all-linear")

    cfg = SFTConfig(
        output_dir=a.out,
        per_device_train_batch_size=a.batch_size,
        gradient_accumulation_steps=a.grad_accum,
        num_train_epochs=a.epochs,
        max_steps=a.max_steps,
        learning_rate=a.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        bf16=True,
        logging_steps=20,
        save_strategy=("steps" if a.save_steps > 0 else "epoch"),
        save_steps=(a.save_steps if a.save_steps > 0 else 500),
        eval_strategy="no",
        max_length=a.max_seq_len,
        # loss on the assistant turns only — Moshi's system prompt dominates each
        # example (the CUDA analog of mlx's --mask-prompt). Needs a chat template
        # with generation tags; --no-assistant-loss falls back to full-sequence.
        assistant_only_loss=not a.no_assistant_loss,
        packing=False,
        gradient_checkpointing=not a.no_grad_ckpt,
        report_to=[],
    )

    trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds["train"], peft_config=peft_cfg, processing_class=tok)
    log("starting training…")
    t0 = time.time()
    trainer.train()
    trainer.save_model(a.out)
    tok.save_pretrained(a.out)
    dur = round(time.time() - t0, 1)

    run = {
        "schema_version": 1, "base_model": a.model, "adapter_path": a.out, "dataset_dir": a.data,
        "config": {"epochs": a.epochs, "max_steps": a.max_steps, "batch_size": a.batch_size, "grad_accum": a.grad_accum,
                   "lr": a.lr, "lora_r": a.lora_r, "max_seq_len": a.max_seq_len, "qlora_4bit": a.bit4,
                   "assistant_only_loss": not a.no_assistant_loss},
        "seconds": dur,
    }
    with open(os.path.join(a.out, "sft_run.json"), "w") as f:
        json.dump(run, f, indent=2)
    print(json.dumps({"ok": True, "out": a.out, "seconds": dur}))


if __name__ == "__main__":
    main()
