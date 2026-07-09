#!/usr/bin/env python3
"""CUDA LoRA SFT for the Moshi command-emission model — the RunPod / Vast.ai path.

mlx-lm (the local Mac trainer) is Apple-Silicon only, so a rented NVIDIA box uses
this trl + peft trainer instead. It consumes the SAME chat-format JSONL the mlx
lane produces (`npm run build-sft` → train.jsonl / valid.jsonl with {"messages":[…]})
so nothing about the dataset changes — only the trainer. Run ON the box after
setup-sft-cuda.sh. Result (adapter) is then served OpenAI-compatible with
serve_openai.py and the eval points OPENAI_BASE_URL at it (see service/sft/README.md).

JSON result to stdout; training chatter to stderr."""
import argparse
import json
import os
import sys
import time


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def manifest_hash(data_dir):
    """sha256 (first 16 hex) of the dataset's manifest.json, or None if absent —
    the corpus-version fingerprint recorded in sft_run.json (matches the mlx lane)."""
    import hashlib
    p = os.path.join(data_dir, "manifest.json")
    if not os.path.isfile(p):
        return None
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:16]


# trl's assistant_only_loss needs the chat template to mark the assistant turn with
# {% generation %}…{% endgeneration %} so the tokenizer can emit an assistant-token
# mask. Qwen3's stock template has no such tags — so assistant_only_loss=True errored
# and the first cloud run fell back to full-sequence loss (the system prompt then
# dominates the gradient and the model learns to defer on note population). We inject
# the tags into the REAL template, preserving every other byte, so the rendered text
# is byte-identical to what the model is served with (no train/serve skew) — only the
# mask is added.
ASSISTANT_OPEN = '{%- elif message.role == "assistant" %}'
TOOL_OPEN = '{%- elif message.role == "tool" %}'


def inject_generation_tags(template: str) -> str:
    if "{%- generation %}" in template:
        return template
    if template.count(ASSISTANT_OPEN) != 1 or template.count(TOOL_OPEN) != 1:
        raise ValueError("chat template shape unexpected — cannot inject generation tags")
    # Leading-strip markers ({%- … %}) and no added newlines, so the tags emit nothing
    # and the rendered text stays byte-identical to the stock template (verify_mask.py).
    template = template.replace(ASSISTANT_OPEN, ASSISTANT_OPEN + "{%- generation %}", 1)
    template = template.replace(TOOL_OPEN, "{%- endgeneration %}" + TOOL_OPEN, 1)
    return template


def linear_target_modules(model) -> list[str]:
    import torch

    linear_types = {torch.nn.Linear}
    try:
        from bitsandbytes.nn import Linear4bit
        linear_types.add(Linear4bit)
    except Exception:
        pass

    names = set()
    for name, module in model.named_modules():
        if not name or name.endswith("lm_head"):
            continue
        if type(module) in linear_types:
            names.add(name.rsplit(".", 1)[-1])
    if not names:
        raise ValueError("no linear target modules found for LoRA")
    return sorted(names)


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
    # 4096, not 2048: Moshi's system prompt is ~3k tokens, so a 2048 cap truncated
    # the note-population target off the end entirely — the model never saw a full
    # pattern. 4096 fits the system prompt + a real pattern (a few long outliers
    # still clip their tail, which is harmless: the fair metric only needs a short
    # pattern's worth of notes).
    ap.add_argument("--max-seq-len", type=int, default=4096)
    ap.add_argument("--last-layers", type=int, default=0, help="apply LoRA to only the last N transformer layers")
    ap.add_argument("--layers-to-transform", default="", help="comma-separated layer indices to LoRA; overrides --last-layers")
    ap.add_argument("--layers-pattern", default=None, help="PEFT layers_pattern for layer-restricted LoRA, e.g. layers")
    ap.add_argument("--4bit", dest="bit4", action="store_true", help="QLoRA (fits a 40GB card); omit on 80GB for bf16 LoRA")
    ap.add_argument("--no-assistant-loss", action="store_true", help="train on the full sequence instead of assistant turns only")
    ap.add_argument("--no-grad-ckpt", action="store_true", help="disable gradient checkpointing (faster; fine on 80GB)")
    ap.add_argument("--save-steps", type=int, default=0, help="checkpoint every N steps (0 = only at end; set >0 so SSH drops can't lose work)")
    ap.add_argument("--resume-from-checkpoint", default="", help="resume from a saved checkpoint dir under the adapter output")
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

    # Make assistant-only (completion) loss actually work on Qwen3 by injecting the
    # generation tags into its chat template; degrade cleanly to full-sequence loss
    # if the template ever changes shape.
    if not a.no_assistant_loss:
        try:
            tok.chat_template = inject_generation_tags(tok.chat_template)
            log("assistant_only_loss: injected {% generation %} tags into the chat template")
        except ValueError as e:
            # Do NOT silently degrade to full-sequence loss — that's the exact bug
            # this fix exists to prevent (the model learns to defer on note
            # population). Hard-fail; the user can opt into full-sequence on purpose.
            print(json.dumps({"ok": False, "error": f"cannot enable assistant_only_loss: {e}. "
                              "Pass --no-assistant-loss to train full-sequence deliberately."}))
            sys.exit(1)

    quant = None
    dtype = torch.bfloat16
    if a.bit4:
        quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=dtype, bnb_4bit_use_double_quant=True)
    # transformers 5.x renamed torch_dtype -> dtype; passing the old name is silently
    # ignored and the model loads in fp32 (2x memory -> OOM). Use dtype.
    model = AutoModelForCausalLM.from_pretrained(a.model, quantization_config=quant, dtype=dtype, device_map="auto")
    if a.layers_to_transform and a.last_layers:
        print(json.dumps({"ok": False, "error": "use either --layers-to-transform or --last-layers, not both"}))
        sys.exit(1)

    layers_to_transform = None
    if a.layers_to_transform:
        try:
            layers_to_transform = [int(x) for x in a.layers_to_transform.split(",") if x.strip()]
        except ValueError:
            print(json.dumps({"ok": False, "error": "invalid --layers-to-transform; expected comma-separated integers"}))
            sys.exit(1)
    elif a.last_layers:
        hidden_layers = getattr(model.config, "num_hidden_layers", None)
        if hidden_layers is None:
            print(json.dumps({"ok": False, "error": "model config has no num_hidden_layers; pass --layers-to-transform explicitly"}))
            sys.exit(1)
        if a.last_layers < 1 or a.last_layers > hidden_layers:
            print(json.dumps({"ok": False, "error": f"--last-layers must be between 1 and {hidden_layers}"}))
            sys.exit(1)
        layers_to_transform = list(range(hidden_layers - a.last_layers, hidden_layers))
        if a.layers_pattern is None:
            a.layers_pattern = "layers"

    peft_kwargs = {}
    if layers_to_transform is not None:
        peft_kwargs["layers_to_transform"] = layers_to_transform
    if a.layers_pattern is not None:
        peft_kwargs["layers_pattern"] = a.layers_pattern

    target_modules = "all-linear"
    if layers_to_transform is not None:
        try:
            target_modules = linear_target_modules(model)
        except ValueError as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)
        log(f"layer-restricted LoRA targets: type={type(target_modules).__name__} names={','.join(target_modules)}")

    peft_cfg = LoraConfig(
        r=a.lora_r,
        lora_alpha=a.lora_r * 2,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=target_modules,
        **peft_kwargs,
    )

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
    resume_path = a.resume_from_checkpoint.strip() or None
    if resume_path:
        log(f"resuming from checkpoint: {resume_path}")
    t0 = time.time()
    trainer.train(resume_from_checkpoint=resume_path)
    trainer.save_model(a.out)
    tok.save_pretrained(a.out)
    dur = round(time.time() - t0, 1)

    run = {
        "schema_version": 1, "base_model": a.model, "adapter_path": a.out, "dataset_dir": a.data,
        "dataset_manifest_sha256": manifest_hash(a.data),
        "config": {"epochs": a.epochs, "max_steps": a.max_steps, "batch_size": a.batch_size, "grad_accum": a.grad_accum,
                   "lr": a.lr, "lora_r": a.lora_r, "max_seq_len": a.max_seq_len, "qlora_4bit": a.bit4,
                   "assistant_only_loss": not a.no_assistant_loss, "last_layers": a.last_layers,
                   "layers_to_transform": layers_to_transform, "layers_pattern": a.layers_pattern,
                   "resume_from_checkpoint": resume_path},
        "seconds": dur,
    }
    with open(os.path.join(a.out, "sft_run.json"), "w") as f:
        json.dump(run, f, indent=2)
    print(json.dumps({"ok": True, "out": a.out, "seconds": dur}))


if __name__ == "__main__":
    main()
