#!/usr/bin/env python3
"""Blindness pin for gen_candidates (spy-chat pattern from bench/runner_test).

The generation prompt must never leak the template's phonemes or any Whisper words —
otherwise the LLM could parrot the take and the rescore separation would be vacuous.

Run:  "$PROBE_PY" scripts/fms-phoneme-probe/gen_candidates_test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gen_candidates as G  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


LINE = {"index": 0, "syllables": 8, "stress": "XxXxXxXx", "span": [0.0, 2.0],
        "segs": ["d", "a", "ʊ", "n"], "vowels": ["a"],
        "phones": [{"ipa": "daʊn", "start": 0, "end": 1, "conf": 0.9}]}

captured = []


def spy_chat(messages):
    captured.append(messages)
    return {"ok": True, "content": '{"lines": ["one two three four five six sev en"]}'}


cands = G.generate_for_line(LINE, "test topic", "moody", spy_chat, cache=None)
check("spy chat called once per variant", len(captured) == G.CALLS)
blob = " ".join(m["content"] for msgs in captured for m in msgs)
check("RED: no IPA leaks into any prompt",
      all(seg not in blob for seg in ("daʊn", "ʊ", "ɪ", "ə")), blob[:120])
check("RED: no phones/segs field content leaks", "segs" not in blob and "ipa" not in blob)
check("syllable target present", "exactly 8 syllables" in blob)
check("stress hint present", "XxXxXxXx" in blob)
check("candidates parsed + deduped", cands == ["one two three four five six sev en"],
      str(cands))
check("parse tolerates junk", G.parse_lines("not json") == [])

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failing")
sys.exit(1 if fails else 0)
