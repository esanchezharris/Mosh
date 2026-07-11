"""Enroll a trained SA3 LoRA into the runtime library (registry.lora_dir()).

Accepts a trained `.safetensors` (torch-layout, from train_lora.py) OR a training
`.ckpt` (pytorch-lightning; the wrapper's on_save_checkpoint stores a LoRA-only
`state_dict` + `lora_config`). Validates it is loadable + a supported adapter,
atomically copies it to `$MOSH_LORA_DIR/sa3/<name>.safetensors`, and writes the
`<name>.json` card so the rack lists it. The offline pod-pull calls this so a
finished training run auto-enrolls — no manual bake, and the runtime engine
consumes the trained `.safetensors` directly.

The `.safetensors` path is stdlib + numpy (hermetic). The `.ckpt` path also needs
torch + safetensors (present in the SA3 venv).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if os.path.join(HERE, "..") not in sys.path:
    sys.path.insert(0, os.path.join(HERE, ".."))     # service/
from sa3 import lora_merge as LM   # noqa: E402
from loras import registry as REG  # noqa: E402

SUPPORTED = ("dora-rows", "dora", "lora")
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")   # safe filename stem, no separators/..


def _validate(path: str) -> tuple[str, int]:
    """Return (adapter_type, n_modules); raise ValueError if not a usable LoRA."""
    try:
        tensors, meta = LM.read_safetensors(path)
    except Exception as e:                       # noqa: BLE001 — any parse failure = invalid
        raise ValueError(f"not a readable safetensors file: {e}")
    cfg = json.loads(meta.get("lora_config", "{}")) if meta else {}
    adapter_type = cfg.get("adapter_type", "dora-rows")
    if adapter_type not in SUPPORTED:
        raise ValueError(f"unsupported adapter_type {adapter_type!r} (supported: {SUPPORTED})")
    groups = LM.group_lora(tensors)
    if not groups:
        raise ValueError("no LoRA parametrization tensors found")
    for module, parts in groups.items():
        if "lora_A" not in parts or "lora_B" not in parts:
            raise ValueError(f"module {module} missing lora_A/lora_B")
        if adapter_type in ("dora-rows", "dora") and "magnitude" not in parts:
            raise ValueError(f"module {module} missing magnitude (dora)")
    return adapter_type, len(groups)


def _ckpt_to_safetensors(ckpt_path: str, out_path: str) -> None:
    """Convert a training .ckpt to a LoRA safetensors. Mirrors the training
    wrapper's on_save_checkpoint / export_lora_safetensors: the ckpt already holds
    a LoRA-only state_dict + lora_config, so this just re-serializes it."""
    import torch
    from safetensors.torch import save_file
    try:
        obj = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    except TypeError:                            # older torch without weights_only
        obj = torch.load(ckpt_path, map_location="cpu")
    sd = obj.get("state_dict", obj) if isinstance(obj, dict) else obj
    cfg = obj.get("lora_config") or {} if isinstance(obj, dict) else {}
    if not sd:
        raise ValueError("ckpt has no state_dict")
    sd = {k: v.contiguous() for k, v in sd.items()}
    save_file(sd, out_path, metadata={"lora_config": json.dumps(cfg)})


def install(src: str, name: str, trigger: str = "", hint: str = "", notes: str = "",
            display: str | None = None, lora_dir: str | None = None) -> dict:
    """Validate `src` (.safetensors or .ckpt) and enroll it as <name> in the library."""
    if not _NAME_RE.match(name or ""):
        raise ValueError(f"invalid LoRA name {name!r} (letters/digits then ._- only)")
    if not os.path.isfile(src):
        raise ValueError(f"source not found: {src}")
    dest_dir = lora_dir or REG.lora_dir()
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, f"{name}.safetensors")

    # Stage into a temp on the SAME filesystem so the final swap is atomic, and
    # validate the staged copy before it can shadow a good LoRA.
    fd, staged = tempfile.mkstemp(suffix=".safetensors", dir=dest_dir)
    os.close(fd)
    try:
        if src.endswith(".ckpt"):
            _ckpt_to_safetensors(src, staged)
        elif src.endswith(".safetensors"):
            shutil.copyfile(src, staged)
        else:
            raise ValueError(
                f"unsupported source extension: {os.path.basename(src)} "
                "(want .safetensors or .ckpt)")
        adapter_type, n_modules = _validate(staged)
        os.replace(staged, dest)
    finally:
        if os.path.exists(staged):
            os.remove(staged)

    card = {"displayName": display or name, "trigger": trigger, "hint": hint, "notes": notes}
    card_path = os.path.join(dest_dir, f"{name}.json")
    with open(card_path, "w", encoding="utf-8") as f:
        json.dump(card, f, indent=2)
    return {"name": name, "file": dest, "card": card_path,
            "adapter_type": adapter_type, "modules": n_modules}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Enroll a trained SA3 LoRA into the Mosh library.")
    ap.add_argument("src", help="path to a trained .safetensors or a training .ckpt")
    ap.add_argument("--name", required=True, help="library name (filename stem)")
    ap.add_argument("--trigger", default="", help="trigger word to fold into prompts")
    ap.add_argument("--hint", default="", help="one-line UI hint")
    ap.add_argument("--notes", default="", help="freeform notes")
    ap.add_argument("--display", default=None, help="display name (defaults to --name)")
    ap.add_argument("--lora-dir", default=None, help="override library dir (default $MOSH_LORA_DIR/sa3)")
    a = ap.parse_args(argv)
    res = install(a.src, a.name, trigger=a.trigger, hint=a.hint, notes=a.notes,
                  display=a.display, lora_dir=a.lora_dir)
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
