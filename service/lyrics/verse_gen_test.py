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

# ── 5. FLOW ENFORCEMENT (writer v2): breaks HARD-GATE, stress + echo SCORE terms ──────
# Root cause of "doesn't sound good yet": stress/boundaries were prompt-only hints the LLM
# ignored. Now they're validated like syllables: a word spanning a real breath FAILS with a
# specific re-prompt; stress alignment and vowel-echo rank otherwise-valid candidates.
FLOW_B = {"index": 0, "role": "verse", "seedText": "", "text": "", "syllableTarget": 4,
          "syllableTol": 0, "rhymeGroup": "", "locked": False,
          "breaks": [1],   # a word must END at syllable 2 (0-based index 1)
          "echoTargets": [{"pos": 3, "word": "flame", "conf": 0.4, "vowels": ["EY"]}]}

ok_cand = core._evaluate("sunset in rain", FLOW_B, SPEC, None, 4, 0, "slant")
bad_cand = core._evaluate("amazing rain", FLOW_B, SPEC, None, 4, 0, "slant")
check("word ending AT the breath passes", ok_cand["passes"] and ok_cand.get("breaksOk") is True, str(ok_cand))
check("word SPANNING the breath hard-fails", (not bad_cand["passes"]) and bad_cand.get("breaksOk") is False, str(bad_cand))
reason = core._failure_reason(bad_cand, 4, 0, None, "slant")
check("failure reason names the offending word + the breath",
      "amazing" in reason and "syllable 2" in reason, reason)

# echo term: identical candidates except the echo position — EY-echo beats OW
echo_hi = core._evaluate("sunset in rain", FLOW_B, SPEC, None, 4, 0, "slant")   # rain = EY
echo_lo = core._evaluate("sunset in gold", FLOW_B, SPEC, None, 4, 0, "slant")   # gold = OW
check("echoing the demoted word's vowels outranks ignoring it",
      echo_hi["score"] > echo_lo["score"], f"{echo_hi['score']} vs {echo_lo['score']}")

# stress term (no echo, isolate): line accents X at syllables 1 and 3
FLOW_S = {**FLOW_B, "echoTargets": [], "stress": "XxXx"}
st_hi = core._evaluate("sunset midnight", FLOW_S, SPEC, None, 4, 0, "slant")   # Xx Xx
st_lo = core._evaluate("sunset again", FLOW_S, SPEC, None, 4, 0, "slant")      # Xx xX
check("accent-matching candidate outranks the mismatch",
      st_hi["score"] > st_lo["score"], f"{st_hi['score']} vs {st_lo['score']}")

# prompt carries the enforcement context
fmsgs = core._build_messages(FLOW_B, SPEC, None, 4, 0, "slant", None)[-1]["content"]
check("prompt states the breath point", "syllable 2" in fmsgs, fmsgs[-300:])
check("prompt forbids the low-trust word but demands its SOUND",
      'do NOT use "flame"' in fmsgs and "EY" in fmsgs)

# the fake floor stays valid: every fake proposal respects the breaks
fake = core._fake_propose_line({**FLOW_B, "echoTargets": []}, SPEC, None, 0)
check("fake proposals all pass the break gate", all(c.get("breaksOk", True) for c in fake),
      str([(c['text'], c.get('breaksOk')) for c in fake]))

# back-compat: a line WITHOUT flow fields keeps today's semantics
plain = core._evaluate("they counted me out alone", SPEC["lines"][0], SPEC, None, 8, 1, "slant")
check("no-flow line unaffected (breaksOk defaults true)", plain.get("breaksOk", True) is True)

# ── 6. MOUTH ENFORCEMENT (mouth round, 2026-07-12): echo the take's heard sounds ──────
# Owner verdict on the writer round: timing/notes land but "the mouth sounds and mouth
# shapes are just way off". Every heard word's sounds (flowspec `mouthTargets`) now
# CONSTRAIN the writer: a line that ignores the take's vowel sequence hard-fails with a
# specific re-prompt; the mouth term dominates ranking. Floor calibrated on real data:
# sound-alikes score 0.72+, unrelated lines <=0.48, candidate A's old lines averaged 0.36.
from lyrics import soundmatch as _sm  # noqa: E402

MOUTH_TGTS = [{**s, "word": "heard", "conf": 0.3} for s in _sm.text_sounds("top of a cup of water")]
MOUTH_LINE = {"index": 0, "role": "verse", "seedText": "", "text": "", "syllableTarget": 8,
              "syllableTol": 0, "rhymeGroup": "", "locked": False, "breaks": [],
              "echoTargets": [], "mouthTargets": MOUTH_TGTS,
              "mouthText": "top of a cup of water"}

m_ok = core._evaluate("not a lot of stuff to squander", MOUTH_LINE, SPEC, None, 8, 0, "slant")
m_bad = core._evaluate("we remain easy tonight please", MOUTH_LINE, SPEC, None, 8, 0, "slant")
check("sound-alike line passes the mouth gate", m_ok["passes"] and m_ok.get("mouthOk") is True,
      str({k: m_ok.get(k) for k in ("passes", "mouthOk", "mouthSim")}))
check("mouth-blind line HARD-FAILS", (not m_bad["passes"]) and m_bad.get("mouthOk") is False,
      str({k: m_bad.get(k) for k in ("passes", "mouthOk", "mouthSim")}))
check("mouthSim is reported and ordered", m_ok["mouthSim"] > 0.6 > m_bad["mouthSim"],
      f"{m_ok['mouthSim']} vs {m_bad['mouthSim']}")
check("mouth term dominates ranking", m_ok["score"] > m_bad["score"])
m_reason = core._failure_reason(m_bad, 8, 0, None, "slant")
check("failure reason carries the heard sounds to the re-prompt",
      "top of a cup of water" in m_reason and "sound" in m_reason.lower(), m_reason)

# prompt: the sound sketch is a constraint, but junk words must not be quoted verbatim
m_usr = core._build_messages(MOUTH_LINE, SPEC, None, 8, 0, "slant", None)[-1]["content"]
check("prompt carries the mouth sketch", "top of a cup of water" in m_usr, m_usr[-260:])
check("prompt frames the sketch as sounds, not required words",
      "not required words" in m_usr.lower() or "misheard" in m_usr.lower(), m_usr[-260:])

# short evidence (<4 sounds) scores but does NOT gate
SHORT_LINE = {**MOUTH_LINE, "mouthTargets": MOUTH_TGTS[:3], "mouthText": "top of a"}
m_short = core._evaluate("we remain easy tonight please", SHORT_LINE, SPEC, None, 8, 0, "slant")
check("short mouth evidence never hard-gates", m_short.get("mouthOk") is True and m_short["passes"],
      str({k: m_short.get(k) for k in ("passes", "mouthOk", "mouthSim")}))

# back-compat: a plain line (no mouth fields) carries no mouth keys and is unaffected
m_plain = core._evaluate("they counted me out alone", SPEC["lines"][0], SPEC, None, 8, 1, "slant")
check("no-mouth line unaffected (no mouth keys)", "mouthSim" not in m_plain and "mouthOk" not in m_plain)

# coverage arming (review fix): 4 targets against a 12-syllable line is too little
# evidence to HARD-gate — it scores, but cannot reject (Whisper under-hears soft takes).
UNDER_LINE = {**MOUTH_LINE, "syllableTarget": 12,
              "mouthTargets": [{**s, "word": "heard", "conf": 0.3} for s in _sm.text_sounds("top of a cup")],
              "mouthText": "top of a cup"}
m_under = core._evaluate("the moon is high and every star reminds me now", UNDER_LINE, SPEC, None, 12, 0, "slant")
check("under-heard line scores but never hard-gates", m_under.get("mouthOk") is True,
      str({k: m_under.get(k) for k in ("mouthOk", "mouthSim")}))

# generic evidence: an all-schwa movie (the neutral mouth) scores but must never reject
GENERIC_LINE = {**MOUTH_LINE, "syllableTarget": 4,
                "mouthTargets": [{**s, "word": "heard", "conf": 0.3} for s in _sm.text_sounds("of a the up")],
                "mouthText": "of a the up"}
m_gen = core._evaluate("time flies moonlight", GENERIC_LINE, SPEC, None, 4, 0, "slant")
check("all-schwa evidence never hard-gates", m_gen.get("mouthOk") is True,
      str({k: m_gen.get(k) for k in ("mouthOk", "mouthSim")}))

# fixed-end enforcement (review fix): a locked trailing seed word must actually END the
# line — containment alone exempted the dangling-ending gate entirely.
FIX_LINE = {"index": 0, "role": "verse", "seedText": "___ ___ ___ flame", "text": "",
            "syllableTarget": 5, "syllableTol": 0, "rhymeGroup": "", "locked": False,
            "breaks": [], "echoTargets": [], "mouthTargets": [], "mouthText": ""}
f_ok = core._evaluate("cup of water flame", FIX_LINE, SPEC, None, 5, 0, "slant")
f_bad = core._evaluate("flame of the water shot", FIX_LINE, SPEC, None, 5, 0, "slant")
check("line actually ending on the locked word passes", f_ok["passes"] and f_ok.get("endOk") is True,
      str({k: f_ok.get(k) for k in ("passes", "endOk", "endWord")}))
check("line merely CONTAINING the locked end word fails the end gate",
      (not f_bad["passes"]) and f_bad.get("endOk") is False,
      str({k: f_bad.get(k) for k in ("passes", "endOk", "endWord")}))
check("failure reason names the required end word",
      "flame" in core._failure_reason(f_bad, 5, 0, None, "slant"),
      core._failure_reason(f_bad, 5, 0, None, "slant"))

# the fake floor still returns ranked proposals on a mouth line (deterministic, no crash)
m_fake_a = core._fake_propose_line(MOUTH_LINE, SPEC, None, 0)
m_fake_b = core._fake_propose_line(MOUTH_LINE, SPEC, None, 0)
check("fake backend still proposes on mouth lines (deterministic)",
      len(m_fake_a) >= 1 and m_fake_a == m_fake_b)

# ── 7. flow-grounded lines must not END on a dangling function word ────────────────────
# Exact-count trimming produced "Cruel, are you? I was a" — an unfinished mouth. A
# flow-grounded line ending on a bare article/preposition/conjunction hard-fails with a
# specific re-prompt. Plain (non-flow) lines keep today's semantics.
d_bad = core._evaluate("not a lot of stuff in the", MOUTH_LINE, SPEC, None, 7, 0, "slant")
check("dangling function-word ending hard-fails", (not d_bad["passes"]) and d_bad.get("endOk") is False,
      str({k: d_bad.get(k) for k in ("passes", "endOk")}))
d_reason = core._failure_reason(d_bad, 7, 0, None, "slant")
check("failure reason names the dangling ending", "the" in d_reason and "end" in d_reason.lower(), d_reason)
d_ok = core._evaluate("not a lot of stuff to squander", MOUTH_LINE, SPEC, None, 8, 0, "slant")
check("content-word ending passes the end gate", d_ok.get("endOk") is True)
d_plain = core._evaluate("they counted me out into the", SPEC["lines"][0], SPEC, None, 7, 1, "slant")
check("plain line keeps today's semantics (no end gate)", "endOk" not in d_plain)

# ── 8. STRICT COUNT (strict round, 2026-07-12): tol 0 means tol 0 ─────────────────────
# The bug: `int(line.get("syllableTol", 1) or 1)` — `0 or 1` is 1, so the syllable-EXACT
# discipline silently ran at ±1 and 8/17 (M1) / 13/17 (M2) shipped lines were off-count;
# the score author then stretches/crams words to fit. Owner policy: EXACT or a
# deterministic filler line (never off-count) marked fallback:"filler" for re-rolling.
check("tol resolution honors an explicit 0", core._syl_tol({"syllableTol": 0}) == 0)
check("tol resolution defaults a MISSING field to 1", core._syl_tol({}) == 1)
check("tol resolution defaults an explicit None to 1", core._syl_tol({"syllableTol": None}) == 1)

TOL_LINE = {"index": 0, "role": "verse", "seedText": "", "text": "", "syllableTarget": 8,
            "syllableTol": 0, "rhymeGroup": "", "locked": False, "breaks": [],
            "echoTargets": [], "mouthTargets": [], "mouthText": ""}


def _mock_offcount(messages, **k):
    # ALWAYS one syllable short (7 vs the target 8) — with the bug this PASSED at tol 1
    return {"ok": True, "content": '{"lines":["they counted me out tonight"]}'}


try:
    brain_client.chat_json = _mock_offcount
    props = core._llm_propose_line(TOL_LINE, SPEC, None, 0)
    top = props[0]
    check("off-by-one line NEVER ships on a tol-0 line",
          core.syllables(top["text"]) == 8, f"chose {top['text']!r} ({core.syllables(top['text'])} syl)")
    check("the shipped line is the deterministic filler, marked as such",
          top.get("fallback") == "filler", str({k: top.get(k) for k in ("text", "fallback")}))
    check("no off-count proposal survives in the ranked list",
          all(c["syllableOk"] for c in props), str([(c["text"], c["syllables"]) for c in props]))
    props_b = core._llm_propose_line(TOL_LINE, SPEC, None, 0)
    check("exact-or-filler is deterministic", props == props_b)
finally:
    brain_client.chat_json = _real_chat

# an LLM batch that CONTAINS an in-tolerance line keeps it (no filler needed)
_batch = ['{"lines":["they counted me out tonight", "counted me out alone tonight"]}']


def _mock_mixed(messages, **k):
    return {"ok": True, "content": _batch[0]}


try:
    brain_client.chat_json = _mock_mixed
    props = core._llm_propose_line(TOL_LINE, SPEC, None, 0)
    check("an exact LLM line wins over filler (no fallback flag)",
          core.syllables(props[0]["text"]) == 8 and props[0].get("fallback") is None,
          str({k: props[0].get(k) for k in ("text", "fallback")}))
finally:
    brain_client.chat_json = _real_chat

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
