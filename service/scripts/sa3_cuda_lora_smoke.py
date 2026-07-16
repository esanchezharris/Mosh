"""Real-GPU LoRA smoke for the CUDA adapter — FIT-013 PC verification.

Deliberately NOT named *_test.py: needs the real SA3 model + a CUDA device, so the
gate must never collect it. Driven by scripts/verify-pc-build.ps1 -RealLoRA on the
owner's Windows box (or by hand in the SA3 venv).

What it proves, end to end:
  1. stock vs lora@0.4 vs lora@0.8 renders (fixed seed/prompt) differ pairwise
     (SHA256) — the runtime apply audibly reaches the DiT;
  2. every touched param equals the numpy disk-merge math recomputed from its
     pristine stash (apply_dora(np) oracle — independent of the torch path);
  3. after restoring stock, a re-render is byte-identical to the first stock
     render — restore is bit-clean at the audio level.

Usage:  python sa3_cuda_lora_smoke.py [lora_name]   (default: first rack LoRA)
"""
from __future__ import annotations

import hashlib
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, ".."))     # service/

import numpy as np  # noqa: E402

from adapters import stable_audio3_cuda as cuda  # noqa: E402
from loras import registry as LR  # noqa: E402
from sa3 import lora_merge as LM  # noqa: E402


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fail(msg):
    print(f"[X] {msg}")
    sys.exit(1)


def main():
    if not cuda.available():
        fail("stable_audio3_cuda.available() is False — run service/setup-sa3-cuda.ps1 first")

    names = [e["name"] for e in LR.list_loras()]
    if not names:
        fail("no LoRAs enrolled — install one into MOSH_LORA_DIR (see service/loras/install.py)")
    name = sys.argv[1] if len(sys.argv) > 1 else names[0]
    if name not in names:
        fail(f"LoRA {name!r} not in rack {names}")
    print(f"[.] using LoRA {name!r}")

    tmp = tempfile.mkdtemp(prefix="sa3-lora-smoke-")
    params = {"prompt": "warm analog synth chord, steady pulse", "seed": 7,
              "durationSec": 4.0}
    outs = {}
    for tag, loras in (("stock", []),
                       ("s04", [{"name": name, "value": 40}]),
                       ("s08", [{"name": name, "value": 80}])):
        out = os.path.join(tmp, f"{tag}.wav")
        m = cuda.render("", out, dict(params, loras=loras))
        outs[tag] = sha(out)
        print(f"[.] {tag}: sha={outs[tag][:16]} apply_ms={m.get('apply_ms')} "
              f"loras={m.get('loras')}")

    if len({outs['stock'], outs['s04'], outs['s08']}) != 3:
        fail(f"renders did not differ pairwise: {outs}")
    print("[.] pairwise-different renders OK")

    # tensor oracle: recompute each touched weight from its pristine stash with the
    # numpy apply_dora path and compare to what the torch apply left on the model.
    sel = LR.resolve([{"name": name, "value": 80}], lab=False)
    cuda._apply_loras_cuda(cuda._MODEL[0], sel, "smoke-oracle")
    if not cuda._LORA_TOUCHED:
        fail("apply touched no params")
    _lname, lpath, lstrength = sel[0]
    tensors, meta = LM.read_safetensors(lpath)
    import json
    cfg = json.loads(meta.get("lora_config", "{}")) if meta else {}
    rank = float(cfg.get("rank", 16))
    scaling = float(cfg.get("alpha", cfg.get("lora_alpha", rank))) / rank
    adapter_type = cfg.get("adapter_type", "dora-rows")
    groups = LM.group_lora(tensors)
    max_diff = 0.0
    checked = 0
    for module in sorted(cuda._LORA_TOUCHED):
        param, stash = cuda._LORA_BASE[module]
        parts = groups.get(module)
        if parts is None:
            continue
        Wb = stash.to("cpu").to_dense().float().numpy()
        W2 = Wb[:, :, 0] if Wb.ndim == 3 else Wb
        mag = parts.get("magnitude") if adapter_type in ("dora-rows", "dora") else None
        exp = LM.apply_dora(np, W2, parts["lora_A"], parts["lora_B"], mag,
                            adapter_type, scaling, lstrength)
        got = param.data.detach().to("cpu").float().numpy()
        got2 = got[:, :, 0] if got.ndim == 3 else got
        d = float(np.max(np.abs(got2 - exp.astype(np.float32))))
        max_diff = max(max_diff, d)
        checked += 1
        if d > 5e-3:            # f16 storage rounding dominates; torch==numpy under it
            fail(f"{module}: torch apply drifted from numpy oracle (max abs {d})")
    print(f"[.] tensor oracle OK ({checked} params, max abs diff {max_diff:.2e})")

    # restore -> byte-identical stock re-render
    out2 = os.path.join(tmp, "stock2.wav")
    cuda.render("", out2, dict(params, loras=[]))
    if sha(out2) != outs["stock"]:
        fail("post-restore render != original stock render (restore not bit-clean)")
    print("[.] restore bit-clean OK")
    print(f"[OK] sa3_cuda_lora_smoke passed (artifacts in {tmp})")


if __name__ == "__main__":
    main()
