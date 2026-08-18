"""Golden for loras/promote.py — "Keep" turns a lab take into a real adapter.

The load-bearing property is SURVIVAL. A lab take is a symlink into a run dir;
a kept adapter must still work after that run is deleted. If promotion ever
degrades into another link, everything here still passes at promote time and
the adapter evaporates later, when the producer cleans up an experiment they
already decided about. So the central case below deletes the run and re-reads.

Hermetic: synthetic DoRA tensors, temp MOSH_LORA_DIR, no model.

Run:  python3 service/loras/promote_test.py
"""
from __future__ import annotations

import json
import os
import shutil
import struct
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))     # service/

CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)


def write_adapter(path, n_modules=2, rank=4, dim=8):
    """A minimally-valid dora-rows adapter in Mosh's schema."""
    tensors, header, blobs, off = {}, {}, [], 0
    for i in range(n_modules):
        m = f"model.blocks.{i}.attn.q_proj.parametrizations.weight.0"
        tensors[f"{m}.lora_A"] = np.full((rank, dim), 0.01, dtype=np.float32)
        tensors[f"{m}.lora_B"] = np.full((dim, rank), 0.02, dtype=np.float32)
        tensors[f"{m}.magnitude"] = np.ones((dim,), dtype=np.float32)
    header["__metadata__"] = {"lora_config": json.dumps(
        {"adapter_type": "dora-rows", "rank": rank, "alpha": float(rank)})}
    for k, arr in tensors.items():
        raw = np.ascontiguousarray(arr, dtype=np.float32).tobytes()
        header[k] = {"dtype": "F32", "shape": list(arr.shape),
                     "data_offsets": [off, off + len(raw)]}
        blobs.append(raw)
        off += len(raw)
    hj = json.dumps(header).encode()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(hj)))
        f.write(hj)
        for b in blobs:
            f.write(b)


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="promote-test-"))
    os.environ["MOSH_LORA_DIR"] = str(tmp)

    from loras import promote as P     # noqa: E402 — after MOSH_LORA_DIR is set
    from loras import registry as REG  # noqa: E402

    lib = Path(REG.lora_dir())
    lab = Path(REG.lab_dir())
    lab.mkdir(parents=True, exist_ok=True)

    # A run dir with a real checkpoint, linked into the lab the way publish does.
    run = tmp / "runs" / "ken-01"
    real = run / "step_600" / "mosh_lora.safetensors"
    write_adapter(real)
    (lab / "ken-01@600.safetensors").symlink_to(real)
    (lab / "ken-01@600.json").write_text(json.dumps({"displayName": "ken-01 · step 600"}))

    # ── 1) the take is visible and valid, and tagged as lab ─────────────────
    rows = {r["name"]: r for r in REG.list_loras()}
    check("ken-01@600" in rows, f"lab take not listed: {list(rows)}")
    check(rows["ken-01@600"]["family"] == "lab", "take should be family=lab")
    check(rows["ken-01@600"]["valid"], f"take invalid: {rows['ken-01@600'].get('reason')}")

    # ── 2) promote it ───────────────────────────────────────────────────────
    out = P.promote("ken-01@600", name="ken-keeper", trigger="kxc",
                    notes="the one that sounded right")
    check(out.get("promotedFrom") == "ken-01@600", f"missing provenance: {out}")
    dest = lib / "ken-keeper.safetensors"
    check(dest.is_file(), "promoted adapter not written")
    check(not dest.is_symlink(),
          "promoted adapter is a SYMLINK — it will evaporate when the run is deleted, "
          "which is the exact failure this whole module exists to prevent")

    rows = {r["name"]: r for r in REG.list_loras()}
    check("ken-keeper" in rows, "promoted adapter not listed by the registry")
    check(rows["ken-keeper"]["family"] == "library", "promoted adapter should be family=library")
    check(rows["ken-keeper"]["valid"], f"promoted adapter invalid: {rows['ken-keeper'].get('reason')}")
    check(rows["ken-keeper"]["trigger"] == "kxc", "card lost the trigger")

    # ── 3) THE point: it survives deleting the run ─────────────────────────
    shutil.rmtree(run.parent)
    check(not real.exists(), "fixture: run should be gone")
    check(dest.is_file(), "kept adapter did NOT survive deleting its run")
    rows = {r["name"]: r for r in REG.list_loras()}
    check(rows.get("ken-keeper", {}).get("valid"),
          "kept adapter stopped being valid once its run was deleted")
    # And the now-dangling take drops out of the listing rather than erroring.
    check("ken-01@600" not in rows,
          "a dangling lab take should disappear from the registry, not linger")

    # ── 4) fail closed ─────────────────────────────────────────────────────
    for bad, why in (("nope@1", "unknown source"), ("", "empty source")):
        try:
            P.promote(bad, name="x1")
            check(False, f"{why} was not rejected")
        except ValueError:
            check(True, f"{why} rejected")

    write_adapter(lab / "run2@100.safetensors")          # a real file, not a link
    try:
        P.promote("run2@100", name="ken-keeper")
        check(False, "promoting onto an existing name was not rejected")
    except ValueError as e:
        check("already exists" in str(e), f"wrong error for name collision: {e}")

    try:
        P.promote("run2@100", name="")
        check(False, "empty destination name was not rejected")
    except ValueError:
        check(True, "empty destination name rejected")

    # An INVALID take must never reach the library — the render path would refuse
    # it, and the producer would find out long after the decision.
    #
    # NOTE on what this does and does not prove. `install()` validates the staged
    # copy itself, so a broken take is refused even with promote's own `valid`
    # gate deleted — a sabotage run confirmed that, which means "it raised" is
    # NOT evidence the gate works. What the gate actually buys is (a) a message
    # naming the registry's reason instead of a parse error, and (b) failing
    # before the library directory is touched at all. So the message is asserted
    # too; that is the part that discriminates.
    (lab / "broken@1.safetensors").write_bytes(b"not a safetensors file at all")
    rows = {r["name"]: r for r in REG.list_loras()}
    check("broken@1" in rows and not rows["broken@1"]["valid"],
          "fixture: broken take should be listed-but-invalid")
    try:
        P.promote("broken@1", name="should-not-exist")
        check(False, "an invalid take was promoted")
    except ValueError as e:
        check("not a usable adapter" in str(e),
              f"expected promote's own pre-flight message (it names the registry's "
              f"reason and fails before touching the library); got: {e}")
    check(not (lib / "should-not-exist.safetensors").exists(),
          "a refused promotion still wrote a file into the library")
    check(not any(f.name.startswith("tmp") for f in lib.iterdir()),
          "a refused promotion left a staging temp file behind")

    # ── 5) a path-ish name cannot escape the library ───────────────────────
    for nm in ("../escape", "a/b", "..", "."):
        try:
            P.promote("run2@100", name=nm)
            check(False, f"unsafe name {nm!r} was accepted")
        except ValueError:
            check(True, f"unsafe name {nm!r} rejected")

    print(f"promote_test OK ({CHECKS} checks)")


if __name__ == "__main__":
    main()
