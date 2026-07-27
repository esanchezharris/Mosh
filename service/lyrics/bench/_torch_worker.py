#!/usr/bin/env python3
"""Torch-side worker for the embedding / pseudo-perplexity judges (I2).

Runs ONLY under an interpreter that has torch+transformers (resolved by
torchjudge.resolve_python). Reads one JSON payload on stdin, writes one JSON
object on stdout — that narrow seam is why the bench's own tests stay stdlib.

  kind="emb": mean-pooled sentence embeddings, cosine(truth_line, candidate_line).
              Higher = semantically closer to what the human actually wrote.
  kind="ppl": masked-LM pseudo-log-likelihood. Each token is masked in turn and
              scored; we report NLL(candidate) - NLL(truth) per token, so 0 means
              "reads as fluently as the real bar" and positive means worse.
              This is PLL under a masked LM, not causal perplexity — a bidirectional
              fluency proxy, and labelled as such wherever it is reported.

Deterministic: inference_mode, no sampling, eval mode, fixed model ids.
"""
import json
import sys


def _fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(0)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        _fail(f"unparseable payload: {e}")

    kind = payload.get("kind")
    model_id = payload.get("model")
    pairs = payload.get("pairs") or []
    if kind not in ("emb", "ppl"):
        _fail(f"unknown kind {kind!r}")

    try:
        import torch
        from transformers import AutoModel, AutoModelForMaskedLM, AutoTokenizer
    except Exception as e:  # noqa: BLE001
        _fail(f"torch/transformers unavailable: {e}")

    torch.set_grad_enabled(False)
    try:
        tok = AutoTokenizer.from_pretrained(model_id)
        model = (AutoModel if kind == "emb" else AutoModelForMaskedLM
                 ).from_pretrained(model_id)
        model.eval()
    except Exception as e:  # noqa: BLE001
        _fail(f"model load failed ({model_id}): {e}")

    scores = []
    try:
        if kind == "emb":
            texts = [p["truth"] for p in pairs] + [p["candidate"] for p in pairs]
            enc = tok(texts, padding=True, truncation=True, max_length=64,
                      return_tensors="pt")
            with torch.inference_mode():
                out = model(**enc).last_hidden_state
            mask = enc["attention_mask"].unsqueeze(-1).float()
            emb = (out * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
            emb = torch.nn.functional.normalize(emb, dim=-1)
            n = len(pairs)
            scores = [float((emb[i] * emb[n + i]).sum()) for i in range(n)]
        else:
            def nll_per_token(text):
                ids = tok(text, truncation=True, max_length=64,
                          return_tensors="pt")["input_ids"]
                n = ids.shape[1]
                # Mask each non-special position in turn (one batched forward).
                specials = set(tok.all_special_ids)
                positions = [i for i in range(n)
                             if int(ids[0, i]) not in specials]
                if not positions:
                    return None
                batch = ids.repeat(len(positions), 1)
                for row, pos in enumerate(positions):
                    batch[row, pos] = tok.mask_token_id
                with torch.inference_mode():
                    logits = model(input_ids=batch).logits
                total = 0.0
                for row, pos in enumerate(positions):
                    lp = torch.log_softmax(logits[row, pos], dim=-1)
                    total += float(lp[int(ids[0, pos])])
                return -total / len(positions)

            for p in pairs:
                a, b = nll_per_token(p["candidate"]), nll_per_token(p["truth"])
                scores.append(None if a is None or b is None else a - b)
    except Exception as e:  # noqa: BLE001
        _fail(f"scoring failed: {e}")

    print(json.dumps({"ok": True, "scores": scores,
                      "backend": {"python": sys.executable, "model": model_id,
                                  "kind": kind}}))


if __name__ == "__main__":
    main()
