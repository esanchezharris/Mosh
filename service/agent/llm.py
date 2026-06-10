"""LLM provider adapter (phase0 §10) — stdlib urllib only, keys ONLY from env.

Providers:
  gemini — rollouts + the in-app agent (spec §10's choice; GEMINI_API_KEY)
  claude — GEPA's reflection step option (ANTHROPIC_API_KEY)
  mock   — deterministic canned proposals so gates/CI run with zero spend

Keys are read at call time from the environment and never logged, echoed,
or persisted. There are no defaults and no fallbacks between real providers.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

GEMINI_MODEL = os.environ.get("MOSH_AGENT_MODEL", "gemini-2.5-flash")
CLAUDE_MODEL = os.environ.get("MOSH_REFLECT_MODEL", "claude-sonnet-4-6")


class ProviderError(RuntimeError):
    pass


def complete(provider: str, system: str, user: str,
             temperature: float = 0.2, json_mode: bool = True) -> str:
    """One-shot completion. Returns the raw text of the model's reply."""
    if provider == "mock":
        return _mock(user)
    if provider == "gemini":
        return _gemini(system, user, temperature, json_mode)
    if provider == "claude":
        return _claude(system, user, temperature)
    raise ProviderError(f"unknown provider: {provider}")


def complete_with_images(provider: str, system: str, user: str,
                         image_paths: list, temperature: float = 0.0) -> str:
    """Multimodal completion (vision claims, phase0 §7.4). Gemini only;
    mock returns an empty claims array so fixture paths stay zero-spend."""
    if provider == "mock":
        return "[]"
    if provider != "gemini":
        raise ProviderError(f"provider '{provider}' has no image path wired")
    import base64
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise ProviderError("GEMINI_API_KEY not set (env only — never in repo/chat)")
    parts = [{"text": user}]
    for p in image_paths:
        with open(p, "rb") as f:
            parts.append({"inline_data": {
                "mime_type": "image/jpeg",
                "data": base64.b64encode(f.read()).decode("ascii")}})
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{GEMINI_MODEL}:generateContent?key={key}")
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": temperature,
                             "maxOutputTokens": 8192,
                             "responseMimeType": "application/json"},
    }
    out = _post(url, {}, body, timeout=120.0)
    try:
        return out["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise ProviderError(f"unexpected gemini response shape: {str(out)[:200]}") from None


def _post(url: str, headers: dict, body: dict, timeout: float = 60.0) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise ProviderError(f"HTTP {e.code}: {detail}") from None
    except urllib.error.URLError as e:
        raise ProviderError(f"network: {e.reason}") from None


def _gemini(system: str, user: str, temperature: float, json_mode: bool) -> str:
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise ProviderError("GEMINI_API_KEY not set (env only — never in repo/chat)")
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{GEMINI_MODEL}:generateContent?key={key}")
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": 16384,    # dense note arrays must never truncate
            **({"responseMimeType": "application/json"} if json_mode else {}),
        },
    }
    out = _post(url, {}, body)
    try:
        return out["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise ProviderError(f"unexpected gemini response shape: {str(out)[:200]}") from None


def _claude(system: str, user: str, temperature: float) -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        raise ProviderError("ANTHROPIC_API_KEY not set (env only)")
    body = {
        "model": CLAUDE_MODEL,
        "max_tokens": 4096,
        "temperature": temperature,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    out = _post("https://api.anthropic.com/v1/messages",
                {"x-api-key": key, "anthropic-version": "2023-06-01"}, body)
    try:
        return "".join(b.get("text", "") for b in out["content"])
    except (KeyError, TypeError):
        raise ProviderError(f"unexpected claude response shape: {str(out)[:200]}") from None


def _mock(user: str) -> str:
    """Deterministic structured proposals keyed on instruction keywords —
    enough surface for the smoke gates: tempo, a track, a clip, notes, gain."""
    instruction = user.lower()
    bpm = 140
    for tok in instruction.replace("bpm", " ").split():
        if tok.isdigit() and 60 <= int(tok) <= 220:
            bpm = int(tok)
            break
    role = "drums" if "drum" in instruction or "kick" in instruction else \
           "808" if "808" in instruction or "bass" in instruction else "melody"
    pitches = ["C2", "Eb2", "G2", "C3"] if role != "drums" else ["C1", "C1", "C1", "C1"]
    ops = [
        {"kind": "project.set_tempo", "params": {"bpm": bpm}},
        {"kind": "track.create", "params": {"track_id": "tm1", "kind": "midi", "role": role}},
        {"kind": "device.add", "params": {"device_id": "dm1", "track_id": "tm1",
                                          "role": "synth", "prefer": ["builtin.synth"]}},
        {"kind": "clip.create", "params": {"clip_id": "cm1", "track_id": "tm1",
                                           "start_bar": 1, "length_beats": 16, "kind": "midi"}},
        {"kind": "notes.add", "params": {"clip_id": "cm1", "notes": [
            {"pitch": p, "start_beats": float(i * 4), "dur_beats": 2.0, "vel": 100}
            for i, p in enumerate(pitches)]}},
        {"kind": "mixer.set_gain", "params": {"track_id": "tm1", "db": -3.0}},
    ]
    return json.dumps({"rationale": f"mock proposal ({role} at {bpm} bpm)", "ops": ops})
