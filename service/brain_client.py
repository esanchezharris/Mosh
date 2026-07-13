#!/usr/bin/env python3
"""Service-side brain (LLM) client — the Python mirror of src/brain/BrainProxy.cpp and
ui/vite.config.ts's moshiBrain proxy, so the WHOLE app shares one key story.

Resolves an OpenAI-compatible provider from the environment (deepseek → openai → xai),
falling back to the bundled brain.env file exactly like BrainProxy::env() — the service
is the app's child process, and the app writes the user's key to Contents/Resources/
brain.env, so a Finder/Dock launch (which inherits no shell env) still has a brain.

Stdlib only (urllib), so it runs under any service interpreter. Used by the lyric
generation loop (service/lyrics) for the REAL backend; absent keys ⇒ available() is
False ⇒ the loop degrades to the deterministic fake (like stable_audio3 → fake).
Set MOSH_ENABLE_LYRIC=0 to force the fake even when a provider is configured.
"""
from __future__ import annotations

import json
import os
import urllib.request
from typing import Dict, List, Optional

_PROVIDERS = [("deepseek", "DEEPSEEK"), ("openai", "OPENAI"), ("xai", "XAI")]
_BRAIN_ENV_CACHE: Optional[Dict[str, str]] = None


def _load_brain_env() -> Dict[str, str]:
    """Parse the bundled brain.env (key=value, # comments, optional quotes) — the
    FALLBACK when a value isn't in the OS environment. Located via MOSH_BRAIN_ENV or by
    walking up from this file (finds Contents/Resources/brain.env in the app bundle)."""
    global _BRAIN_ENV_CACHE
    if _BRAIN_ENV_CACHE is not None:
        return _BRAIN_ENV_CACHE
    cfg: Dict[str, str] = {}
    candidates: List[str] = []
    if os.environ.get("MOSH_BRAIN_ENV"):
        candidates.append(os.environ["MOSH_BRAIN_ENV"])
    d = os.path.dirname(os.path.abspath(__file__))  # service/
    for _ in range(6):
        candidates.append(os.path.join(d, "brain.env"))
        candidates.append(os.path.join(d, "Resources", "brain.env"))
        d = os.path.dirname(d)
    for path in candidates:
        if path and os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as f:
                    for raw in f:
                        line = raw.strip()
                        if not line or line.startswith("#") or "=" not in line:
                            continue
                        k, v = line.split("=", 1)
                        v = v.strip()
                        if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
                            v = v[1:-1]
                        cfg[k.strip()] = v
                break
            except OSError:
                pass
    _BRAIN_ENV_CACHE = cfg
    return cfg


def _env(name: str) -> str:
    return os.environ.get(name) or _load_brain_env().get(name, "")


def _providers() -> List[Dict[str, str]]:
    out = []
    for pid, prefix in _PROVIDERS:
        out.append({"id": pid, "label": prefix, "url": _env(f"{prefix}_BASE_URL"),
                    "key": _env(f"{prefix}_API_KEY"), "model": _env(f"{prefix}_MODEL")})
    return out


def _complete(p: Optional[Dict[str, str]]) -> bool:
    return bool(p and p.get("url") and p.get("key") and p.get("model"))


def resolve(requested: str = "") -> Optional[Dict[str, str]]:
    """The provider chain, mirroring BrainProxy::resolve: requested → MOSHI_BRAIN_PROVIDER
    → first complete (deepseek, openai, xai)."""
    provs = _providers()
    by_id = {p["id"]: p for p in provs}
    if requested and _complete(by_id.get(requested)):
        return by_id[requested]
    dflt = _env("MOSHI_BRAIN_PROVIDER")
    if dflt and _complete(by_id.get(dflt)):
        return by_id[dflt]
    for p in provs:
        if _complete(p):
            return p
    return None


def available() -> bool:
    """True when a provider is configured AND lyric LLM isn't force-disabled."""
    if os.environ.get("MOSH_ENABLE_LYRIC", "1") == "0":
        return False
    return resolve() is not None


def _is_reasoning(model: str) -> bool:
    return (model.startswith("gpt-5") or model.startswith("gpt-6")
            or (len(model) >= 2 and model[0] == "o" and model[1].isdigit()))


def chat_json(messages: List[dict], requested: str = "", max_tokens: int = 800,
              timeout: int = 60, temperature: Optional[float] = None) -> dict:
    """POST an OpenAI-compatible chat (json_object response, capped tokens). Returns
    { ok, content, provider, model } or { ok:false, error }. Reasoning models use
    max_completion_tokens + no temperature (mirrors BrainProxy). `temperature`
    overrides the 0.6 default on the non-reasoning path only (best-of-n exploratory
    draws); reasoning providers ignore sampling params — callers record that."""
    p = resolve(requested)
    if not _complete(p):
        return {"ok": False, "error": "no brain provider configured "
                "(set <PROVIDER>_API_KEY / _BASE_URL / _MODEL: deepseek|openai|xai)"}
    payload: Dict[str, object] = {"model": p["model"], "messages": messages,
                                  "response_format": {"type": "json_object"}}
    if p["id"] == "openai" and _is_reasoning(p["model"]):
        payload["max_completion_tokens"] = max_tokens
    else:
        payload["max_tokens"] = max_tokens
        payload["temperature"] = 0.6 if temperature is None else float(temperature)
    req = urllib.request.Request(
        p["url"].rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + p["key"]})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (trusted provider URL)
            body = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001 (network/provider down → caller falls back to fake)
        return {"ok": False, "error": f"brain request failed: {e}"}
    content = ""
    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        pass
    return {"ok": True, "content": content, "provider": p["id"], "model": p["model"]}
