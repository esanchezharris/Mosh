#!/usr/bin/env python3
"""Golden tests for the whole-section lyric author (FMS re-sing, stage ③).

The deterministic plumbing is pinned here: the whole-song prompt assembly, the defensive
parse, per-line validation/failure messages, the fake fill path (locked lines preserved,
gaps filled + origin promoted, 3× deterministic), and — with a MOCKED brain_client (no
network) — the LLM path's one-prompt → validate → re-prompt-with-the-specific-miss → merge
loop, plus the real→fake fallback. The whole-song COHERENCE itself is an LLM property gated
by the owner's ear, not asserted here.

Run:  python3 scripts/fms-killshot/section_lyric_test.py     (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import brain_client  # noqa: E402
import section_lyric as sl  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def SHEET():
    """A partial-heavy sheet like the owner's real takes: a sung anchor + a mumble in one
    rhyme group, a partial anchor + a mumble in another."""
    return {
        "grid": "1/16", "rhymeStrictness": "slant",
        "lines": [
            {"index": 0, "rhymeGroup": "A", "origin": "sung",
             "text": "splashing on my jeans like i'm paul", "locked": True, "syllableTarget": 9},
            {"index": 1, "rhymeGroup": "A", "origin": "mumble", "seedText": "", "syllableTarget": 8},
            {"index": 2, "rhymeGroup": "B", "origin": "partial",
             "seedText": "i left ___ everything", "syllableTarget": 7},
            {"index": 3, "rhymeGroup": "B", "origin": "mumble", "seedText": "", "syllableTarget": 7},
        ],
    }


# ── 1. build_section_messages: the WHOLE song in one prompt ─────────────────────────────
msgs = sl.build_section_messages(SHEET())
usr = msgs[1]["content"]
sysm = msgs[0]["content"]
check("locked line shown verbatim as KEEP", '[KEEP · A] "splashing on my jeans like i\'m paul"' in usr, usr[:120])
check("mumble line shown as WRITE with its syllable budget + group", "[WRITE 8 syl · A] ___" in usr, usr)
check("partial line shown as FILL keeping its words", '[FILL 7 syl · B] "i left ___ everything"' in usr, usr)
check("real-words CONTEXT injected (the 'no song context' fix)",
      "splashing on my jeans like i'm paul" in usr and "i left everything" in usr, usr)
check("system asks for ONLY the gap indices as JSON", "[1, 2, 3]" in sysm and '"index"' in sysm, sysm)
check("raw register permitted by default", "don't self-censor" in usr.lower())

msgs_fb = sl.build_section_messages(SHEET(), feedback="line 1 was 10 syllables, need 8")
check("feedback is threaded into the re-prompt", "FIX exactly these: line 1 was 10 syllables" in msgs_fb[1]["content"])


# ── 2. parse_section: defensive across shapes ──────────────────────────────────────────
check("parse {lines:[{index,text}]}",
      sl.parse_section('{"lines":[{"index":1,"text":"a b c"},{"index":3,"text":"d e"}]}') == {1: "a b c", 3: "d e"})
check("parse bare list", sl.parse_section('[{"index":2,"text":"x"}]') == {2: "x"})
check("parse index-keyed object", sl.parse_section('{"1":"hello","3":"world"}') == {1: "hello", 3: "world"})
check("parse garbage → empty, never raises", sl.parse_section("not json at all") == {})
check("parse drops entries without an index", sl.parse_section('{"lines":[{"text":"no index"}]}') == {})


# ── 3. validation + failure messages (phonology-backed, anchor-aware) ──────────────────
sheet = SHEET()
line1 = sheet["lines"][1]                      # mumble, group A, target 8, anchor = "paul"
bad = sl._validate_line("way too many syllables in this run on line here now", line1, sheet, "paul")
check("an over-long line fails the syllable gate", not bad["passes"] and not bad["syllableOk"], str(bad))
check("its failure message names the syllable miss",
      "syllables" in (sl._failure(bad, line1, sheet, "paul") or ""), sl._failure(bad, line1, sheet, "paul"))
good = sl._validate_line("i hit the wall again and fall", line1, sheet, "paul")   # ends 'fall' ~ 'paul'
check("a line that rhymes the anchor + hits the count has no failure",
      sl._failure(good, line1, sheet, "paul") is None or good["rhymeOk"], str(good))


# ── 4. fake path: locked preserved, gaps filled + promoted, deterministic ──────────────
res = sl.author_section(SHEET(), backend="fake")
check("fake backend selected", res["backend"] == "fake")
out = res["sheet"]
check("locked/sung line untouched (verbatim + origin)",
      out["lines"][0]["text"] == "splashing on my jeans like i'm paul"
      and out["lines"][0]["origin"] == "sung" and not out["lines"][0].get("written"))
check("every gap line got text", all((out["lines"][i].get("text") or "").strip() for i in (1, 2, 3)))
check("mumble promoted to generated, partial promoted to mixed",
      out["lines"][1]["origin"] == "generated" and out["lines"][2]["origin"] == "mixed",
      f'{out["lines"][1]["origin"]},{out["lines"][2]["origin"]}')
check("written flags set on the filled gaps", all(out["lines"][i].get("written") for i in (1, 2, 3)))
check("partial keeps the singer's words", "left" in out["lines"][2]["text"].lower()
      and "everything" in out["lines"][2]["text"].lower(), out["lines"][2]["text"])
check("filled mumble hits its syllable target (±1)",
      abs(sl.lyr.syllables(out["lines"][1]["text"]) - 8) <= 1, out["lines"][1]["text"])

digs = {hashlib.sha256(json.dumps(sl.author_section(SHEET(), backend="fake")["sheet"], sort_keys=True).encode()).hexdigest()
        for _ in range(3)}
check("fake author 3× deterministic", len(digs) == 1, str(len(digs)))


# ── 5. LLM path (MOCKED brain_client — no network): validate → re-prompt → merge ───────
_orig_chat, _orig_avail = brain_client.chat_json, brain_client.available
try:
    calls = []

    MSHEET = {
        "grid": "1/16", "rhymeStrictness": "slant",
        "lines": [
            {"index": 0, "rhymeGroup": "A", "origin": "sung",
             "text": "i can see the wall", "locked": True, "syllableTarget": 5},
            {"index": 1, "rhymeGroup": "A", "origin": "mumble", "seedText": "", "syllableTarget": 4},
        ],
    }

    def mock_chat(messages):
        calls.append(messages)
        if len(calls) == 1:
            return {"ok": True, "content": '{"lines": []}'}          # round 1: line 1 MISSING
        return {"ok": True, "content": '{"lines":[{"index":1,"text":"i hit the wall"}]}'}  # round 2: fixed

    brain_client.chat_json = mock_chat
    brain_client.available = lambda: True

    res2 = sl.author_section(MSHEET)          # auto → llm (available True)
    check("LLM path chosen when a brain is available", res2["backend"] == "llm", res2["backend"])
    check("re-prompted after the first reply dropped a line", len(calls) == 2, f"{len(calls)} calls")
    check("the re-prompt carried the SPECIFIC miss (line 1 missing)",
          "line 1 was missing" in calls[1][1]["content"], calls[1][1]["content"][-160:])
    l1 = res2["sheet"]["lines"][1]
    check("the fixed line merged into the sheet", l1.get("text") == "i hit the wall" and l1.get("written"))
    check("its origin promoted", l1["origin"] == "generated")
    check("the locked line stayed verbatim through the LLM path",
          res2["sheet"]["lines"][0]["text"] == "i can see the wall")

    # 5b. real→fake fallback: brain reachable-flag true but every call errors
    calls.clear()
    brain_client.chat_json = lambda m: (calls.append(m), {"ok": False})[1]
    res3 = sl.author_section(MSHEET)
    check("unreachable LLM falls back to the fake backend", res3["backend"] == "fake", res3["backend"])
    check("fallback still fills the gap", bool((res3["sheet"]["lines"][1].get("text") or "").strip()))
finally:
    brain_client.chat_json, brain_client.available = _orig_chat, _orig_avail


if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
