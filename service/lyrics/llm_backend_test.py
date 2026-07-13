#!/usr/bin/env python3
"""Hermetic tests for the L3 real-LLM seam — NO network, NO keys required.

Covers what's automatable about the real path: provider resolution + gating
(brain_client, mirroring BrainProxy), the prompt builder, the response parser, and the
propose-validate-RETRY loop driven by a MOCKED chat_json (so we exercise repair +
the real→fake fallback deterministically). The actual LLM call + "sounds like me" is a
human taste gate (spec §11), verified by the owner with keys — like SA3's real model.

Run:  python3 service/lyrics/llm_backend_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

import brain_client  # noqa: E402
from lyrics import core  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _clear_provider_env():
    brain_client._BRAIN_ENV_CACHE = {}  # ignore any real bundled brain.env
    for k in list(os.environ):
        if k.endswith(("_API_KEY", "_BASE_URL", "_MODEL")) or k in ("MOSHI_BRAIN_PROVIDER", "MOSH_ENABLE_LYRIC"):
            os.environ.pop(k, None)


# ── 1. Provider resolution mirrors BrainProxy (chain + override) ─────────────────
_clear_provider_env()
check("no provider configured ⇒ resolve() None", brain_client.resolve() is None)
check("no provider configured ⇒ available() False", brain_client.available() is False)

os.environ["OPENAI_BASE_URL"] = "https://api.openai.test/v1"
os.environ["OPENAI_API_KEY"] = "sk-test"
os.environ["OPENAI_MODEL"] = "gpt-5.4-mini"
check("a complete OpenAI provider resolves", (brain_client.resolve() or {}).get("id") == "openai")
check("available() True once a provider is complete", brain_client.available() is True)

os.environ["DEEPSEEK_BASE_URL"] = "https://api.deepseek.test/v1"
os.environ["DEEPSEEK_API_KEY"] = "sk-ds"
os.environ["DEEPSEEK_MODEL"] = "deepseek-chat"
check("deepseek is first in the chain when both are complete", (brain_client.resolve() or {}).get("id") == "deepseek")
os.environ["MOSHI_BRAIN_PROVIDER"] = "openai"
check("MOSHI_BRAIN_PROVIDER overrides the default", (brain_client.resolve() or {}).get("id") == "openai")

os.environ["MOSH_ENABLE_LYRIC"] = "0"
check("MOSH_ENABLE_LYRIC=0 force-disables the real backend", brain_client.available() is False)
check("core._auto_backend() ⇒ 'fake' when disabled", core._auto_backend() == "fake")
os.environ.pop("MOSH_ENABLE_LYRIC")
check("core._auto_backend() ⇒ 'llm' when a provider is configured", core._auto_backend() == "llm")

# ── 2. Reasoning-model token field (mirrors BrainProxy isReasoningModel) ──────────
check("gpt-5.x is a reasoning model", brain_client._is_reasoning("gpt-5.4-mini") is True)
check("o3 is a reasoning model", brain_client._is_reasoning("o3") is True)
check("deepseek-chat is NOT a reasoning model", brain_client._is_reasoning("deepseek-chat") is False)

# ── 3. The prompt carries the constraints (syllables, rhyme anchor, locked words) ─
LINE = {"index": 1, "role": "verse", "seedText": "they counted me out ___ ___",
        "text": "", "syllableTarget": 8, "syllableTol": 1, "rhymeGroup": "A", "locked": False}
SPEC = {"grid": "1/16", "topic": "comeback", "mood": "defiant", "rhymeStrictness": "slant", "lines": [LINE]}
msgs = core._build_messages(LINE, SPEC, anchor="flame", target=8, tol=1, strict="slant", feedback=None)
usr = msgs[-1]["content"]
check("prompt states the syllable target", "8 syllables" in usr or "~8" in usr, usr)
check("prompt requires a slant rhyme with the anchor", "rhyme" in usr and "flame" in usr, usr)
check("prompt lists the locked words", "they" in usr and "counted" in usr, usr)
check("prompt carries the topic", "comeback" in usr, usr)
check("feedback is appended when a prior attempt failed",
      "Fix it" in core._build_messages(LINE, SPEC, "flame", 8, 1, "slant", "too long.")[-1]["content"])
# CRAFT + filler-LIMIT (owner, 2026-07-12): the prompt now teaches HOW to write a bar and
# CAPS filler ("can't be every word in the bar"), instead of blessing fillers.
check("prompt LIMITS filler (at most one per bar, not a meal)",
      ("at most one" in usr.lower() or "one filler" in usr.lower()) and "bar" in usr.lower(), usr)
check("prompt gives punchline / setup-payoff craft guidance",
      "punchline" in usr.lower() or "setup" in usr.lower() or "payoff" in usr.lower(), usr)
check("prompt asks for concrete imagery / wordplay",
      "imagery" in usr.lower() or "concrete" in usr.lower() or "wordplay" in usr.lower(), usr)
check("system prompt is a real lyricist brief, not one line",
      len(core._build_messages(LINE, SPEC, "flame", 8, 1, "slant", None)[0]["content"]) > 200,
      str(len(core._build_messages(LINE, SPEC, "flame", 8, 1, "slant", None)[0]["content"])))

# ── 3b. Register (Bar IQ D): raw is the DEFAULT (de-censored); clean is the opt-in ─
check("default prompt PERMITS an authentic register (slang/explicit, no self-censor)",
      "register" in usr.lower() and "self-censor" in usr.lower(), usr)
clean_usr = core._build_messages(LINE, dict(SPEC, explicit="clean"), "flame", 8, 1, "slant", None)[-1]["content"]
check("explicit=clean prompt says keep it clean (no profanity)", "no profanity" in clean_usr.lower(), clean_usr)
check("default (raw) prompt does NOT say 'keep it clean'", "keep it clean" not in usr.lower())

# ── 4. The response parser handles the JSON shapes + a newline fallback ──────────
check("parses {\"lines\":[...]}", core._parse_lines('{"lines":["a b","c d"]}') == ["a b", "c d"])
check("parses {\"line\":\"...\"}", core._parse_lines('{"line":"one line"}') == ["one line"])
check("parses a bare JSON list", core._parse_lines('["x","y"]') == ["x", "y"])
check("falls back to newlines on non-JSON", core._parse_lines("- first\n- second") == ["first", "second"])
check("drops empty entries", core._parse_lines('{"lines":["ok",""," "]}') == ["ok"])

# ── 5. LLM propose: a mocked good reply validates; an unreachable LLM falls back ──
_real_chat = brain_client.chat_json
try:
    # "they counted me out but I came" — 8 syllables, ends "came" (perfect rhyme w/ flame),
    # keeps the locked words. The phonology validator must accept it.
    brain_client.chat_json = lambda *a, **k: {"ok": True, "content": '{"lines":["they counted me out but I came"]}'}
    props = core._llm_propose_line(LINE, SPEC, anchor="flame", regen=0)
    check("LLM proposal is validated + passes", bool(props) and props[0]["passes"] is True, str(props[:1]))
    check("LLM proposal end word rhymes with the anchor", core.rhymes(props[0]["endWord"], "flame", "slant"))

    # A failing reply triggers a retry; here every reply fails (wrong syllables) so the
    # loop still returns the best-effort candidates (non-empty), never crashes.
    brain_client.chat_json = lambda *a, **k: {"ok": True, "content": '{"lines":["nope"]}'}
    badprops = core._llm_propose_line(LINE, SPEC, anchor="flame", regen=0)
    check("a never-passing LLM still returns best-effort candidates", len(badprops) >= 1)

    # An unreachable LLM (ok:false) ⇒ fall back to the deterministic fake for that line.
    brain_client.chat_json = lambda *a, **k: {"ok": False, "error": "down"}
    fb = core._llm_propose_line(LINE, SPEC, anchor="flame", regen=0)
    check("unreachable LLM ⇒ fake fallback (non-empty, constraint-checked)",
          len(fb) >= 1 and fb[0]["syllableOk"] is True, str(fb[:1]))

    # GROK ROUTING (owner, 2026-07-12): lyrics prefer xAI/Grok (NSFW-tolerant); the spec can
    # override via llmProvider. Capture the requested provider passed to chat_json.
    seen = {}
    brain_client.chat_json = lambda *a, **k: (seen.update(k), {"ok": True, "content": '{"lines":["they counted me out but I came"]}'})[1]
    core._llm_propose_line(LINE, SPEC, anchor="flame", regen=0)
    check("lyrics prefer Grok (requested='xai') by default", seen.get("requested") == "xai", str(seen))
    seen.clear()
    core._llm_propose_line(LINE, dict(SPEC, llmProvider="openai"), anchor="flame", regen=0)
    check("spec.llmProvider overrides the default route", seen.get("requested") == "openai", str(seen))
finally:
    brain_client.chat_json = _real_chat
    _clear_provider_env()

# ── 6. xAI provider reads XAI_* env (bug: it was reading GROK_*) ──────────────────
check("xai provider maps to the XAI_ env prefix (matches C++/vite/.env)",
      ("xai", "XAI") in brain_client._PROVIDERS and ("xai", "GROK") not in brain_client._PROVIDERS,
      str(brain_client._PROVIDERS))

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
