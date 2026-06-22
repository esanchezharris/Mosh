#!/usr/bin/env python3
"""GPU-free verification of the CUDA assistant-only-loss masking fix.

Proves two things about inject_generation_tags() (used by sft_cuda_train.py) without
a GPU or torch — only the tokenizer is needed:

  1. No train/serve skew: the injected template renders byte-identical text to the
     stock template (the {% generation %} tags are invisible at render time).
  2. The assistant-token mask covers exactly the assistant turn — loss lands on the
     completion only, not the ~3k-token system prompt (the whole point of the fix:
     unmasked full-sequence loss let the system prompt dominate and the model
     learned to DEFER on note population).

Run under the mlx venv (tokenizers-only is fine):
    source service/sft/.sft.env && "$SFT_PY" service/sft/verify_mask.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sft_cuda_train import inject_generation_tags  # noqa: E402
from transformers import AutoTokenizer  # noqa: E402

MODEL = os.environ.get("SFT_BASE_MODEL", "mlx-community/Qwen3-4B-Instruct-2507-4bit")
MESSAGES = [
    {"role": "system", "content": 'You are Moshi. Tracks: "17" "Drums".'},
    {"role": "user", "content": 'write a short pattern into the clip on the "Drums" track'},
    {"role": "assistant", "content": '{"intent":"ACK_GOT_IT","commands":[{"command":"add_note","args":{"clipId":"101","pitch":36,"start":0,"length":1,"velocity":100}}]}'},
]


def main() -> int:
    tok = AutoTokenizer.from_pretrained(MODEL)
    stock = tok.chat_template
    injected = inject_generation_tags(stock)
    assert "{%- generation %}" in injected and "{%- endgeneration %}" in injected, "tags not injected"
    assert inject_generation_tags(injected) == injected, "injection is not idempotent"

    # 1) no skew — the injected template renders identical text to the stock one
    a = tok.apply_chat_template(MESSAGES, chat_template=stock, tokenize=False)
    b = tok.apply_chat_template(MESSAGES, chat_template=injected, tokenize=False)
    assert a == b, "SKEW: injected template renders different text than stock"

    # 2) the assistant mask covers exactly the assistant turn
    enc = tok.apply_chat_template(MESSAGES, chat_template=injected, return_assistant_tokens_mask=True, return_dict=True, tokenize=True)
    ids, mask = enc["input_ids"], enc["assistant_masks"]
    assert len(mask) == len(ids) and 0 < sum(mask) < len(mask), "mask must cover SOME but not ALL tokens"
    masked = tok.decode([i for i, m in zip(ids, mask) if m])
    unmasked = tok.decode([i for i, m in zip(ids, mask) if not m])
    assert "add_note" in masked and "ACK_GOT_IT" in masked, "assistant content not in the loss span"
    assert "write a short pattern" in unmasked, "user prompt leaked into the loss span"
    assert "You are Moshi" in unmasked, "system prompt leaked into the loss span"

    pct = 100.0 * sum(mask) / len(mask)
    print(f"OK  no skew · assistant mask = {sum(mask)}/{len(mask)} tokens ({pct:.1f}%) — loss on the completion only")
    return 0


if __name__ == "__main__":
    sys.exit(main())
