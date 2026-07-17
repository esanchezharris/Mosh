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
import uuid as _uuid
from typing import Dict, List, Optional

_PROVIDERS = [("deepseek", "DEEPSEEK"), ("openai", "OPENAI"), ("xai", "GROK")]
_BRAIN_ENV_CACHE: Optional[Dict[str, str]] = None
_INSTALL_ID_CACHE: Optional[str] = None


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


def _install_id() -> str:
    """Per-install id sent to the brain proxy for its daily token-cap bookkeeping
    (migrations/0003_brain_usage.sql) — an opaque bookkeeping key, never a secret.
    Reused from the SAME ~/Library/Mosh/<session>/identity.json "uuid" field
    src/brain/BrainProxy.cpp's installId() and vite.config.ts's installId() read/
    write, so whichever of the three processes runs first mints it and the others
    converge on it. MOSH_BRAIN_INSTALL_ID overrides outright (skips the filesystem —
    the test/CI seam); MOSH_SELFTEST_SESSION picks the session leaf, mirroring the
    native harness's own isolation boundary, so a hermetic run never touches the
    real ~/Library/Mosh/session/identity.json."""
    global _INSTALL_ID_CACHE
    override = os.environ.get("MOSH_BRAIN_INSTALL_ID")
    if override:
        return override
    if _INSTALL_ID_CACHE is not None:
        return _INSTALL_ID_CACHE
    leaf = os.environ.get("MOSH_SELFTEST_SESSION", "").strip() or "session"
    identity_dir = os.path.join(os.path.expanduser("~"), "Library", "Mosh", leaf)
    identity_file = os.path.join(identity_dir, "identity.json")
    try:
        with open(identity_file, encoding="utf-8") as f:
            data = json.load(f)
        existing = data.get("uuid", "")
        if existing:
            _INSTALL_ID_CACHE = existing
            return existing
    except (OSError, ValueError):
        pass  # absent / unreadable / malformed -> mint one below
    fresh = str(_uuid.uuid4())
    try:
        if not os.path.isfile(identity_file):
            os.makedirs(identity_dir, exist_ok=True)
            with open(identity_file, "w", encoding="utf-8") as f:
                json.dump({"uuid": fresh}, f)
    except OSError:
        pass  # best-effort persistence only; an ephemeral id still lets the request through
    _INSTALL_ID_CACHE = fresh
    return fresh


def proxy_enabled() -> bool:
    """True when MOSH_BRAIN_PROXY_URL is set — the signal to prefer the server-side
    proxy (supabase/functions/brain) over reading a provider key directly. See
    docs/brain-proxy/RUNBOOK.md."""
    return bool(_env("MOSH_BRAIN_PROXY_URL"))


def _chat_via_proxy(messages: List[dict], requested: str = "", timeout: int = 60,
                     temperature: Optional[float] = None) -> dict:
    """POST to the brain proxy. Returns the SAME {ok, content, provider, model} /
    {ok:false, error} shape as the direct-provider path below, normalized so callers
    never need to know which path served the request. Never sends or receives a
    provider key."""
    proxy_url = _env("MOSH_BRAIN_PROXY_URL")
    payload: Dict[str, object] = {"messages": messages, "install_id": _install_id()}
    if requested:
        payload["provider"] = requested
    if temperature is not None:
        payload["temperature"] = float(temperature)
    headers = {"Content-Type": "application/json"}
    apikey = _env("MOSH_BRAIN_PROXY_APIKEY")
    if apikey:
        headers["apikey"] = apikey
    req = urllib.request.Request(
        proxy_url, data=json.dumps(payload).encode("utf-8"), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (owner-configured proxy URL)
            body = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001 (network/proxy down -> caller falls back)
        return {"ok": False, "error": f"brain proxy request failed: {e}"}
    if not body.get("ok"):
        return {"ok": False, "error": body.get("error") or "brain proxy error"}
    # The proxy deliberately never discloses which upstream provider served it.
    return {"ok": True, "content": body.get("content", ""), "provider": "proxy", "model": ""}


def chat_json(messages: List[dict], requested: str = "", max_tokens: int = 800,
              timeout: int = 60, temperature: Optional[float] = None) -> dict:
    """POST an OpenAI-compatible chat (json_object response, capped tokens). Returns
    { ok, content, provider, model } or { ok:false, error }. Reasoning models use
    max_completion_tokens + no temperature (mirrors BrainProxy). `temperature`
    overrides the 0.6 default on the non-reasoning path only (best-of-n exploratory
    draws); reasoning providers ignore sampling params — callers record that.

    Proxy-first: when proxy_enabled(), this POSTs to the server-side brain proxy
    instead of calling a provider directly with a locally-configured key. Any proxy
    failure (unreachable / non-ok / malformed reply) falls through to the direct-
    provider path below — additive, never a regression from the pre-proxy behaviour
    (proxy_enabled()==False skips the branch entirely)."""
    if proxy_enabled():
        result = _chat_via_proxy(messages, requested, timeout, temperature)
        if result.get("ok"):
            return result
        # fall through to the direct-provider path (dev/local-key fallback; a deployed
        # service that relies on the proxy carries no keys, so resolve() below will
        # itself report "no provider configured" — the existing degrade path)

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
