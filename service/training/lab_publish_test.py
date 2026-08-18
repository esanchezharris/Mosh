"""Golden for service/training/lab_publish.py — run checkpoints -> auditionable takes.

The Lab's whole loop is "train, listen, keep". Publishing is the join between
the first two, and its failure mode is quiet: a run that trains perfectly, logs
six checkpoints, and shows an EMPTY take sheet, because nothing linked them
where the render path looks. Nothing errors. The bar just fills and no takes
appear.

So this pins the properties that make the sheet real:

  * a published take is VISIBLE TO THE REGISTRY and resolves to the checkpoint's
    own bytes (not the final adapter's, not another step's);
  * publishing is idempotent under the mid-run poll that calls it every 0.5s;
  * `@final` is a distinct take from the last periodic checkpoint;
  * a hostile run label cannot escape the lab directory;
  * `forget()` removes auditions and CANNOT remove a kept adapter.

That last one matters more than it looks: takes and kept adapters live one
directory apart, and "delete this run" running over the library would destroy
the only artifact the producer decided was worth keeping.

Stdlib only, hermetic (temp dirs + env).

Run:  python3 service/training/lab_publish_test.py
"""
from __future__ import annotations

import json
import os
import struct
import sys
import tempfile
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))          # service/
sys.path.insert(0, HERE)                              # service/training/

CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)


def write_lora(path: Path, marker: float = 0.5) -> None:
    """A valid DoRA-rows adapter whose payload carries a distinguishing value,
    so a test can tell WHICH checkpoint a link actually resolves to."""
    header: dict = {"__metadata__": {"lora_config": json.dumps(
        {"rank": 2, "alpha": 2, "adapter_type": "dora-rows"})}}
    blobs: list[bytes] = []
    off = 0

    def add(key: str, shape: list[int], fill: float) -> None:
        nonlocal off
        n = 1
        for d in shape:
            n *= d
        raw = struct.pack(f"<{n}f", *([fill] * n))
        header[key] = {"dtype": "F32", "shape": shape, "data_offsets": [off, off + len(raw)]}
        blobs.append(raw)
        off += len(raw)

    base = "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0"
    add(base + ".lora_A", [2, 3], marker)
    add(base + ".lora_B", [4, 2], marker)
    add(base + ".magnitude", [4], 1.0)
    hj = json.dumps(header).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(hj)))
        f.write(hj)
        for b in blobs:
            f.write(b)


def payload_marker(path: str) -> float:
    """Read back the first float of .lora_A — identifies which file this really is."""
    with open(path, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        hdr = json.loads(f.read(n))
        blob = f.read()
    key = [k for k in hdr if k.endswith(".lora_A")][0]
    s, _e = hdr[key]["data_offsets"]
    return struct.unpack_from("<f", blob, s)[0]


def main() -> None:
    tmp = tempfile.mkdtemp(prefix="lab-publish-test-")
    os.environ["MOSH_LORA_DIR"] = os.path.join(tmp, "loras")
    os.environ.pop("MOSH_ENABLE_LORAS", None)

    import lab_publish as LAB
    sys.path.insert(0, os.path.join(HERE, ".."))
    from loras import registry as REG

    lab = Path(REG.lab_dir())
    lib = Path(REG.lora_dir())

    # A run dir shaped exactly as pmetal leaves one: step_<N>/mosh_lora.safetensors
    # plus a final mosh_lora.safetensors at the top. Distinct payload markers so a
    # link that points at the WRONG checkpoint is detectable, not just present.
    run = Path(tmp) / "jobs" / "job-A" / "run"
    write_lora(run / "step_200" / "mosh_lora.safetensors", 0.2)
    write_lora(run / "step_400" / "mosh_lora.safetensors", 0.4)
    write_lora(run / "step_500" / "mosh_lora.safetensors", 0.5)   # last periodic
    write_lora(run / "mosh_lora.safetensors", 0.9)                # the END of training

    # ── 1) mid-run publish: checkpoints only, no @final yet ──────────────────
    takes = LAB.publish(run, "ken-run", final=False)
    names = sorted(t["name"] for t in takes)
    check(names == ["ken-run@200", "ken-run@400", "ken-run@500"],
          f"mid-run publish produced the wrong takes: {names}")
    check(not (lab / "ken-run@final.safetensors").exists(),
          "@final published mid-run — it does not exist until the trainer exits")

    # ── 2) the registry SEES them, tagged lab, and they resolve ─────────────
    # This is the property the whole sheet rests on. A link the registry cannot
    # see is a take that cannot be auditioned.
    rows = {r["name"]: r for r in REG.list_loras()}
    for nm in ("ken-run@200", "ken-run@400", "ken-run@500"):
        check(nm in rows, f"published take {nm} is invisible to the registry")
        check(rows[nm]["family"] == "lab", f"{nm} not tagged lab: {rows[nm]['family']}")
        check(rows[nm]["valid"], f"{nm} listed invalid: {rows[nm]['reason']}")

    # ── 3) each take resolves to ITS OWN bytes ──────────────────────────────
    # Every checkpoint has the same filename, one directory apart. A link built
    # from the wrong path — or all of them pointed at the run's final adapter —
    # would produce a sheet where every take sounds identical, and nothing about
    # the UI would look wrong.
    for nm, want in (("ken-run@200", 0.2), ("ken-run@400", 0.4), ("ken-run@500", 0.5)):
        (_n, path, _s) = REG.resolve([{"name": nm, "value": 100}])[0]
        got = payload_marker(path)
        check(abs(got - want) < 1e-6,
              f"{nm} resolves to the WRONG checkpoint (payload {got}, expected {want})")

    # ── 4) idempotent: the 0.5s poll calls this hundreds of times per run ────
    before = sorted(p.name for p in lab.iterdir())
    again = LAB.publish(run, "ken-run", final=False)
    after = sorted(p.name for p in lab.iterdir())
    check(before == after, f"republish changed the directory: {before} -> {after}")
    check(sorted(t["name"] for t in again) == names, "republish returned different takes")

    # ── 5) @final is a DISTINCT take from the last periodic checkpoint ───────
    # steps=500 with checkpoint_every=200 means step_500 and the final adapter are
    # different files. Folding them together would hide the end-of-training result
    # behind a checkpoint that is not it.
    takes = LAB.publish(run, "ken-run", final=True)
    fin = [t for t in takes if t["isFinal"]]
    check(len(fin) == 1, f"expected exactly one final take, got {len(fin)}")
    check(fin[0]["name"] == "ken-run@final", f"final take misnamed: {fin[0]['name']}")
    (_n, path, _s) = REG.resolve([{"name": "ken-run@final", "value": 100}])[0]
    check(abs(payload_marker(path) - 0.9) < 1e-6, "@final does not resolve to the final adapter")
    check(abs(payload_marker(REG.resolve([{"name": "ken-run@500", "value": 100}])[0][1]) - 0.5) < 1e-6,
          "@final publishing clobbered the last periodic checkpoint")

    # ── 6) a card is written so the take has a human name in the sheet ───────
    card = json.loads((lab / "ken-run@200.json").read_text())
    check("step 200" in card["displayName"], f"card displayName unhelpful: {card}")
    check("audition" in card["notes"].lower(), "card does not say these are not kept")

    # ── 7) a hostile label cannot escape the lab dir ─────────────────────────
    for bad in ("../../evil", "a/b", "..", ""):
        nm = LAB.take_name(bad, 1)
        check("/" not in nm and ".." not in nm, f"unsafe label {bad!r} produced {nm!r}")
    LAB.publish(run, "../../escape", final=False)
    escaped = list((Path(tmp) / "loras").glob("*.safetensors"))
    check(not escaped, f"publish wrote outside the lab dir: {escaped}")
    check(any(p.name.startswith("escape@") for p in lab.iterdir()),
          "sanitised label did not publish at all")

    # ── 8) forget() removes this run's auditions and NOTHING else ────────────
    # The dangerous case: a kept adapter promoted into the library must survive
    # deleting the run it came from. They differ by one directory level, so a
    # sloppy glob would take both.
    lib.mkdir(parents=True, exist_ok=True)
    write_lora(lib / "ken.safetensors", 0.7)                  # the KEPT one
    LAB.publish(run, "other-run", final=True)                 # a second run's takes
    n = LAB.forget("ken-run")
    check(n >= 8, f"forget removed too little ({n}) — links + cards for 4 takes expected")
    left = {r["name"] for r in REG.list_loras()}
    check(not any(x.startswith("ken-run@") for x in left), f"forget left takes behind: {left}")
    check("ken" in left, "forget DESTROYED the kept library adapter — the one thing it must never touch")
    check(abs(payload_marker(REG.resolve([{"name": "ken", "value": 100}])[0][1]) - 0.7) < 1e-6,
          "the kept adapter's bytes changed")
    check(any(x.startswith("other-run@") for x in left), "forget removed a DIFFERENT run's takes")

    # ── 9) prune() clears links whose run dir is gone ────────────────────────
    # A deleted run must not leave corpses. It must also not leave a take that
    # LISTS but cannot render — registry gates on isfile(), which follows the
    # link, so a dangling take disappears on its own; prune just tidies.
    import shutil
    shutil.rmtree(run)
    listed = {r["name"] for r in REG.list_loras()}
    check(not any(x.startswith("other-run@") for x in listed),
          "a take whose checkpoint is deleted still lists — it would fail at render time")
    removed = LAB.prune()
    check(removed > 0, "prune removed nothing despite dangling links")
    check(REG.resolve([{"name": "ken", "value": 100}]), "prune damaged the library")

    print(f"lab_publish_test OK ({CHECKS} checks)")


if __name__ == "__main__":
    main()
