#!/usr/bin/env python3
"""Golden tests for COHERENT verse generation (Finish-My-Song, Stage B0).

The base loop (lyric_gen_test) generates each line INDEPENDENTLY — good for
gap-fill, but a mumbled back half needs a verse that develops a story and
resolves into the chorus. `complete_verse` walks the skeleton in order and
threads the chorus + theme + the running verse-so-far into every line's prompt,
committing the top line as context for the next. This test pins:
  1. _build_messages injects the coherence context (chorus/theme/prior/position)
  2. complete_verse (fake backend) is deterministic and fills every line
  3. complete_verse (MOCKED llm) threads the PRIOR chosen line into the next
     line's prompt — the actual coherence mechanism — and carries chorus+theme

Run:  python3 service/lyrics/verse_gen_test.py     (exit 0 = all pass)
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


CHORUS = "used to fight like invincible but in the night we got hella close"
THEME = "nostalgia and regret over a fallen-off friendship"

# A short back-half verse skeleton: 3 fillable lines, one rhyme group, no fixed anchor.
SPEC = {
    "bpm": 138, "grid": "1/16", "topic": "used2", "mood": "introspective",
    "rhymeStrictness": "slant",
    "lines": [
        {"index": 0, "role": "verse", "seedText": "", "text": "",
         "syllableTarget": 8, "syllableTol": 1, "stress": "", "rhymeGroup": "A", "locked": False},
        {"index": 1, "role": "verse", "seedText": "", "text": "",
         "syllableTarget": 8, "syllableTol": 1, "stress": "", "rhymeGroup": "A", "locked": False},
        {"index": 2, "role": "verse", "seedText": "", "text": "",
         "syllableTarget": 8, "syllableTol": 1, "stress": "", "rhymeGroup": "A", "locked": False},
    ],
}

# ── 1. _build_messages injects coherence context ─────────────────────────────────
ctx = {"chorus": CHORUS, "theme": THEME,
       "priorLines": ["they counted me out but I came back", "now I'm standing on my own two feet"],
       "position": 3, "total": 8}
msgs = core._build_messages(SPEC["lines"][0], SPEC, None, 8, 1, "slant", None, ctx)
usr = msgs[-1]["content"]
check("context prompt carries the chorus", CHORUS in usr)
check("context prompt carries the theme", "nostalgia" in usr)
check("context prompt carries the prior verse lines", "came back" in usr and "two feet" in usr)
check("context prompt carries the line position", "3 of 8" in usr)
check("no-context prompt omits the coherence block (back-compat)",
      CHORUS not in core._build_messages(SPEC["lines"][0], SPEC, None, 8, 1, "slant", None)[-1]["content"])

# ── 2. complete_verse with the fake backend is deterministic + fills every line ──
res_a = core.complete_verse(SPEC, chorus=CHORUS, theme=THEME, backend="fake")
res_b = core.complete_verse(SPEC, chorus=CHORUS, theme=THEME, backend="fake")
check("complete_verse ok", res_a.get("ok") is True)
check("complete_verse fills all 3 lines", len(res_a.get("lines", [])) == 3)
check("every line has a chosen text", all(l.get("chosen") for l in res_a["lines"]))
check("complete_verse is deterministic (fake)", res_a == res_b)
check("chosen lines hit the syllable target (±1)",
      all(abs(core.syllables(l["chosen"]) - 8) <= 1 for l in res_a["lines"]))
check("carries chorus + theme in the result", res_a.get("chorus") == CHORUS and res_a.get("theme") == THEME)

# ── 3. MOCKED llm: the PRIOR chosen line is threaded into the NEXT line's prompt ──
_real_chat = brain_client.chat_json
_calls = []


def _mock_chat(messages, **k):
    _calls.append(messages[-1]["content"])
    # A valid 8-syllable line whose text is stable so we can trace it forward.
    return {"ok": True, "content": '{"lines":["and we lost it over nothing at all"]}'}


try:
    brain_client.chat_json = _mock_chat
    _calls.clear()
    res = core.complete_verse(SPEC, chorus=CHORUS, theme=THEME, backend="llm")
    check("llm verse fills all 3 lines", len(res.get("lines", [])) == 3)
    # The FIRST line's prompt has no prior lines; a LATER prompt must contain the
    # earlier chosen line — that is coherence threading, the whole point.
    first_prompt = _calls[0]
    later_prompt = next((c for c in _calls[1:] if "verse SO FAR" in c or "lost it over nothing" in c), "")
    check("first line's prompt has no 'verse so far' block", "verse SO FAR" not in first_prompt)
    check("a later line's prompt contains the prior chosen line (coherence)",
          "lost it over nothing" in later_prompt)
    check("llm prompts carry the chorus + theme", CHORUS in first_prompt and "nostalgia" in first_prompt)
finally:
    brain_client.chat_json = _real_chat

# ── 4. line-level FLOW grounding: stress + pitch contour + theme hint in the prompt ──
# FlowSpec (lyrics.flowspec) grounds each line in the mumble's real rhythm/melody. The
# prompt must carry that so the brain writes TO the take: land rhymes on the sung high/held
# note, hit the stressed beats, and take the mumbled words as a FEELING cue (not required).
FLOW_LINE = {"index": 0, "role": "verse", "seedText": "", "syllableTarget": 6,
             "syllableTol": 1, "rhymeGroup": "A", "stress": "xXxxXx",
             "pitchContour": "rises contour; highest pitch on syllable 5; held note on syllable 6; 7 semitone range",
             "themeHint": "scars feel like family"}
fusr = core._build_messages(FLOW_LINE, SPEC, None, 6, 1, "slant", None,
                            {"chorus": CHORUS, "theme": THEME, "priorLines": [], "position": 1, "total": 8})[-1]["content"]
check("prompt carries the pitch contour (land the rhyme on the sung high/held note)",
      "highest pitch on syllable 5" in fusr)
check("prompt carries the stress pattern (hit the accented beats)", "xXxxXx" in fusr)
check("prompt frames the mumbled words as a FEELING cue, not required words",
      "scars feel like family" in fusr and ("do not require" in fusr.lower() or "cue" in fusr.lower()))
check("a line WITHOUT flow fields omits the flow block (back-compat)",
      "highest pitch" not in core._build_messages(SPEC["lines"][0], SPEC, None, 8, 1, "slant", None)[-1]["content"])

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
