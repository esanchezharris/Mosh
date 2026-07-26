#!/usr/bin/env python3
"""Golden tests for the blind A/B judge panel (FMS lyrics-bench I2).

Hermetic: the chat callable is INJECTED — no network, no keys, no cache dir
outside a tempdir. What must hold:
  - the judge never learns which side is the ground truth (no marker, no order
    tell, no answer key in the prompt);
  - every pair is judged TWICE with the sides swapped, and a judge that just
    picks a POSITION scores 'tie/inconsistent', not a win;
  - a judge with a real preference survives the swap and scores a win;
  - malformed / errored responses degrade to abstain, never to a fabricated win.

Run:  python3 service/lyrics/bench/judge_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import judge, llm_cache  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


ITEM = {
    "itemId": "v1:line:t:s0:l3", "granularity": "line", "songId": "t",
    "artist": "T", "si": 0, "li": 3, "sectionKind": "verse",
    "licenseTier": "train-ok", "views": 10, "maskPolicy": "line-v1", "seed": 7,
    "context": {"before": ["kept the pen on the paper through the winter",
                           "every bar in the notebook was a splinter"],
                "maskedLine": None,
                "after": ["now the story that I'm selling got a wide sole"]},
    "target": {"text": "turned the words in my notebook to a chain of gold",
               "tokenIndex": None, "tokenSpan": None, "phones": None,
               "syllables": 12, "stress": ""},
    "constraints": {"syllables": None, "syllableTol": 1, "rhymeWith": "sole",
                    "rhymeStrictness": "slant", "lineSyllableTarget": 12},
    "split": "dev",
}
CANDIDATE = "flipped the pages of the notebook to a bankroll"


# ---- blindness ----
SEEN = []


def spy(messages, **kw):
    SEEN.append(json.dumps(messages))
    return {"ok": True, "provider": "fake", "model": "spy",
            "content": json.dumps({"winner": "A", "why": "x"})}


with tempfile.TemporaryDirectory() as td:
    res = judge.judge_pair(ITEM, CANDIDATE, chat=spy,
                           cache=llm_cache.Cache(td), lenses=judge.LENSES)
    blob = "\n".join(SEEN)
    check("panel issues 2 calls per lens (order-swapped)",
          len(SEEN) == 2 * len(judge.LENSES), f"{len(SEEN)} calls")
    check("prompt never labels which side is the original/truth",
          not any(w in blob.lower() for w in ("ground truth", "the original line",
                                              "truth:", "human-written", "real lyric")),
          blob[:160])
    check("prompt shows both completions", CANDIDATE in blob
          and ITEM["target"]["text"] in blob)
    check("prompt carries the surrounding context",
          ITEM["context"]["before"][0] in blob)
    check("both orders actually appear across the calls",
          any(s.index(CANDIDATE) < s.index(ITEM["target"]["text"]) for s in SEEN)
          and any(s.index(ITEM["target"]["text"]) < s.index(CANDIDATE) for s in SEEN))
    check("verdict shape carries per-lens columns",
          set(res["byLens"]) == set(judge.LENSES) and "win" in res,
          str(sorted(res.get("byLens", {}))))


# ---- position bias: a judge that always answers 'A' must NOT score a win ----
def always_a(messages, **kw):
    return {"ok": True, "provider": "fake", "model": "posbias",
            "content": json.dumps({"winner": "A", "why": "always first"})}


with tempfile.TemporaryDirectory() as td:
    r = judge.judge_pair(ITEM, CANDIDATE, chat=always_a, cache=llm_cache.Cache(td),
                         lenses=judge.LENSES)
    check("position-biased judge scores tie (inconsistent under swap), not a win",
          r["win"] is None and all(v["verdict"] == "inconsistent"
                                   for v in r["byLens"].values()),
          str(r))


# ---- a real preference survives the swap ----
def prefers_candidate(messages, **kw):
    text = json.dumps(messages)
    # Which labelled side holds the candidate this time?
    a_pos, b_pos = text.index("Fill A:"), text.index("Fill B:")
    a_blob, b_blob = text[a_pos:b_pos], text[b_pos:]
    winner = "A" if CANDIDATE[:18] in a_blob else "B"
    return {"ok": True, "provider": "fake", "model": "pref",
            "content": json.dumps({"winner": winner, "why": "prefers candidate"})}


with tempfile.TemporaryDirectory() as td:
    r = judge.judge_pair(ITEM, CANDIDATE, chat=prefers_candidate,
                         cache=llm_cache.Cache(td), lenses=judge.LENSES)
    check("consistent preference for the candidate scores win=1",
          r["win"] == 1 and all(v["verdict"] == "candidate"
                                for v in r["byLens"].values()), str(r))


def prefers_truth(messages, **kw):
    text = json.dumps(messages)
    a_pos, b_pos = text.index("Fill A:"), text.index("Fill B:")
    a_blob = text[a_pos:b_pos]
    winner = "A" if ITEM["target"]["text"][:18] in a_blob else "B"
    return {"ok": True, "provider": "fake", "model": "pref",
            "content": json.dumps({"winner": winner, "why": "prefers truth"})}


with tempfile.TemporaryDirectory() as td:
    r = judge.judge_pair(ITEM, CANDIDATE, chat=prefers_truth,
                         cache=llm_cache.Cache(td), lenses=judge.LENSES)
    check("consistent preference for the truth scores win=0", r["win"] == 0, str(r))

# ---- degradation: errors and junk abstain, never fabricate ----
with tempfile.TemporaryDirectory() as td:
    r = judge.judge_pair(ITEM, CANDIDATE,
                         chat=lambda m, **kw: {"ok": False, "error": "boom"},
                         cache=llm_cache.Cache(td), lenses=judge.LENSES)
    check("provider error → abstain (win None, verdicts 'abstain')",
          r["win"] is None and all(v["verdict"] == "abstain"
                                   for v in r["byLens"].values()), str(r))
with tempfile.TemporaryDirectory() as td:
    r = judge.judge_pair(ITEM, CANDIDATE,
                         chat=lambda m, **kw: {"ok": True, "content": "not json"},
                         cache=llm_cache.Cache(td), lenses=judge.LENSES)
    check("unparseable content → abstain", r["win"] is None)
with tempfile.TemporaryDirectory() as td:
    r = judge.judge_pair(ITEM, CANDIDATE,
                         chat=lambda m, **kw: {"ok": True, "content": json.dumps(
                             {"winner": "C"})},
                         cache=llm_cache.Cache(td), lenses=judge.LENSES)
    check("out-of-range winner label → abstain", r["win"] is None)

# ---- explicit tie is a tie, not a coin flip ----
with tempfile.TemporaryDirectory() as td:
    r = judge.judge_pair(ITEM, CANDIDATE,
                         chat=lambda m, **kw: {"ok": True, "content": json.dumps(
                             {"winner": "tie"})},
                         cache=llm_cache.Cache(td), lenses=judge.LENSES)
    check("explicit tie → win None with verdict 'tie'",
          r["win"] is None and all(v["verdict"] == "tie"
                                   for v in r["byLens"].values()), str(r))

# ---- majority across lenses ----
check("majority: 2 candidate / 1 truth → win",
      judge._majority({"a": {"verdict": "candidate"}, "b": {"verdict": "candidate"},
                       "c": {"verdict": "truth"}}) == 1)
check("majority: 1 candidate / 2 truth → loss",
      judge._majority({"a": {"verdict": "candidate"}, "b": {"verdict": "truth"},
                       "c": {"verdict": "truth"}}) == 0)
check("majority: split with abstains → None",
      judge._majority({"a": {"verdict": "candidate"}, "b": {"verdict": "truth"},
                       "c": {"verdict": "abstain"}}) is None)

# ---- caching: a second identical panel makes zero new calls ----
CALLS = {"n": 0}


def counting(messages, **kw):
    CALLS["n"] += 1
    return {"ok": True, "content": json.dumps({"winner": "A"})}


with tempfile.TemporaryDirectory() as td:
    cache = llm_cache.Cache(td)
    judge.judge_pair(ITEM, CANDIDATE, chat=counting, cache=cache, lenses=judge.LENSES)
    first = CALLS["n"]
    judge.judge_pair(ITEM, CANDIDATE, chat=counting, cache=cache, lenses=judge.LENSES)
    check("cache: replayed panel makes no new provider calls",
          CALLS["n"] == first and first > 0, f"{CALLS['n']} vs {first}")

# ---- determinism ----
with tempfile.TemporaryDirectory() as td:
    runs = [judge.judge_pair(ITEM, CANDIDATE, chat=prefers_candidate,
                             cache=llm_cache.Cache(td), lenses=judge.LENSES)
            for _ in range(3)]
    check("determinism: 3x identical verdicts", runs[0] == runs[1] == runs[2])

# ---- multi-MODEL panel path (replaces 3 lenses on one model) ------------------
JUDGES = [{"id": "a", "model": "m-a", "url": "u", "key": "k"},
          {"id": "b", "model": "m-b", "url": "u", "key": "k"},
          {"id": "c", "model": "m-c", "url": "u", "key": "k"}]
SEEN2 = []


def panel_post(judge, messages, **kw):
    SEEN2.append((judge["id"], json.dumps(messages)))
    text = json.dumps(messages)
    a_blob = text[text.index("Fill A:"):text.index("Fill B:")]
    cand_is_a = CANDIDATE[:18] in a_blob
    # judge 'c' dissents; a and b prefer the candidate
    prefers_cand = judge["id"] != "c"
    winner = "A" if (cand_is_a == prefers_cand) else "B"
    return {"ok": True, "content": json.dumps({"winner": winner}),
            "provider": judge["id"], "model": judge["model"]}


with tempfile.TemporaryDirectory() as td:
    r = judge.judge_pair_panel(ITEM, CANDIDATE, judges=JUDGES,
                               cache=llm_cache.Cache(td), post=panel_post)
    check("panel asks every model, both orders", len(SEEN2) == 6, str(len(SEEN2)))
    check("majority of MODELS decides the verdict", r["win"] == 1, str(r))
    check("per-model verdicts are kept for calibration",
          set(r["byJudge"]) == {"a", "b", "c"}
          and r["byJudge"]["c"]["verdict"] == "truth", str(r.get("byJudge")))
    check("panel disagreement is recorded", abs(r["disagreement"] - 1 / 3) < 1e-9,
          str(r.get("disagreement")))
    check("no model sees the answer key",
          all("truthText" not in m and "ground truth" not in m.lower()
              for _, m in SEEN2))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
