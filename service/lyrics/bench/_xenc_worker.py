#!/usr/bin/env python3
"""Torch side of the cross-encoder scorer (FMS M6). Not a test, not public.

stdin: {"kind": "xenc", "model": ..., "pairs": [{"query":..., "passage":...}]}
stdout: {"ok": true, "scores": [...], "backend": {...}}

The payload is TRUTH-FREE by the façade's contract — this worker never sees the
artist's word except when a candidate happens to be it, which is the point.
"""
import json
import sys


def _fail(msg: str) -> None:
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(0)


def main():
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as e:  # noqa: BLE001
        _fail(f"bad payload: {e}")
    if payload.get("kind") != "xenc":
        _fail(f"unknown kind {payload.get('kind')!r}")
    model_id = payload.get("model") or ""
    pairs = payload.get("pairs") or []
    try:
        import torch
        from transformers import (AutoModelForSequenceClassification,
                                  AutoTokenizer)
    except Exception as e:  # noqa: BLE001
        _fail(f"torch/transformers unavailable: {e}")
    try:
        device = ("mps" if torch.backends.mps.is_available() else "cpu")
        tok = AutoTokenizer.from_pretrained(model_id)
        model = AutoModelForSequenceClassification.from_pretrained(
            model_id, torch_dtype=torch.float16 if device == "mps" else None)
        model.to(device).eval()
        scores = []
        B = 16
        with torch.no_grad():
            for i in range(0, len(pairs), B):
                chunk = pairs[i:i + B]
                enc = tok([(p["query"], p["passage"]) for p in chunk],
                          padding=True, truncation=True, max_length=512,
                          return_tensors="pt").to(device)
                logits = model(**enc).logits.view(-1).float().cpu()
                scores.extend(float(x) for x in logits)
        print(json.dumps({"ok": True, "scores": scores,
                          "backend": {"python": sys.executable,
                                      "model": model_id,
                                      "device": device,
                                      "torch": torch.__version__,
                                      "kind": "xenc"}}))
    except Exception as e:  # noqa: BLE001
        _fail(f"scoring failed: {e}")


if __name__ == "__main__":
    main()
