"""LoRA library registry — the drop-in model-dir posture (RAVE_MODEL_DIR pattern).

A LoRA is a `<name>.safetensors` under `$MOSH_LORA_DIR/sa3/` (default
`~/Library/Mosh/loras/sa3`), optionally with a `<name>.json` sidecar card:
{"displayName", "trigger", "hint", "notes"}. Drop a file in -> it appears in
the rack menu. Only the `sa3/` family is listed (applied via the SA3 adapter);
other subdirs (e.g. `ace/`) are archival and ignored here.

Product name is "LoRA"; the files are DoRA-rows format internally. Only the
safetensors HEADER is parsed (8-byte LE length + JSON): tensor shapes give the
rank, `lora_config` metadata gives adapter_type/alpha. sha256 of the full file
is cached by (path, size, mtime_ns) — it feeds the native render fingerprint
so a retrained same-name file is a cache MISS, and the engine's apply key so a
mid-session retrain never reuses a stale in-memory merge.

NO budget rule (owner call, 2026-07-16): no adapter-count cap, no strength
clamp, no Lab gating. `value` is the 0-100 fader; >100 is deliberate overdrive
(strength >1.0), negative is rejected, 0 means removed. The UI shows an
informational Σ readout only.

Stdlib-only: safe to import from server.py on every /loras request.
"""
from __future__ import annotations

import hashlib
import json
import os
import struct

# adapter_type values the apply runtime supports. "dora" is the legacy alias
# for dora-rows (upstream resolve_adapter_type); plain "lora" applies as a
# degenerate DoRA with no renorm.
_SUPPORTED = ("dora-rows", "dora", "lora")

# sha256 cache: path -> (size, mtime_ns, sha256hex)
_sha_cache: dict = {}


def lora_dir() -> str:
    root = os.environ.get("MOSH_LORA_DIR") or os.path.expanduser("~/Library/Mosh/loras")
    return os.path.join(root, "sa3")


def enabled() -> bool:
    return os.environ.get("MOSH_ENABLE_LORAS", "1") != "0"


def _read_header(path: str) -> dict:
    """Parse the safetensors header only. Raises ValueError on malformed input."""
    with open(path, "rb") as f:
        raw = f.read(8)
        if len(raw) < 8:
            raise ValueError("truncated safetensors header")
        (n,) = struct.unpack("<Q", raw)
        if n <= 0 or n > 100 * 1024 * 1024:
            raise ValueError("implausible safetensors header size")
        hj = f.read(n)
        if len(hj) < n:
            raise ValueError("truncated safetensors header json")
    header = json.loads(hj.decode("utf-8"))
    if not isinstance(header, dict):
        raise ValueError("safetensors header is not an object")
    return header


def _sha256(path: str, size: int, mtime_ns: int) -> str:
    hit = _sha_cache.get(path)
    if hit and hit[0] == size and hit[1] == mtime_ns:
        return hit[2]
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    digest = h.hexdigest()
    _sha_cache[path] = (size, mtime_ns, digest)
    return digest


def _resolve_adapter_type(raw: str) -> str:
    return "dora-rows" if raw == "dora" else raw


def _inspect(path: str) -> dict:
    """One adapter file -> full record (server-side; includes the abs path)."""
    name = os.path.splitext(os.path.basename(path))[0]
    st = os.stat(path)
    rec = {
        "name": name, "displayName": name, "trigger": "", "hint": "", "notes": "",
        "sizeBytes": st.st_size, "valid": False, "reason": "",
        "rank": 0, "alpha": 0, "adapterType": "", "tensors": 0,
        "sha12": "", "sha256": "", "file": path,
    }

    # Sidecar first — even an invalid file keeps its human metadata.
    sidecar = os.path.splitext(path)[0] + ".json"
    if os.path.isfile(sidecar):
        try:
            with open(sidecar, encoding="utf-8") as f:
                sc = json.load(f)
            if isinstance(sc, dict):
                rec["displayName"] = str(sc.get("displayName") or name)
                rec["trigger"] = str(sc.get("trigger") or "")
                rec["hint"] = str(sc.get("hint") or "")
                rec["notes"] = str(sc.get("notes") or "")
        except Exception as e:  # noqa: BLE001 — a broken card never hides the LoRA
            print(f"[loras] bad sidecar {sidecar}: {e}", flush=True)

    try:
        header = _read_header(path)
    except Exception as e:  # noqa: BLE001
        rec["reason"] = f"unreadable safetensors: {e}"
        return rec

    meta = header.get("__metadata__") or {}
    cfg = {}
    if isinstance(meta, dict) and meta.get("lora_config"):
        try:
            cfg = json.loads(meta["lora_config"])
        except Exception:  # noqa: BLE001
            cfg = {}

    tensor_keys = [k for k in header if k != "__metadata__"]
    lora_a = [k for k in tensor_keys if k.endswith(".lora_A")]
    if not lora_a:
        rec["reason"] = "no .lora_A tensors — not a LoRA adapter"
        rec["tensors"] = len(tensor_keys)
        return rec

    raw_type = str(cfg.get("adapter_type") or "")
    if not raw_type:
        has_mag = any(k.endswith(".magnitude") for k in tensor_keys)
        raw_type = "dora-rows" if has_mag else "lora"
    if raw_type not in _SUPPORTED:
        rec["adapterType"] = raw_type
        rec["reason"] = f"unsupported adapter_type '{raw_type}'"
        rec["tensors"] = len(tensor_keys)
        return rec

    rank = int(cfg.get("rank") or 0)
    if rank <= 0:
        shape = header[lora_a[0]].get("shape") or [0]
        rank = int(shape[0])

    rec.update({
        "valid": True,
        "adapterType": _resolve_adapter_type(raw_type),
        "rank": rank,
        "alpha": int(cfg.get("alpha") or rank),
        "tensors": len(tensor_keys),
    })
    sha = _sha256(path, st.st_size, st.st_mtime_ns)
    rec["sha256"] = sha
    rec["sha12"] = sha[:12]
    return rec


def list_loras() -> list[dict]:
    """Full records (incl. `file` + sha) sorted by name; [] when absent/disabled.
    Invalid files are listed with valid:false + a reason (never hidden)."""
    if not enabled():
        return []
    d = lora_dir()
    if not os.path.isdir(d):
        return []
    rows = []
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".safetensors"):
            continue
        path = os.path.join(d, fn)
        if not os.path.isfile(path):
            continue
        try:
            rows.append(_inspect(path))
        except Exception as e:  # noqa: BLE001 — one bad file never kills the scan
            print(f"[loras] failed to inspect {path}: {e}", flush=True)
    return rows


def descriptor() -> list[dict]:
    """The /loras payload — no absolute paths / full digests leave the service."""
    out = []
    for rec in list_loras():
        row = dict(rec)
        row.pop("file", None)
        row.pop("sha256", None)
        out.append(row)
    return out


def resolve(selection: list[dict], lab: bool = False) -> list[tuple[str, str, float]]:
    """Validate a UI selection [{name, value}] -> [(name, file, strength)] in order.

    Unbounded and unclamped (owner call): strength = value/100, value>100 allowed
    (overdrive), negative rejected, 0 skipped as removed. Raises ValueError on
    unknown/invalid names or duplicates — fail-closed before any job submit.
    `lab` is accepted for signature compatibility; it gates nothing here.
    """
    if not selection:
        return []
    by_name = {e["name"]: e for e in list_loras()}
    out = []
    seen = set()
    for item in selection:
        name = str(item.get("name", ""))
        rec = by_name.get(name)
        if not name or rec is None:
            raise ValueError(f"LoRA '{name}' not found — drop the .safetensors in {lora_dir()}")
        if not rec.get("valid"):
            raise ValueError(f"LoRA '{name}' is not usable: {rec.get('reason') or 'invalid'}")
        if name in seen:
            raise ValueError(f"duplicate LoRA: {name!r}")
        seen.add(name)
        value = float(item.get("value", 0))
        if value < 0.0:
            raise ValueError(f"LoRA value must be >= 0 (got {value})")
        strength = value / 100.0
        if strength <= 0.0:
            continue        # 0 = removed; skip rather than merge a no-op
        out.append((name, rec["file"], round(strength, 4)))
    return out


def available() -> bool:
    return enabled() and any(r["valid"] for r in list_loras())
