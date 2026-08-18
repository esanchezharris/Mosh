"""Golden for service/loras/registry.py — the two-family scan (library + lab).

The LoRA Lab auditions training checkpoints by rendering them through the SAME
path a kept adapter uses. That works because `sa3/lab/` is a second scanned
family, not a second mechanism — and this test pins the three properties that
make it safe:

  1. a lab checkpoint RESOLVES (so it can actually render), and to its own file;
  2. it is TAGGED `family: "lab"` (so the producer's rack can filter it out and
     not fill with six checkpoints from one run);
  3. a name collision with a library LoRA is reported INVALID, never silently
     shadowed and never silently dropped.

(3) is the one worth a test. `resolve()` keys on name, so a duplicate would make
"which weights rendered" depend on directory scan order — an unreproducible
audition, which is worse than no audition.

Stdlib only, matching the module under test. Hermetic (temp dir + env), so it is
safe to run anywhere and needs no SA3 assets.

Run:  python3 service/loras/registry_test.py
"""
from __future__ import annotations

import json
import os
import struct
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))     # service/
from loras import registry as REG  # noqa: E402

CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)


def write_lora(path: str, adapter_type: str = "dora-rows", modules: int = 2) -> None:
    """A minimal but genuinely valid DoRA-rows adapter — real header, real
    float32 payload. Stdlib only (no numpy): registry.py parses the header and
    hashes the bytes, and both work the same on hand-packed data."""
    header: dict = {"__metadata__": {"lora_config": json.dumps(
        {"rank": 2, "alpha": 2, "adapter_type": adapter_type})}}
    blobs: list[bytes] = []
    off = 0

    def add(key: str, shape: list[int]) -> None:
        nonlocal off
        n = 1
        for d in shape:
            n *= d
        raw = struct.pack(f"<{n}f", *[0.1 * (i + 1) for i in range(n)])
        header[key] = {"dtype": "F32", "shape": shape, "data_offsets": [off, off + len(raw)]}
        blobs.append(raw)
        off += len(raw)

    for i in range(modules):
        base = f"model.transformer.layers.{i}.self_attn.to_qkv.parametrizations.weight.0"
        add(base + ".lora_A", [2, 3])
        add(base + ".lora_B", [4, 2])
        if adapter_type in ("dora-rows", "dora"):
            add(base + ".magnitude", [4])

    hj = json.dumps(header).encode()
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(hj)))
        f.write(hj)
        for b in blobs:
            f.write(b)


def by_name(rows: list[dict]) -> dict:
    return {r["name"]: r for r in rows}


def main() -> None:
    tmp = tempfile.mkdtemp(prefix="lora-registry-test-")
    os.environ["MOSH_LORA_DIR"] = tmp
    os.environ.pop("MOSH_ENABLE_LORAS", None)
    lib = os.path.join(tmp, "sa3")
    lab = os.path.join(lib, "lab")
    os.makedirs(lab, exist_ok=True)

    # ── 1) a library-only world still behaves exactly as before ───────────────
    write_lora(os.path.join(lib, "ken.safetensors"))
    rows = REG.list_loras()
    check(len(rows) == 1, f"expected 1 library row, got {len(rows)}")
    check(rows[0]["family"] == "library", f"library row mistagged: {rows[0]['family']}")
    check(rows[0]["valid"], f"library row invalid: {rows[0]['reason']}")
    check(REG.available(), "available() false with a valid library LoRA")

    # The lab dir exists but is empty — must not invent rows, must not crash.
    check(REG.lab_dir() == lab, f"lab_dir wrong: {REG.lab_dir()}")

    # ── 2) lab checkpoints appear, tagged, and resolve to their OWN file ──────
    write_lora(os.path.join(lab, "run7@600.safetensors"))
    write_lora(os.path.join(lab, "run7@1200.safetensors"))
    rows = REG.list_loras()
    idx = by_name(rows)
    check(len(rows) == 3, f"expected 3 rows (1 library + 2 lab), got {len(rows)}")
    for nm in ("run7@600", "run7@1200"):
        check(nm in idx, f"lab checkpoint {nm} missing from the scan")
        check(idx[nm]["family"] == "lab", f"{nm} mistagged {idx[nm]['family']}")
        check(idx[nm]["valid"], f"{nm} invalid: {idx[nm]['reason']}")
    check(idx["ken"]["family"] == "library", "library row lost its tag once lab existed")

    resolved = REG.resolve([{"name": "run7@600", "value": 100}])
    check(len(resolved) == 1, f"lab checkpoint did not resolve: {resolved}")
    name, path, strength = resolved[0]
    check(name == "run7@600", f"resolved wrong name: {name}")
    check(os.path.dirname(path) == lab,
          f"lab checkpoint resolved to the wrong FILE ({path}) — it must render its own weights")
    check(abs(strength - 1.0) < 1e-9, f"strength wrong: {strength}")

    # A stack mixing the two families is the Stage-3 case; prove it resolves now.
    stacked = REG.resolve([{"name": "ken", "value": 100}, {"name": "run7@1200", "value": 50}])
    check([s[0] for s in stacked] == ["ken", "run7@1200"], f"stack order/identity wrong: {stacked}")
    check(abs(stacked[1][2] - 0.5) < 1e-9, f"stacked strength wrong: {stacked[1][2]}")

    # ── 3) available() ignores the lab family ────────────────────────────────
    # A producer who has trained but never KEPT anything must not be shown a
    # rack that the UI then filters down to empty.
    os.remove(os.path.join(lib, "ken.safetensors"))
    check(not REG.available(),
          "available() true with only lab checkpoints — the rack would open empty")
    check(len(REG.list_loras()) == 2, "lab rows vanished when the library emptied")

    # ── 4) the collision case: reported, not shadowed, not dropped ───────────
    write_lora(os.path.join(lib, "clash.safetensors"))
    write_lora(os.path.join(lab, "clash.safetensors"))
    rows = REG.list_loras()
    clashes = [r for r in rows if r["name"] == "clash"]
    check(len(clashes) == 2, f"collision dropped a row (got {len(clashes)}, want both listed)")
    libr = [r for r in clashes if r["family"] == "library"][0]
    labr = [r for r in clashes if r["family"] == "lab"][0]
    check(libr["valid"], "the LIBRARY side of a collision must stay usable")
    check(not labr["valid"], "the lab side of a collision must be marked invalid")
    check("collides" in labr["reason"], f"collision reason unhelpful: {labr['reason']!r}")

    # resolve() must fail CLOSED on the ambiguous name rather than pick one.
    try:
        REG.resolve([{"name": "clash", "value": 100}])
        check(False, "resolve() silently picked a side of a name collision")
    except ValueError:
        check(True, "resolve() fails closed on a collided name")

    # ── 5) the descriptor still withholds paths/digests, but carries family ──
    desc = REG.descriptor()
    check(all("file" not in r and "sha256" not in r for r in desc),
          "descriptor leaked an absolute path or a full digest")
    check(all("family" in r for r in desc), "descriptor dropped the family tag the UI filters on")
    check({r["family"] for r in desc} == {"library", "lab"},
          f"descriptor families wrong: {sorted({r['family'] for r in desc})}")

    # ── 6) a missing lab dir is the normal case, not an error ────────────────
    tmp2 = tempfile.mkdtemp(prefix="lora-registry-test-nolab-")
    os.environ["MOSH_LORA_DIR"] = tmp2
    os.makedirs(os.path.join(tmp2, "sa3"), exist_ok=True)
    write_lora(os.path.join(tmp2, "sa3", "solo.safetensors"))
    rows = REG.list_loras()
    check([r["name"] for r in rows] == ["solo"], f"no-lab-dir scan wrong: {rows}")
    check(rows[0]["family"] == "library", "no-lab-dir row mistagged")

    # ── 7) disabled kills BOTH families, not just the library ───────────────
    os.environ["MOSH_ENABLE_LORAS"] = "0"
    check(REG.list_loras() == [], "MOSH_ENABLE_LORAS=0 did not disable the scan")
    os.environ.pop("MOSH_ENABLE_LORAS", None)

    print(f"registry_test OK ({CHECKS} checks)")


if __name__ == "__main__":
    main()
