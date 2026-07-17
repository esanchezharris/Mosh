#!/usr/bin/env python3
"""Golden: the LoRA adapter registry (service/loras/registry.py).

The registry scans the watched folder's sa3/ family subdir
(MOSH_LORA_DIR/sa3, default ~/Library/Mosh/loras/sa3) for `*.safetensors`
adapters, reads ONLY the
safetensors header (stdlib — no torch/numpy), merges optional `<stem>.json`
sidecars ({displayName, trigger, hint, notes}), caches sha256 by
(path, size, mtime_ns), and degrades gracefully: absent dir / empty dir /
corrupt file / unsupported adapter_type are all non-fatal.

Hermetic: builds tiny synthetic safetensors files in a temp dir. Runs the
scan 3× and asserts byte-identical descriptor JSON (deterministic ordering).
"""
import json
import os
import shutil
import struct
import sys
import tempfile

SERVICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SERVICE)

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def write_safetensors(path, tensors, metadata=None):
    """Minimal stdlib safetensors writer: {name: (dtype, shape, raw_bytes)}."""
    header = {}
    if metadata:
        header["__metadata__"] = metadata
    offset = 0
    blobs = []
    for name, (dtype, shape, raw) in tensors.items():
        header[name] = {"dtype": dtype, "shape": list(shape),
                        "data_offsets": [offset, offset + len(raw)]}
        blobs.append(raw)
        offset += len(raw)
    hj = json.dumps(header).encode("utf-8")
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(hj)))
        f.write(hj)
        for b in blobs:
            f.write(b)


def fp16_zeros(n):
    return b"\x00\x00" * n


def make_adapter(path, rank=16, alpha=16, adapter_type="dora-rows",
                 out_f=4, in_f=3, with_config=True):
    tensors = {
        "model.lin.parametrizations.weight.0.lora_A":
            ("F16", (rank, in_f), fp16_zeros(rank * in_f)),
        "model.lin.parametrizations.weight.0.lora_B":
            ("F16", (out_f, rank), fp16_zeros(out_f * rank)),
        "model.lin.parametrizations.weight.0.magnitude":
            ("F16", (out_f,), fp16_zeros(out_f)),
    }
    meta = None
    if with_config:
        meta = {"lora_config": json.dumps(
            {"rank": rank, "alpha": alpha, "adapter_type": adapter_type,
             "exclude": ["seconds_total"]})}
    write_safetensors(path, tensors, meta)


tmp = tempfile.mkdtemp(prefix="lora-reg-test-")
try:
    os.environ["MOSH_LORA_DIR"] = os.path.join(tmp, "loras")
    os.environ.pop("MOSH_ENABLE_LORAS", None)
    from loras import registry  # noqa: E402

    # --- absent dir: graceful empty -------------------------------------------------
    check("absent dir → descriptor []", registry.descriptor() == [])
    check("absent dir → available False", registry.available() is False)
    check("absent dir → resolve([]) []", registry.resolve([]) == [])

    # --- populated dir (the sa3/ family subdir) ---------------------------------------
    d = os.path.join(tmp, "loras", "sa3")
    os.makedirs(d)
    make_adapter(os.path.join(d, "kxc.safetensors"))
    with open(os.path.join(d, "kxc.json"), "w") as f:
        json.dump({"displayName": "Ken Carson", "trigger": "kxc",
                   "hint": "rage trap instrumental", "notes": "rage synths"}, f)
    make_adapter(os.path.join(d, "micz.safetensors"), rank=8, adapter_type="dora")
    make_adapter(os.path.join(d, "plain.safetensors"), adapter_type="lora")
    make_adapter(os.path.join(d, "xs.safetensors"), adapter_type="lora-xs")
    with open(os.path.join(d, "garbage.safetensors"), "wb") as f:
        f.write(b"not a safetensors file at all")
    # non-adapter noise that must be ignored entirely
    with open(os.path.join(d, "README.txt"), "w") as f:
        f.write("hi")

    rows = registry.descriptor()
    by = {r["name"]: r for r in rows}
    check("scan finds 5 .safetensors", len(rows) == 5, f"{len(rows)}")
    check("available True", registry.available() is True)

    kxc = by.get("kxc", {})
    check("kxc valid", kxc.get("valid") is True, str(kxc))
    check("kxc sidecar displayName", kxc.get("displayName") == "Ken Carson")
    check("kxc sidecar trigger", kxc.get("trigger") == "kxc")
    check("kxc sidecar hint", kxc.get("hint") == "rage trap instrumental")
    check("kxc sidecar notes", kxc.get("notes") == "rage synths")
    check("kxc rank from header", kxc.get("rank") == 16)
    check("kxc adapterType", kxc.get("adapterType") == "dora-rows")
    check("kxc sha12 is 12 hex", len(kxc.get("sha12", "")) == 12)
    check("kxc sizeBytes > 0", kxc.get("sizeBytes", 0) > 0)
    check("descriptor has no abs paths", "file" not in kxc and "path" not in kxc, str(kxc.keys()))
    check("descriptor has no full digest", "sha256" not in kxc)

    micz = by.get("micz", {})
    check("legacy 'dora' resolves valid", micz.get("valid") is True)
    check("legacy 'dora' → dora-rows", micz.get("adapterType") == "dora-rows")
    check("no sidecar → displayName = name", micz.get("displayName") == "micz")
    check("no sidecar → trigger empty", micz.get("trigger") in ("", None))
    check("micz rank 8", micz.get("rank") == 8)

    check("plain lora valid", by.get("plain", {}).get("valid") is True)

    xs = by.get("xs", {})
    check("lora-xs listed but invalid", xs.get("valid") is False)
    check("lora-xs reason mentions type", "adapter_type" in xs.get("reason", ""), xs.get("reason"))

    g = by.get("garbage", {})
    check("corrupt file listed invalid, no crash", g.get("valid") is False)
    check("corrupt reason non-empty", bool(g.get("reason")))

    # --- resolve(selection): unbounded, unclamped, fail-closed ------------------------
    sel = registry.resolve([{"name": "kxc", "value": 70},
                            {"name": "micz", "value": 125},   # overdrive allowed
                            {"name": "plain", "value": 0}])   # 0 == removed
    check("resolve keeps order", [t[0] for t in sel] == ["kxc", "micz"], str(sel))
    check("resolve file exists", os.path.isfile(sel[0][1]))
    check("resolve strength = value/100", sel[0][2] == 0.7)
    check("resolve overdrive unclamped", sel[1][2] == 1.25, str(sel[1]))
    def raises(selection):
        try:
            registry.resolve(selection)
            return False
        except ValueError:
            return True
    check("resolve unknown → ValueError", raises([{"name": "nope", "value": 50}]))
    check("resolve invalid file → ValueError", raises([{"name": "xs", "value": 50}]))
    check("resolve negative → ValueError", raises([{"name": "kxc", "value": -5}]))
    check("resolve duplicate → ValueError",
          raises([{"name": "kxc", "value": 50}, {"name": "kxc", "value": 60}]))
    check("resolve 4-stack unbounded",
          len(registry.resolve([{"name": n, "value": 50}
                                for n in ("kxc", "micz", "plain")])) == 3)

    # --- determinism: 3× scan, byte-identical JSON, sorted order ---------------------
    j1 = json.dumps(registry.descriptor(), sort_keys=True)
    j2 = json.dumps(registry.descriptor(), sort_keys=True)
    j3 = json.dumps(registry.descriptor(), sort_keys=True)
    check("3× deterministic", j1 == j2 == j3)
    names = [r["name"] for r in registry.descriptor()]
    check("sorted by name", names == sorted(names), str(names))

    # --- sha cache invalidates on content change --------------------------------------
    sha_before = by["micz"]["sha12"]
    make_adapter(os.path.join(d, "micz.safetensors"), rank=32, adapter_type="dora-rows")
    os.utime(os.path.join(d, "micz.safetensors"),
             ns=(os.stat(os.path.join(d, "micz.safetensors")).st_atime_ns,
                 os.stat(os.path.join(d, "micz.safetensors")).st_mtime_ns + 1))
    by2 = {r["name"]: r for r in registry.descriptor()}
    check("rewritten file → new sha", by2["micz"]["sha12"] != sha_before)
    check("rewritten file → new rank", by2["micz"]["rank"] == 32)

    # --- kill switch ------------------------------------------------------------------
    os.environ["MOSH_ENABLE_LORAS"] = "0"
    check("MOSH_ENABLE_LORAS=0 → descriptor []", registry.descriptor() == [])
    check("MOSH_ENABLE_LORAS=0 → available False", registry.available() is False)
    try:
        registry.resolve([{"name": "kxc", "value": 50}])
        check("MOSH_ENABLE_LORAS=0 → resolve fails closed", False)
    except ValueError:
        check("MOSH_ENABLE_LORAS=0 → resolve fails closed", True)
    os.environ.pop("MOSH_ENABLE_LORAS", None)

    # --- registry stays importable under a bare stdlib venv ---------------------------
    import loras.registry as _mod
    src = open(_mod.__file__.replace(".pyc", ".py")).read()
    for banned in ("import numpy", "import torch", "import mlx"):
        check(f"registry has no '{banned}'", banned not in src)

finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
