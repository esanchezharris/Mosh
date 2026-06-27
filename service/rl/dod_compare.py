#!/usr/bin/env python3
"""Rung-1 DoD: SFT baseline vs GRPO-best on the frozen gate, same verifier & tokenizer.

Greedy-generates each adapter's reply for a deterministic gate subsample and scores
with the identical offline `evalSft --replies` path the SFT 0.62 number used — so the
before/after is apples-to-apples. Run OFFLINE (HF_HUB_OFFLINE=1) to pin the tokenizer.

  python service/rl/dod_compare.py --rl-data service/sft/.rl-data/rl-v1 \
    --sft-adapter service/sft/.adapters/v2 --rl-adapter service/sft/.adapters/rl-v1 \
    --n 300 --out service/sft/.adapters/rl-v1/dod.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from grpo import build_model, gate_eval, load_prompts  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="GRPO Rung-1 DoD compare")
    ap.add_argument("--rl-data", required=True)
    ap.add_argument("--sft-adapter", required=True)
    ap.add_argument("--rl-adapter", required=True)
    ap.add_argument("--model", default="mlx-community/Qwen3-4B-Instruct-2507-4bit")
    ap.add_argument("--n", type=int, default=300, help="gate subsample (0=all)")
    ap.add_argument("--max-new-tokens", type=int, default=200)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    rl_dir = Path(a.rl_data).resolve()
    work = Path(a.out).resolve().parent / "_dod_work"
    work.mkdir(parents=True, exist_ok=True)

    # build_model attaches a tokenizer; reuse it to tokenize the gate prompts
    sft_model, tok = build_model(a.model, str(Path(a.sft_adapter).resolve()), trainable=False)
    eos_ids = set(tok.eos_token_ids) if getattr(tok, "eos_token_ids", None) else {tok.eos_token_id}
    gate = load_prompts(rl_dir / "gate.prompts.jsonl", tok)
    gate.sort(key=lambda p: p["id"])
    if a.n and a.n < len(gate):
        gate = gate[: a.n]
    gate_by_id = {json.loads(l)["id"]: l for l in (rl_dir / "gate.eval.jsonl").read_text().splitlines() if l.strip()}

    print(f"▶ DoD on {len(gate)} gate tasks", file=sys.stderr)
    sft_score, sft_def = gate_eval(sft_model, tok, gate, gate_by_id, work, "dod_sft", a.max_new_tokens, eos_ids)
    del sft_model

    rl_model, _ = build_model(a.model, str(Path(a.rl_adapter).resolve()), trainable=False)
    rl_score, rl_def = gate_eval(rl_model, tok, gate, gate_by_id, work, "dod_rl", a.max_new_tokens, eos_ids)

    out = {
        "n": len(gate),
        "sft": {"cleanApply": sft_score, "deferrals": sft_def},
        "rl": {"cleanApply": rl_score, "deferrals": rl_def},
        "delta": round(rl_score - sft_score, 4),
        "improved": rl_score > sft_score,
    }
    Path(a.out).write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(out))


if __name__ == "__main__":
    main()
