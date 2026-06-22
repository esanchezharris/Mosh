#!/usr/bin/env python3
"""Batch-generate model replies for a dumped prompt set — the robust eval path.

Reads prompts.jsonl ({id, messages}), loads the base model + LoRA adapter, greedily
generates one reply per prompt, and writes replies.jsonl ({id, content}) incrementally
(flushed each line, so an SSH drop loses nothing). The Mac then scores replies offline
with `npm run eval-sft -- --replies`. No server, no tunnel.

  python gen_replies.py prompts.jsonl replies.jsonl [--base ID] [--adapter DIR]
"""
import argparse
import json
import sys

ap = argparse.ArgumentParser()
ap.add_argument("prompts")
ap.add_argument("out")
ap.add_argument("--base", default="Qwen/Qwen3-4B-Instruct-2507")
ap.add_argument("--adapter", default="./adapter")
ap.add_argument("--max-new-tokens", type=int, default=512)
a = ap.parse_args()

import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

prompts = [json.loads(l) for l in open(a.prompts) if l.strip()]
print(f"loading model for {len(prompts)} prompts…", file=sys.stderr, flush=True)
tok = AutoTokenizer.from_pretrained(a.base)
model = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.bfloat16, device_map="auto")
if a.adapter:
    from peft import PeftModel
    model = PeftModel.from_pretrained(model, a.adapter)
model.eval()
print("model ready, generating…", file=sys.stderr, flush=True)

with open(a.out, "w") as f:
    for i, p in enumerate(prompts):
        text = tok.apply_chat_template(p["messages"], add_generation_prompt=True, tokenize=False)
        inp = tok(text, return_tensors="pt").to(model.device)
        with torch.no_grad():
            out = model.generate(**inp, max_new_tokens=a.max_new_tokens, do_sample=False, pad_token_id=(tok.eos_token_id or tok.pad_token_id))
        content = tok.decode(out[0][inp["input_ids"].shape[1]:], skip_special_tokens=True)
        f.write(json.dumps({"id": p["id"], "content": content}) + "\n")
        f.flush()
        if (i + 1) % 10 == 0:
            print(f"  {i + 1}/{len(prompts)}", file=sys.stderr, flush=True)
print("GEN_DONE", file=sys.stderr, flush=True)
