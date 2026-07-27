#!/usr/bin/env python3
"""Golden tests for the multi-MODEL judge panel (FMS lyrics-bench I2b).

Measured problem: the "panel" was one model (gpt-5.4-mini) asked three ways.
The lenses agreed 91-98% of the time and the third changed the verdict on 1 of
39 items — three times the API cost for one opinion. A panel means different
MODELS, so this resolves judges from whatever provider credentials exist and
records which model produced each vote.

Hermetic: every provider call is injected. No network, no keys, no bench data.

Run:  python3 service/lyrics/bench/panel_test.py     (exit 0 = all pass)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import panel  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


ENV_ONLY_OPENAI = {"OPENAI_API_KEY": "k", "OPENAI_BASE_URL": "https://o",
                   "OPENAI_MODEL": "gpt-x"}
ENV_PLUS_XAI = {**ENV_ONLY_OPENAI, "XAI_API_KEY": "k2",
                "XAI_BASE_URL": "https://x", "XAI_MODEL": "grok-y"}
ENV_ROUTER = {**ENV_ONLY_OPENAI, "OPENROUTER_KEY": "k3"}

single = panel.resolve_judges(ENV_ONLY_OPENAI)
check("one provider → exactly one judge (no fake diversity)",
      len(single) == 1 and single[0]["id"] == "openai", str(single))

# XAI_* is what the owner actually has; brain_client only reads GROK_* — the
# bench accepts either rather than leaving a working provider unused.
two = panel.resolve_judges(ENV_PLUS_XAI)
check("XAI_* credentials are honored (brain_client's GROK_* alias)",
      {j["id"] for j in two} == {"openai", "xai"}, str([j["id"] for j in two]))
check("GROK_* naming still works",
      {j["id"] for j in panel.resolve_judges(
          {**ENV_ONLY_OPENAI, "GROK_API_KEY": "k", "GROK_BASE_URL": "https://g",
           "GROK_MODEL": "grok-z"})} == {"openai", "xai"})

router = panel.resolve_judges(ENV_ROUTER)
router_models = [j["model"] for j in router if j["id"].startswith("openrouter")]
check("OpenRouter expands into several DIFFERENT model families",
      len(router_models) >= 3 and len({m.split("/")[0] for m in router_models}) >= 3,
      str(router_models))
check("judges are deduped and ordered deterministically",
      panel.resolve_judges(ENV_ROUTER) == router)
check("no credentials → no judges, not a crash", panel.resolve_judges({}) == [])

# ---- voting ----
CALLS = []


def fake_post(judge, messages, **kw):
    CALLS.append(judge["id"])
    # deepseek-ish judge dissents; the others pick A
    winner = "B" if "deepseek" in judge["model"] else "A"
    return {"ok": True, "content": json.dumps({"winner": winner}),
            "provider": judge["id"], "model": judge["model"]}


judges = [{"id": "openai", "model": "gpt-x", "url": "u", "key": "k"},
          {"id": "openrouter:a", "model": "deepseek/chat", "url": "u", "key": "k"},
          {"id": "openrouter:b", "model": "google/gemini", "url": "u", "key": "k"}]
votes = panel.collect_votes(judges, [{"role": "user", "content": "x"}],
                            post=fake_post)
check("one vote per judge", len(votes) == 3 and len(CALLS) == 3)
check("each vote records the model that cast it",
      {v["model"] for v in votes} == {"gpt-x", "deepseek/chat", "google/gemini"})
check("dissent is preserved, not averaged away",
      sorted(v["winner"] for v in votes) == ["A", "A", "B"],
      str([v["winner"] for v in votes]))
check("panel disagreement is reported as a first-class number",
      abs(panel.disagreement(votes) - 1 / 3) < 1e-9, str(panel.disagreement(votes)))
check("unanimous panel reports zero disagreement — the signal that it is "
      "one opinion wearing hats",
      panel.disagreement([{"winner": "A"}, {"winner": "A"}]) == 0.0)


def flaky_post(judge, messages, **kw):
    if judge["id"] == "openai":
        return {"ok": False, "error": "429"}
    return {"ok": True, "content": json.dumps({"winner": "A"}),
            "provider": judge["id"], "model": judge["model"]}


partial = panel.collect_votes(judges, [{"role": "user", "content": "x"}],
                              post=flaky_post)
check("a failing provider drops out without killing the panel",
      len(partial) == 2 and all(v["winner"] == "A" for v in partial), str(partial))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
