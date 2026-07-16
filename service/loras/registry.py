"""LoRA library registry — the drop-in model-dir posture (RAVE_MODEL_DIR pattern).

A LoRA is a `<name>.safetensors` under `$MOSH_LORA_DIR/sa3/` (default
`~/Library/Mosh/loras/sa3`), optionally with a `<name>.json` sidecar card:
{"displayName", "trigger", "hint", "notes"}. Drop a file in -> it appears in
the rack menu. Only the `sa3/` family is listed (applied via the SA3 adapter);
other subdirs (e.g. `ace/`) are archival and ignored here.

Stdlib-only: safe to import from server.py on every /loras request.
"""
from __future__ import annotations

import json
import os

MAX_ACTIVE = 2          # compose limit, enforced service-side AND native-side
STRENGTH_MAX = 1.0      # value 0-100 -> strength 0..1
LAB_STRENGTH_MAX = 1.5  # Lab mode ceiling (mirrors the colour rack's lab unlock)


def lora_dir() -> str:
    root = os.environ.get("MOSH_LORA_DIR") or os.path.expanduser("~/Library/Mosh/loras")
    return os.path.join(root, "sa3")


def list_loras() -> list[dict]:
    """[{name, displayName, trigger, hint, file}] sorted by name; [] when absent."""
    d = lora_dir()
    if not os.path.isdir(d):
        return []
    out = []
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".safetensors"):
            continue
        name = fn[: -len(".safetensors")]
        card = {}
        card_path = os.path.join(d, name + ".json")
        if os.path.isfile(card_path):
            try:
                card = json.loads(open(card_path, encoding="utf-8").read())
            except Exception:  # noqa: BLE001 — a broken card never hides the LoRA
                card = {}
        out.append({
            "name": name,
            "displayName": str(card.get("displayName") or name),
            "trigger": str(card.get("trigger") or ""),
            "hint": str(card.get("hint") or ""),
            "file": os.path.join(d, fn),
        })
    return out


def resolve(selection: list[dict], lab: bool = False) -> list[tuple[str, str, float]]:
    """Validate a UI selection [{name, value 0-100}] -> [(name, file, strength)].

    Raises ValueError on unknown names, too many entries, or bad values —
    mirrored after colors.runtime.resolve_steers' fail-closed posture.
    """
    if not selection:
        return []
    if len(selection) > MAX_ACTIVE:
        raise ValueError(f"at most {MAX_ACTIVE} LoRAs may be active (got {len(selection)})")
    by_name = {e["name"]: e for e in list_loras()}
    ceil = LAB_STRENGTH_MAX if lab else STRENGTH_MAX
    out = []
    seen = set()
    for item in selection:
        name = str(item.get("name", ""))
        if not name or name not in by_name:
            raise ValueError(f"unknown LoRA: {name!r}")
        if name in seen:
            raise ValueError(f"duplicate LoRA: {name!r}")
        seen.add(name)
        value = float(item.get("value", 0))
        if not (0.0 <= value <= 100.0):
            raise ValueError(f"LoRA value out of range 0-100: {value}")
        strength = min(value / 100.0 * (LAB_STRENGTH_MAX if lab else 1.0), ceil)
        if strength <= 0.0:
            continue        # 0 = inert; skip rather than merge a no-op
        out.append((name, by_name[name]["file"], round(strength, 4)))
    return out
