"""A judge panel of different MODELS (FMS lyrics-bench I2b). Pure stdlib.

The first panel was one model asked three ways: the lenses agreed 91-98% of the
time and the third changed the verdict on 1 of 39 items — 3x the API cost for
one opinion, dressed as three. A panel is only worth its cost when the judges
can actually disagree, which means different model families.

This resolves judges from whatever credentials exist, biggest source of
diversity first:

  * **OpenRouter** — one key fronting several families (Claude, Gemini,
    DeepSeek, Llama). The cheapest real diversity available.
  * **Direct providers** — openai, xai, deepseek. Note `XAI_*` is accepted as
    well as `GROK_*`: the shipped `brain_client` only reads the GROK_ prefix, so
    a working xai credential was sitting unused on this machine.

`disagreement()` is reported alongside every verdict, because a panel that never
disagrees is telling you it is one opinion — and that is a finding, not a
detail.
"""
from __future__ import annotations

import json
import urllib.request
from typing import Callable, Dict, List, Optional, Sequence

# Deliberately different families, cheap-first. Kept small: each added judge
# multiplies the cost of every pair.
OPENROUTER_MODELS = (
    "deepseek/deepseek-chat",
    "google/gemini-3.5-flash-lite",
    "qwen/qwen3.6-flash",
)
OPENROUTER_URL = "https://openrouter.ai/api/v1"

# (provider id, env prefixes to try in order)
_DIRECT = (("openai", ("OPENAI",)), ("xai", ("GROK", "XAI")),
           ("deepseek", ("DEEPSEEK",)))


def resolve_judges(env: Optional[Dict[str, str]] = None) -> List[dict]:
    """Every distinct judge the available credentials can field."""
    import os
    env = env if env is not None else dict(os.environ)
    judges: List[dict] = []

    if env.get("OPENROUTER_KEY") or env.get("OPENROUTER_API_KEY"):
        key = env.get("OPENROUTER_KEY") or env["OPENROUTER_API_KEY"]
        for n, model in enumerate(OPENROUTER_MODELS):
            judges.append({"id": f"openrouter:{model.split('/')[0]}",
                           "model": model,
                           "url": env.get("OPENROUTER_BASE_URL", OPENROUTER_URL),
                           "key": key})

    for pid, prefixes in _DIRECT:
        for prefix in prefixes:
            key = env.get(f"{prefix}_API_KEY")
            url = env.get(f"{prefix}_BASE_URL")
            model = env.get(f"{prefix}_MODEL")
            if key and url and model:
                judges.append({"id": pid, "model": model, "url": url, "key": key})
                break

    seen = set()
    out = []
    for j in judges:
        tag = (j["id"], j["model"])
        if tag not in seen:
            seen.add(tag)
            out.append(j)
    return out


def _is_reasoning(model: str) -> bool:
    m = model.split("/")[-1]
    return (m.startswith("gpt-5") or m.startswith("gpt-6")
            or (len(m) >= 2 and m[0] == "o" and m[1].isdigit()))


def post(judge: dict, messages: Sequence[dict], *, max_tokens: int = 200,
         temperature: float = 0.0, timeout: int = 60) -> dict:
    """One OpenAI-compatible chat call. Never raises — a dead provider is a
    dropped vote, not a dead panel."""
    payload: Dict[str, object] = {"model": judge["model"],
                                  "messages": list(messages),
                                  "response_format": {"type": "json_object"}}
    if _is_reasoning(judge["model"]):
        payload["max_completion_tokens"] = max_tokens
    else:
        payload["max_tokens"] = max_tokens
        payload["temperature"] = temperature
    req = urllib.request.Request(
        judge["url"].rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + judge["key"]})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
            body = json.loads(r.read().decode("utf-8"))
        content = body["choices"][0]["message"]["content"]
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{judge['id']}: {e}"}
    return {"ok": True, "content": content, "provider": judge["id"],
            "model": judge["model"]}


def _winner(resp: dict) -> Optional[str]:
    if not resp.get("ok"):
        return None
    import re
    content = resp.get("content") or ""
    try:
        data = json.loads(content)
    except Exception:  # noqa: BLE001
        m = re.search(r"\{.*\}", content, re.S)
        if not m:
            return None
        try:
            data = json.loads(m.group(0))
        except Exception:  # noqa: BLE001
            return None
    if not isinstance(data, dict):
        return None
    w = str(data.get("winner", "")).strip().upper()
    return w if w in ("A", "B", "TIE") else None


def collect_votes(judges: Sequence[dict], messages: Sequence[dict], *,
                  post: Callable = post, cache=None, **kw) -> List[dict]:
    """One vote per judge that answers; silent dropouts for those that don't."""
    votes: List[dict] = []
    for judge in judges:
        def call(j=judge):
            return post(j, messages, **kw)
        if cache is not None:
            payload = {"panelVote": 1, "model": judge["model"],
                       "messages": list(messages)}
            resp = cache.cached_call(payload, call)
        else:
            resp = call()
        w = _winner(resp)
        if w is None:
            continue
        votes.append({"judge": judge["id"], "model": judge["model"], "winner": w})
    return votes


def disagreement(votes: Sequence[dict]) -> float:
    """Share of votes NOT with the plurality. 0.0 means the panel is one
    opinion — worth knowing before paying for more judges."""
    if not votes:
        return 0.0
    counts: Dict[str, int] = {}
    for v in votes:
        counts[v["winner"]] = counts.get(v["winner"], 0) + 1
    return 1.0 - max(counts.values()) / len(votes)
