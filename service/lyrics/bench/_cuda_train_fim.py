#!/usr/bin/env python3
"""CUDA-side FIM-LoRA trainer (I4 sweeps lane). Runs on the Vast box, NOT here.

Trains a PEFT LoRA against the DEQUANTIZED MLX base (fim_bridge.dequantize_
checkpoint output) so the adapter learns against the same function MLX serves;
`fim_bridge.peft_to_mlx_adapter` brings it home. The recipe comes from
`fim_bridge.cuda_recipe(mlx_adapter_config)` — never hand-copied.

Config as JSON argv[1]:
  {"base": <dequantized dir>, "data": <dir with train/valid.jsonl>,
   "out": <peft adapter out>, "recipe": {...cuda_recipe...},
   "iters": 1500, "batch": 16, "lr": 2e-5, "seed": 20260728, "maxLength": 384}

Loss is COMPLETION-ONLY (labels -100 over the prompt), mirroring mlx_lm's
--mask-prompt. ENCODING: this trainer reproduces mlx_lm's
`CompletionsDataset.process` byte-for-byte — the row is wrapped as a
user/assistant chat turn via `apply_chat_template`, and the mask offset is
the user-only template with `add_generation_prompt=True`. That wrap is a
SECOND templating (the minted prompt already carries the serve template as
text), which is exactly what mlx_lm trains; the 2026-07-29 twin run measured
that this double-wrapped recipe transfers to serve (.393 exact) while the
raw serve-parity concatenation anti-transfers (.173, below base .253) — see
CUDA-BRIDGE.md. Matching mlx_lm here is what makes the twin bar meaningful.

Checkpoints: `out` gets the endpoint; `out + "-best"` tracks the best val
block (the first run's val minimum was mid-run and unrecoverable).
"""
import json
import random
import sys


def encode_row(tok, prompt, completion, max_len):
    """mlx_lm `CompletionsDataset.process` parity — ids, labels (-100 to the
    assistant boundary), truncated head-kept like mlx_lm's trainer. The
    opt-in smoke in fim_bridge_test.py pins byte-parity against the real
    thing; drift here silently trains a different task than the MLX twin."""
    messages = [{"role": "user", "content": prompt},
                {"role": "assistant", "content": completion}]
    ids = list(tok.apply_chat_template(messages, return_dict=False))
    offset = len(tok.apply_chat_template(
        messages[:-1], add_generation_prompt=True, return_dict=False))
    ids = ids[:max_len]
    cut = min(offset, len(ids))
    labels = [-100] * cut + ids[cut:]
    return ids, labels


def main():
    cfg = json.loads(sys.argv[1])
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    seed = int(cfg.get("seed", 20260728))
    random.seed(seed)
    torch.manual_seed(seed)

    tok = AutoTokenizer.from_pretrained(cfg["base"])
    model = AutoModelForCausalLM.from_pretrained(
        cfg["base"], torch_dtype=torch.bfloat16, device_map="cuda")
    rec = cfg["recipe"]
    n_layers_total = model.config.num_hidden_layers
    first = n_layers_total - int(rec["numLayersFromEnd"])
    lcfg = LoraConfig(
        r=int(rec["r"]), lora_alpha=float(rec["lora_alpha"]),
        lora_dropout=float(rec.get("lora_dropout", 0.0)),
        target_modules=list(rec["target_modules"]),
        layers_to_transform=list(range(first, n_layers_total)),
        task_type="CAUSAL_LM", bias="none")
    model = get_peft_model(model, lcfg)
    model.print_trainable_parameters()
    # Gradient checkpointing is NOT optional at this size: 28GB of bf16
    # weights + ~15GB of full activations for one 14B backward filled a 48GB
    # card even at micro-batch 8 (attempt 5). Recompute-in-backward drops the
    # activation term ~10x for ~30% slower steps. use_cache must be off, and
    # PEFT needs input grads enabled for checkpointing to reach the adapters.
    model.config.use_cache = False
    model.enable_input_require_grads()
    model.gradient_checkpointing_enable()
    print("gradient checkpointing ON", flush=True)

    def rows_of(path):
        return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]

    train = rows_of(f"{cfg['data']}/train.jsonl")
    valid = rows_of(f"{cfg['data']}/valid.jsonl")
    # Validation is a CHECKPOINT-SELECTION signal, not a published metric, so
    # it is capped: the v3 mint's 2,722-row valid set evaluated every 100 steps
    # would have spent ~126 min of rented GPU on val against ~122 min of actual
    # training (measured, attempt 8 first block) and pushed the run past its
    # TTL. A 512-row head is enough to rank checkpoints (the mint's stage 2
    # already shuffled with a fixed seed, so the head is an unbiased sample and
    # is identical across runs). Val losses are therefore comparable WITHIN a
    # data version, never across mints.
    val_max = int(cfg.get("valMax", 512))
    if val_max > 0:
        valid = valid[:val_max]
    max_len = int(cfg.get("maxLength", 384))

    def encode(rows):
        return [encode_row(tok, r["prompt"], r["completion"], max_len)
                for r in rows]

    train_enc, valid_enc = encode(train), encode(valid)
    rng = random.Random(seed)

    def batch(rows, idxs):
        chunk = [rows[i] for i in idxs]
        width = max(len(ids) for ids, _ in chunk)
        pad = tok.pad_token_id or tok.eos_token_id
        input_ids = torch.full((len(chunk), width), pad, dtype=torch.long)
        labels = torch.full((len(chunk), width), -100, dtype=torch.long)
        attn = torch.zeros((len(chunk), width), dtype=torch.long)
        for j, (ids, lab) in enumerate(chunk):
            input_ids[j, :len(ids)] = torch.tensor(ids)
            labels[j, :len(lab)] = torch.tensor(lab)
            attn[j, :len(ids)] = 1
        return {k: v.cuda() for k, v in
                {"input_ids": input_ids, "labels": labels,
                 "attention_mask": attn}.items()}

    def val_loss():
        vb = min(int(cfg.get("batch", 16)), int(cfg.get("microBatch", 8)))
        model.eval()
        tot = n = 0
        with torch.no_grad():
            for i in range(0, len(valid_enc), vb):
                idxs = list(range(i, min(i + vb, len(valid_enc))))
                loss = model(**batch(valid_enc, idxs)).loss
                tot += float(loss) * len(idxs)
                n += len(idxs)
        model.train()
        return tot / max(1, n)

    opt = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),
                            lr=float(cfg.get("lr", 2e-5)))
    B = int(cfg.get("batch", 16))
    # Gradient accumulation keeps the EFFECTIVE batch equal to the MLX twin's
    # while the micro-batch fits the card: 28GB of bf16 weights + batch-16
    # activations OOM'd a 48GB A6000 on the first backward (attempt 4).
    micro = min(B, int(cfg.get("microBatch", 8)))
    accum = max(1, B // micro)
    print(f"micro-batch {micro} x accum {accum} (effective {micro * accum})",
          flush=True)
    order = list(range(len(train_enc)))
    rng.shuffle(order)
    ptr, run = 0, 0.0
    curve = [{"step": 0, "val": round(val_loss(), 4)}]
    print(f"step 0 val {curve[0]['val']}", flush=True)
    best_val = curve[0]["val"]
    for step in range(1, int(cfg.get("iters", 1500)) + 1):
        opt.zero_grad()
        step_loss = 0.0
        for _ in range(accum):
            if ptr + micro > len(order):
                rng.shuffle(order)
                ptr = 0
            loss = model(**batch(train_enc, order[ptr:ptr + micro])).loss / accum
            ptr += micro
            loss.backward()
            step_loss += float(loss)
        opt.step()
        run += step_loss
        if step % 100 == 0 or step == int(cfg.get("iters", 1500)):
            v = val_loss()
            curve.append({"step": step, "train": round(run / 100, 4),
                          "val": round(v, 4)})
            print(f"step {step} train {run / 100:.4f} val {v:.4f}", flush=True)
            run = 0.0
            if v < best_val:
                best_val = v
                model.save_pretrained(cfg["out"] + "-best")
                print(f"best checkpoint at step {step} (val {v:.4f})",
                      flush=True)

    model.save_pretrained(cfg["out"])
    print(json.dumps({"ok": True, "out": cfg["out"], "curve": curve,
                      "bestVal": best_val, "seed": seed, "recipe": rec}))


if __name__ == "__main__":
    main()
