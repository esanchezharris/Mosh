#!/usr/bin/env python3
"""Minimal OpenAI-compatible server (stdlib http + transformers) for serving a
fine-tuned LoRA adapter for the cloud SFT eval.

vllm pins torch hard (it dragged a Vast.ai box to torch 2.11/cu130 and broke the
CUDA runtime), so for just running the eval (~150 sequential calls) this serves the
base model + PeftModel adapter via plain transformers over stdlib http.server.
Exposes POST /v1/chat/completions and GET /v1/models so `npm run eval-sft` can hit
it unchanged (point OPENAI_BASE_URL at it; the `model` field is ignored).

  python serve_openai.py --base Qwen/Qwen3-4B-Instruct-2507 --adapter ./adapter --port 8000
"""
import argparse
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="Qwen/Qwen3-4B-Instruct-2507")
ap.add_argument("--adapter", default="")
ap.add_argument("--port", type=int, default=8000)
ap.add_argument("--model-id", default="sft")
A = ap.parse_args()

print("loading model…", file=sys.stderr, flush=True)
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

tok = AutoTokenizer.from_pretrained(A.base)
model = AutoModelForCausalLM.from_pretrained(A.base, dtype=torch.bfloat16, device_map="auto")
if A.adapter:
    from peft import PeftModel
    model = PeftModel.from_pretrained(model, A.adapter)
model.eval()
LOCK = threading.Lock()
print(f"ready: base={A.base} adapter={A.adapter or '(none)'} on {model.device}", file=sys.stderr, flush=True)


def generate(messages, max_new_tokens):
    prompt = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
    inputs = tok(prompt, return_tensors="pt").to(model.device)
    with LOCK, torch.no_grad():
        out = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False, pad_token_id=tok.eos_token_id or tok.pad_token_id)
    return tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._send(200, {"object": "list", "data": [{"id": A.model_id, "object": "model"}]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            messages = req.get("messages", [])
            max_new = int(req.get("max_tokens") or req.get("max_completion_tokens") or 512)
            content = generate(messages, max_new)
            self._send(200, {
                "id": "chatcmpl-local", "object": "chat.completion", "model": A.model_id,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            })
        except Exception as e:  # pragma: no cover
            self._send(500, {"error": str(e)})


HTTPServer(("0.0.0.0", A.port), H).serve_forever()
