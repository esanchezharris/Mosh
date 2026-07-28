#!/usr/bin/env python3
"""Fine-tune the M6 cross-encoder on minted truth-vs-poolmate pairs.

Runs under a torch venv (tunejury). Config as a JSON argv[1]:
  {"data": .../pairs.jsonl, "out": .../model-dir, "model": base id,
   "maxSteps": N, "batch": 8, "lr": 2e-5, "valFrac": 0.05, "seed": 20260728,
   "maxLength": 256}

BCE on the reranker's single logit: the positive passage labels 1, each
negative 0. Held-out triples (valFrac, split BY ITEM so a query never
straddles train/val) give the loss that decides whether learning happened —
train loss falling alone is memorization's best costume.

Progress lines on stdout (`step N train ... val ...`); final line is JSON with
the val curve + output dir. Deterministic per seed.
"""
import json
import math
import os
import random
import sys


def main():
    cfg = json.loads(sys.argv[1])
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    seed = int(cfg.get("seed", 20260728))
    random.seed(seed)
    torch.manual_seed(seed)

    triples = [json.loads(l) for l in open(cfg["data"], encoding="utf-8")
               if l.strip()]
    rng = random.Random(seed)
    rng.shuffle(triples)
    n_val = max(8, int(len(triples) * float(cfg.get("valFrac", 0.05))))
    val, train = triples[:n_val], triples[n_val:]

    def pairs_of(ts):
        out = []
        for t in ts:
            out.append((t["query"], t["positive"], 1.0))
            for n in t["negatives"]:
                out.append((t["query"], n, 0.0))
        return out

    train_pairs, val_pairs = pairs_of(train), pairs_of(val)
    rng.shuffle(train_pairs)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(cfg["model"])
    model = AutoModelForSequenceClassification.from_pretrained(cfg["model"])
    model.to(device).train()
    opt = torch.optim.AdamW(model.parameters(), lr=float(cfg.get("lr", 2e-5)))
    B = int(cfg.get("batch", 8))
    max_len = int(cfg.get("maxLength", 256))
    max_steps = int(cfg.get("maxSteps", 1000))
    loss_fn = torch.nn.BCEWithLogitsLoss()

    def batch_loss(chunk, train_mode):
        enc = tok([(q, p) for q, p, _ in chunk], padding=True, truncation=True,
                  max_length=max_len, return_tensors="pt").to(device)
        labels = torch.tensor([y for _, _, y in chunk], device=device)
        logits = model(**enc).logits.view(-1)
        return loss_fn(logits, labels)

    def val_loss():
        model.eval()
        tot = n = 0
        with torch.no_grad():
            for i in range(0, len(val_pairs), B):
                chunk = val_pairs[i:i + B]
                tot += float(batch_loss(chunk, False)) * len(chunk)
                n += len(chunk)
        model.train()
        return tot / max(1, n)

    curve = []
    step = 0
    v0 = val_loss()
    curve.append({"step": 0, "val": round(v0, 4)})
    print(f"step 0 val {v0:.4f} (untrained baseline)", flush=True)
    ptr = 0
    run_train = 0.0
    while step < max_steps:
        if ptr + B > len(train_pairs):
            rng.shuffle(train_pairs)
            ptr = 0
        chunk = train_pairs[ptr:ptr + B]
        ptr += B
        loss = batch_loss(chunk, True)
        opt.zero_grad()
        loss.backward()
        opt.step()
        run_train += float(loss)
        step += 1
        if step % 100 == 0 or step == max_steps:
            v = val_loss()
            curve.append({"step": step, "train": round(run_train / 100, 4),
                          "val": round(v, 4)})
            print(f"step {step} train {run_train / 100:.4f} val {v:.4f}",
                  flush=True)
            run_train = 0.0

    os.makedirs(cfg["out"], exist_ok=True)
    model.eval()
    model.save_pretrained(cfg["out"])
    tok.save_pretrained(cfg["out"])
    print(json.dumps({"ok": True, "out": cfg["out"], "device": device,
                      "trainPairs": len(train_pairs), "valPairs": len(val_pairs),
                      "curve": curve, "seed": seed,
                      "base": cfg["model"]}))


if __name__ == "__main__":
    main()
