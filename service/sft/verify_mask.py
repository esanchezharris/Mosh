#!/usr/bin/env python3
"""GPU-free verification of the CUDA assistant-only-loss masking fix.

Proves three things about inject_generation_tags() (used by sft_cuda_train.py) without
a GPU or torch — only the tokenizer is needed:

  1. No train/serve skew: the injected template renders byte-identical text to the
     stock template (the {% generation %} tags are invisible at render time).
  2. The assistant-token mask covers exactly the assistant turn — loss lands on the
     completion only, not the ~3k-token system prompt (the whole point of the fix:
     unmasked full-sequence loss let the system prompt dominate and the model
     learned to DEFER on note population).
  3. The assistant's EOS (<|im_end|>) is INSIDE the loss span — without it the model
     gets no gradient on "stop here" and would run past its reply. This is the
     "learn to STOP" property the whole fix rests on.

It checks BOTH repos whose templates this fix has to work on, because their stock
chat templates differ (the mlx 4bit repo ships a longer template than the base repo):
  - Qwen/Qwen3-4B-Instruct-2507              — the CUDA trainer's default --model (the
                                               template inject_generation_tags actually
                                               guards in production).
  - mlx-community/Qwen3-4B-Instruct-2507-4bit — the repo the shipped local-MLX result
                                               was trained against.
A model that can't be loaded offline (uncached) is SKIPPED, not failed, so this stays
runnable on a constrained box; set SFT_BASE_MODEL to verify a single specific repo.

Run under the mlx venv (tokenizers-only is fine):
    source service/sft/.sft.env && "$SFT_PY" service/sft/verify_mask.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sft_cuda_train import inject_generation_tags  # noqa: E402
from transformers import AutoTokenizer  # noqa: E402

# The CUDA lane's default model first (its template is the one the fix protects), then
# the MLX 4bit repo the shipped result used. SFT_BASE_MODEL overrides to a single repo.
DEFAULT_MODELS = [
    "Qwen/Qwen3-4B-Instruct-2507",
    "mlx-community/Qwen3-4B-Instruct-2507-4bit",
]
MODELS = [os.environ["SFT_BASE_MODEL"]] if os.environ.get("SFT_BASE_MODEL") else DEFAULT_MODELS

MESSAGES = [
    {"role": "system", "content": 'You are Moshi. Tracks: "17" "Drums".'},
    {"role": "user", "content": 'write a short pattern into the clip on the "Drums" track'},
    {"role": "assistant", "content": '{"intent":"ACK_GOT_IT","commands":[{"command":"add_note","args":{"clipId":"101","pitch":36,"start":0,"length":1,"velocity":100}}]}'},
]


def verify(model: str, tok) -> None:
    """Run every masking assertion against one model's chat template. Raises on failure."""
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

    # 3) the EOS that ends the assistant turn is inside the loss span (substring, NOT
    # last-token: the final masked token is the trailing "\n" after <|im_end|>, not the
    # EOS itself). Without this, full-sequence loss's only "stop" signal is gone.
    assert tok.eos_token in masked, f"EOS ({tok.eos_token}) not in the loss span — model won't learn to stop"

    pct = 100.0 * sum(mask) / len(mask)
    print(f"OK  {model}  ·  no skew · mask = {sum(mask)}/{len(mask)} tokens ({pct:.1f}%), EOS in span — loss on the completion only")


def main() -> int:
    verified = 0
    for model in MODELS:
        try:
            tok = AutoTokenizer.from_pretrained(model)
        except Exception as e:  # offline + uncached → skip this repo, don't fail the run
            print(f"SKIP {model}  ·  could not load ({type(e).__name__}) — offline & uncached?", file=sys.stderr)
            continue
        verify(model, tok)  # assertion failures here are real — let them propagate
        verified += 1
    if verified == 0:
        print("FAIL  no model could be loaded — run online once, or set SFT_BASE_MODEL to a cached repo", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
