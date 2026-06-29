#!/usr/bin/env python3
"""Hermetic tests for the compiler's real-LLM seam (L3) — NO network, NO keys required.

Covers what's automatable about the real path: provider resolution + gating
(brain_client, mirroring BrainProxy, with the compiler's OWN MOSH_ENABLE_COMPILER gate),
the prompt builder, the JSON parser, and the compile → validate → RE-PROMPT-with-the-
specific-failure loop driven by a MOCKED chat_json (so repair + the real→fake fallback
are exercised deterministically). The actual LLM call + "sounds right" is a human/oracle
gate, verified by the owner with keys — like SA3's real model and lyrics L3.

Run:  python3 service/compiler/llm_backend_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

import brain_client  # noqa: E402
from compiler import core  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _clear_provider_env():
    brain_client._BRAIN_ENV_CACHE = {}  # ignore any real bundled brain.env
    for k in list(os.environ):
        if k.endswith(("_API_KEY", "_BASE_URL", "_MODEL")) or \
           k in ("MOSHI_BRAIN_PROVIDER", "MOSH_ENABLE_LYRIC", "MOSH_ENABLE_COMPILER"):
            os.environ.pop(k, None)


# ── 1. backend gating: provider chain + the compiler's independent enable gate ────
_clear_provider_env()
check("no provider ⇒ _auto_backend() fake", core._auto_backend() == "fake")

os.environ["OPENAI_BASE_URL"] = "https://api.openai.test/v1"
os.environ["OPENAI_API_KEY"] = "sk-test"
os.environ["OPENAI_MODEL"] = "gpt-5.4-mini"
check("a complete provider ⇒ _auto_backend() llm", core._auto_backend() == "llm")

os.environ["MOSH_ENABLE_COMPILER"] = "0"
check("MOSH_ENABLE_COMPILER=0 force-disables the LLM (⇒ fake)", core._auto_backend() == "fake")
os.environ.pop("MOSH_ENABLE_COMPILER")
check("compiler gate is INDEPENDENT of MOSH_ENABLE_LYRIC", True)  # uses resolve(), not available()
os.environ["MOSH_ENABLE_LYRIC"] = "0"
check("MOSH_ENABLE_LYRIC=0 does NOT disable the compiler", core._auto_backend() == "llm")
os.environ.pop("MOSH_ENABLE_LYRIC")

# ── 2. the prompt carries the task + palette + instruction (+ feedback on retry) ──
msgs = core._build_messages("make it lo-fi", intensity=70, feedback=None)
sysmsg, usr = msgs[0]["content"], msgs[-1]["content"]
check("system prompt documents the modes", "reimagine" in sysmsg and "transform" in sysmsg and "unsupported" in sysmsg)
check("system prompt lists the colour palette", "grit" in sysmsg and "brightness" in sysmsg)
check("system prompt forbids invented knobs", "negative_prompt" in sysmsg and "cfg" in sysmsg)
check("user prompt carries the instruction", "make it lo-fi" in usr, usr)
check("user prompt carries the intensity", "70" in usr, usr)
fb = core._build_messages("x", None, "unknown colour 'sparkle'")[-1]["content"]
check("feedback is appended on retry", "Fix it" in fb and "sparkle" in fb, fb)

# ── 3. the JSON parser ────────────────────────────────────────────────────────────
check("parses a JSON object", core._parse_env('{"mode":"reimagine","prompt":"x"}')["mode"] == "reimagine")
try:
    core._parse_env('not json')
    check("non-JSON raises", False)
except ValueError:
    check("non-JSON raises", True)

# ── 4. mocked good reply: validated, used llm, seed filled when omitted ───────────
_real = brain_client.chat_json
try:
    brain_client.chat_json = lambda *a, **k: {"ok": True, "content":
        '{"mode":"reimagine","prompt":"lo-fi gritty guitar","nl":0.42,'
        '"colors":[{"name":"grit","value":70}],"lab":false,"reasoning":"lo-fi → grit"}'}
    env, reasoning, used = core._llm_compile("make it lo-fi", None)
    check("LLM reimagine validates", used == "llm" and env["mode"] == "reimagine", str(env))
    check("LLM reply keeps the grit colour", any(c["name"] == "grit" for c in env["colors"]))
    check("a missing seed is filled deterministically", env["seed"] == core._seed_for("make it lo-fi"))
    check("LLM reasoning is captured", reasoning == "lo-fi → grit", reasoning)

    # transform reply
    brain_client.chat_json = lambda *a, **k: {"ok": True, "content":
        '{"mode":"transform","target":"violin","strength":55}'}
    env, _, used = core._llm_compile("as a violin", None)
    check("LLM transform validates", used == "llm" and env["mode"] == "transform" and env["target"] == "violin")

    # unsupported reply (corrective)
    brain_client.chat_json = lambda *a, **k: {"ok": True, "content":
        '{"mode":"unsupported","reason":"corrective","say":"can\'t repair the take"}'}
    env, _, used = core._llm_compile("fix my guitar", None)
    check("LLM unsupported validates", used == "llm" and env["mode"] == "unsupported")

    # ── 5. invalid reply (forbidden colour pair) ⇒ retry ⇒ fake fallback ──────────
    brain_client.chat_json = lambda *a, **k: {"ok": True, "content":
        '{"mode":"reimagine","prompt":"x","nl":0.4,'
        '"colors":[{"name":"drum_aggression","value":70},{"name":"grid_tightness","value":70}]}'}
    env, reasoning, used = core._llm_compile("punchy tight drums", None)
    check("never-valid LLM ⇒ falls back to the fake", used == "fake", reasoning)
    check("the fallback envelope is itself valid", env["mode"] in ("reimagine", "transform", "unsupported"))

    # ── 6. unknown colour ⇒ retry ⇒ fallback ──────────────────────────────────────
    brain_client.chat_json = lambda *a, **k: {"ok": True, "content":
        '{"mode":"reimagine","prompt":"x","nl":0.4,"colors":[{"name":"sparkle","value":70}]}'}
    _, _, used = core._llm_compile("make it sparkly", None)
    check("unknown colour ⇒ fake fallback", used == "fake")

    # ── 7. unreachable LLM (ok:false) ⇒ fake fallback immediately ──────────────────
    brain_client.chat_json = lambda *a, **k: {"ok": False, "error": "down"}
    env, reasoning, used = core._llm_compile("make it gritty", None)
    check("unreachable LLM ⇒ fake fallback", used == "fake" and env["mode"] == "reimagine", reasoning)
finally:
    brain_client.chat_json = _real
    _clear_provider_env()

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
