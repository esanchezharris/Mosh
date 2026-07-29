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
--mask-prompt. Data rows are {"prompt", "completion"} — the prompt already
carries the full chat template from the mint's stage 2, so NO re-templating
happens here (re-templating with a different tokenizer revision is the quiet
way to train against prompts serve never sends).
"""
import json
import random
import sys


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

    def rows_of(path):
        return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]

    train = rows_of(f"{cfg['data']}/train.jsonl")
    valid = rows_of(f"{cfg['data']}/valid.jsonl")
    max_len = int(cfg.get("maxLength", 384))

    def encode(rows):
        out = []
        for r in rows:
            p = tok(r["prompt"], add_special_tokens=False)["input_ids"]
            c = tok(r["completion"], add_special_tokens=False)["input_ids"]
            ids = (p + c)[:max_len]
            labels = ([-100] * len(p) + c)[:max_len]
            out.append((ids, labels))
        return out

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

    model.save_pretrained(cfg["out"])
    print(json.dumps({"ok": True, "out": cfg["out"], "curve": curve,
                      "seed": seed, "recipe": rec}))


if __name__ == "__main__":
    main()
