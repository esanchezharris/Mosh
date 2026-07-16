"""Golden for service/loras/install.py — validate + enroll a .safetensors LoRA
into the library (copy + card), and reject bad inputs. Hermetic (synthetic
tensors, temp dirs), deterministic.

Run:  python3 service/loras/install_test.py
"""
from __future__ import annotations

import json
import os
import struct
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))     # service/
from loras import install as INS   # noqa: E402
from loras import registry as REG  # noqa: E402

CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)


def write_st(path, tensors, metadata):
    header, blobs, off = {}, [], 0
    if metadata:
        header["__metadata__"] = {k: str(v) for k, v in metadata.items()}
    for k, arr in tensors.items():
        raw = np.ascontiguousarray(arr, dtype=np.float32).tobytes()
        header[k] = {"dtype": "F32", "shape": list(arr.shape),
                     "data_offsets": [off, off + len(raw)]}
        blobs.append(raw)
        off += len(raw)
    hj = json.dumps(header).encode()
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(hj)))
        f.write(hj)
        for b in blobs:
            f.write(b)


def make_lora(path, adapter_type="dora-rows", modules=2):
    rng = np.random.default_rng(3)
    t = {}
    for i in range(modules):
        base = f"model.transformer.layers.{i}.self_attn.to_qkv.parametrizations.weight.0"
        t[base + ".lora_A"] = rng.normal(size=(2, 3)).astype(np.float32)
        t[base + ".lora_B"] = rng.normal(size=(4, 2)).astype(np.float32)
        if adapter_type in ("dora-rows", "dora"):
            t[base + ".magnitude"] = np.abs(rng.normal(size=(4,))).astype(np.float32)
    write_st(path, t, {"lora_config": json.dumps(
        {"rank": 2, "alpha": 2, "adapter_type": adapter_type})})


def main():
    tmp = tempfile.mkdtemp(prefix="lora-install-test-")
    os.environ["MOSH_LORA_DIR"] = tmp     # library lands under tmp/sa3

    # 1) happy path: validate + enroll + card + registry-visible
    src = os.path.join(tmp, "src.safetensors")
    make_lora(src)
    res = INS.install(src, name="unit-ken", trigger="uken", hint="rage trap",
                      notes="test", display="Unit Ken")
    dest = os.path.join(tmp, "sa3", "unit-ken.safetensors")
    check(os.path.isfile(dest), "installed file missing")
    check(res["adapter_type"] == "dora-rows", f"adapter_type wrong: {res}")
    check(res["modules"] == 2, f"module count wrong: {res}")
    card = json.loads(open(os.path.join(tmp, "sa3", "unit-ken.json")).read())
    check(card["trigger"] == "uken" and card["displayName"] == "Unit Ken"
          and card["hint"] == "rage trap", f"card wrong: {card}")
    check("unit-ken" in [e["name"] for e in REG.list_loras()], "not visible in registry")

    # 2) unsupported adapter_type rejected
    bad = os.path.join(tmp, "bad.safetensors")
    make_lora(bad, adapter_type="wild")
    try:
        INS.install(bad, name="bad1")
        check(False, "unsupported adapter_type not rejected")
    except ValueError:
        check(True, "unsupported rejected")

    # 3) a .safetensors with no LoRA tensors rejected
    empty = os.path.join(tmp, "empty.safetensors")
    write_st(empty, {"model.foo.weight": np.zeros((2, 2), np.float32)},
             {"lora_config": json.dumps({"adapter_type": "dora-rows"})})
    try:
        INS.install(empty, name="empty1")
        check(False, "empty lora not rejected")
    except ValueError:
        check(True, "empty rejected")

    # 4) unknown extension rejected
    txt = os.path.join(tmp, "x.txt")
    open(txt, "w").write("nope")
    try:
        INS.install(txt, name="x1")
        check(False, "unknown ext not rejected")
    except ValueError:
        check(True, "unknown ext rejected")

    # 5) unsafe name rejected (no path traversal / separators)
    for nm in ("../evil", "a/b", ""):
        try:
            INS.install(src, name=nm)
            check(False, f"unsafe name {nm!r} not rejected")
        except ValueError:
            check(True, f"unsafe name {nm!r} rejected")

    # 6) re-install overwrites cleanly (card updates, no leftover temp files)
    INS.install(src, name="unit-ken", trigger="uken2")
    card2 = json.loads(open(os.path.join(tmp, "sa3", "unit-ken.json")).read())
    check(card2["trigger"] == "uken2", "re-install didn't update card")
    leftovers = [f for f in os.listdir(os.path.join(tmp, "sa3")) if f.startswith("tmp")]
    check(not leftovers, f"left staging temp files: {leftovers}")

    print(f"install_test OK ({CHECKS} checks)")


if __name__ == "__main__":
    main()
