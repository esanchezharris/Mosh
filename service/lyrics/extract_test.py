#!/usr/bin/env python3
"""Golden tests for lyric EXTRACTION from mumble takes (FMS pipeline correction).

Fixtures are TRIMMED REAL whisper output from the owner's cached takes
(~/mosh-fms-ksb/*-words.json, generous decode, model `small`) — committed inline so the
test is hermetic. They encode the proof that confidence alone cannot gate extraction:
filler "da" @ 0.41, real "bomb" @ 0.13, hallucinated "strawberry" @ 1.3e-5.

Tier 2 (LLM judge) is exercised against a MOCKED brain_client: the honesty wall must
reject any judge reply that references words ASR never heard.

Run:  python3 service/lyrics/extract_test.py     (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from lyrics import extract as ex  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def W(word, start, end, conf, syl=1):
    return {"word": word, "start": start, "end": end, "confidence": conf, "syl": syl}


# Trimmed REAL fixtures (owner's takes; whisper `small`, generous decode).
POPPIN = [W("I", 0.00, 0.64, 0.142), W("got", 0.64, 1.64, 0.423), W("bomb", 1.64, 2.04, 0.131),
          W("and", 2.04, 2.52, 0.263), W("young", 2.52, 3.14, 0.132),
          W("Put", 3.14, 4.58, 0.583), W("some", 4.58, 4.80, 0.446), W("on", 4.80, 5.20, 0.712),
          W("just", 5.20, 5.46, 0.673), W("to", 5.46, 5.68, 0.506), W("sing", 5.68, 5.96, 0.806),
          W("a", 5.96, 6.22, 0.536), W("song", 6.22, 6.80, 0.998)]
LALA = [W("da", 0.35, 0.55, 0.006), W("da", 0.81, 1.05, 0.410),
        W("strawberry", 1.30, 3.90, 0.000013, syl=3)]
PELLA = [W("I'm", 0.10, 0.31, 0.691), W("going", 0.31, 0.74, 0.845, syl=2),
         W("down,", 0.74, 1.20, 0.965), W("down,", 1.20, 1.66, 0.990),
         W("down,", 1.66, 2.12, 0.994), W("but", 2.30, 2.51, 0.345),
         W("I'm", 2.51, 2.70, 0.977), W("gonna", 2.70, 3.02, 0.717, syl=2),
         W("get", 3.02, 3.21, 0.918), W("up", 3.21, 3.44, 0.902)]

# ── 1. Filler + credibility primitives ──────────────────────────────────────────────────
check("filler: la/da/mmm/aaaa yes; flame no",
      all(ex.is_filler(w) for w in ("la", "da", "mmm", "aaaa", "ooh"))
      and not ex.is_filler("flame"))
check("filler 'da' @ 0.41 NOT credible (confidence alone would keep it)",
      not ex.credible(W("da", 0, 1, 0.410)))
check("hallucinated 'strawberry' @ 1.3e-5 NOT credible (absolute floor)",
      not ex.credible(W("strawberry", 0, 1, 0.000013, syl=3)))
check("'song' @ 0.998 credible; 'going' @ 0.845 (2 syl) credible",
      ex.credible(W("song", 0, 1, 0.998)) and ex.credible(W("going", 0, 1, 0.845, syl=2)))
check("'bomb' @ 0.13 (1 syl) not credible ALONE (its phrase decides)",
      not ex.credible(W("bomb", 0, 1, 0.131)))

# ── 2. Phrase grouping + tier-1 classification on the real fixtures ────────────────────
phr = ex.group_phrases(POPPIN)
check("poppinshit groups into contiguous phrases", len(phr) == 1, str(len(phr)))
check("pella head phrase classifies REAL (his finished lyric)",
      ex.classify_phrase(PELLA, []) == "real")
check("lala phrase classifies MUMBLE (filler + hallucination)",
      ex.classify_phrase(LALA, []) == "mumble")
check("poppinshit mixed phrase classifies PARTIAL (anchors, never discarded)",
      ex.classify_phrase(POPPIN, []) == "partial")

# ── 3. Melisma guard: a credible word spanning many articulations demotes real→partial ─
groups_dense = [{"start": 0.1 * i, "end": 0.1 * i + 0.09} for i in range(30)]
held = [W("going", 0.0, 1.2, 0.9, syl=2), W("down", 1.3, 1.5, 0.95), W("tonight", 1.5, 1.9, 0.9, syl=2)]
check("melisma-suspect word demotes its phrase real->partial",
      ex.classify_phrase(held, groups_dense) == "partial")
check("same phrase without dense groups is real", ex.classify_phrase(held, []) == "real")

# ── 4. extract() end-to-end (tier 1 only — hermetic) ───────────────────────────────────
# 120bpm 4/4 -> 2s bars. bar0 = real covered line; bar1 = partial; bar2 = mumble.
def G(a, b):
    return {"start": a, "end": b, "velocity": 90,
            "segments": [{"start": a, "end": b, "pitch": 57}]}

GROUPS = [G(0.1, 0.5), G(0.6, 1.0), G(1.1, 1.5),          # bar 0: 3 slots
          G(2.2, 2.6), G(2.8, 3.2), G(3.4, 3.8),          # bar 1: 3 slots
          G(4.3, 4.7), G(4.9, 5.3)]                        # bar 2: 2 slots
WORDS = [W("hold", 0.10, 0.45, 0.9), W("the", 0.60, 0.95, 0.88), W("flame", 1.10, 1.50, 0.95),
         W("cold", 2.20, 2.60, 0.91), W("da", 2.80, 3.10, 0.40),
         W("la", 4.30, 4.60, 0.30), W("mmm", 4.90, 5.20, 0.20)]
r = ex.extract(WORDS, GROUPS, bpm=120.0, use_llm=False)
check("bar0: all-real + covers slots -> verbatim sung line",
      r["line_text"][0] == "hold the flame" and r["line_origin"][0] == "sung",
      str((r["line_text"].get(0), r["line_origin"].get(0))))
check("bar1: real word among filler -> partial (anchor, no verbatim text)",
      r["line_text"][1] is None and r["line_origin"][1] == "partial",
      str(r["line_origin"].get(1)))
check("bar2: pure filler -> mumble (None/None — today's wordless behavior)",
      r["line_text"][2] is None and r["line_origin"][2] is None)
check("kept words = the 4 real ones (fillers never anchor)",
      sorted(w["word"] for w in r["kept"]) == ["cold", "flame", "hold", "the"],
      str([w["word"] for w in r["kept"]]))
check("heard blobs keep EVERYTHING incl. rejected fillers, with slot hints",
      len(r["line_heard"][2]["words"]) == 2 and r["line_heard"][0]["words"][0]["slot"] == 0,
      str(r["line_heard"].get(2)))
check("stats honest", r["stats"]["sung_lines"] == 1 and r["stats"]["partial_lines"] == 1
      and r["stats"]["kept"] == 4, str(r["stats"]))

# words beyond the last surviving bar are counted, never silently dropped
r2 = ex.extract(WORDS + [W("ghost", 99.0, 99.4, 0.9)], GROUPS, bpm=120.0, use_llm=False)
check("word past the last bar -> dropped_after_max_bars", r2["stats"]["dropped_after_max_bars"] == 1,
      str(r2["stats"]))

# ── 5. Tier-2 honesty wall (mocked brain_client) ────────────────────────────────────────
def _mock_brain(reply: dict):
    m = types.ModuleType("brain_client")
    m.available = lambda: True
    m.chat_json = lambda messages, requested="", max_tokens=800, timeout=60: {
        "ok": True, "content": json.dumps(reply)}
    return m

# valid promotion: the judge may re-label poppinshit partial -> real (it reads true)
sys.modules["brain_client"] = _mock_brain(
    {"phrases": [{"i": 0, "label": "real", "keep": list(range(len(POPPIN)))}]})
rp = ex.extract(POPPIN, [G(0.0 + 0.5 * i, 0.3 + 0.5 * i) for i in range(13)], bpm=30.0,
                use_llm=True)
check("tier-2 judge can PROMOTE a sensible phrase to real (owner's 'reason over it')",
      rp["stats"]["tier"] == "t2" and rp["stats"]["sung_lines"] >= 1, str(rp["stats"]))

# honesty wall: keep index outside the heard words -> judge output REJECTED entirely
sys.modules["brain_client"] = _mock_brain(
    {"phrases": [{"i": 0, "label": "real", "keep": [0, 99]}]})
rw = ex.extract(POPPIN, [G(0.0 + 0.5 * i, 0.3 + 0.5 * i) for i in range(13)], bpm=30.0,
                use_llm=True)
check("honesty wall: out-of-range keep index -> tier-1 verbatim fallback",
      rw["stats"]["tier"] == "t1", str(rw["stats"]["tier"]))

# malformed label -> rejected too
sys.modules["brain_client"] = _mock_brain({"phrases": [{"i": 0, "label": "improved", "keep": []}]})
rm = ex.extract(POPPIN, [G(0.0, 0.3)], bpm=30.0, use_llm=True)
check("honesty wall: unknown label -> tier-1 fallback", rm["stats"]["tier"] == "t1")
sys.modules.pop("brain_client", None)

# ── 6. 3x determinism (tier 1) ──────────────────────────────────────────────────────────
digs = {hashlib.sha256(json.dumps(ex.extract(WORDS, GROUPS, bpm=120.0, use_llm=False),
                                  sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("3x deterministic", len(digs) == 1)

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
