#!/usr/bin/env python3
"""Golden tests for the pilot harness (FMS WS1 / M0).

Hermetic: system python3, no API key, no network, and an INJECTED lexicon
(`_testlex`) rather than cmudict — the same discipline `runner_test` uses. That
is not only about speed (it takes the suite from ~57s to ~1s): with the real
lexicon, `_fake_propose_line`'s `rhyme_search` scans ~126k entries per line, and
the test's verdict would then depend on whether the machine happens to have
cmudict installed.

The LLM path is exercised through a scripted stub installed at
`core.brain_client` — the same seam the harness itself records at — so these
cover the real wiring rather than a parallel mock of it.

The load-bearing test is `regen never reaches the LLM prompt`. That fact
(core.py:310 passes `regen` only to the fake fallback) is why N draws are N
independent provider samples rather than N seeds, and therefore why the cache
payload needs a `draw` nonce. A comment asserting it would rot; this pins it.

Run:  python3 service/lyrics/bench/pilot_test.py     (exit 0 = all pass)
"""
import copy
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics import core as product_core  # noqa: E402
from lyrics.bench import llm_cache, pilot  # noqa: E402
from lyrics.bench._testlex import make_pron  # noqa: E402

# Whole-file swap: every path under test (rhyme grouping, syllable targets, the
# fake backend's validator) reads core's module-level pronouncer.
product_core._P = make_pron()

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# Two locked context bars and four gaps across two rhyme groups. Every end word
# is in the fixture lexicon so the rhyme grades are real, not spelling guesses.
SPEC = {
    "grid": "1/16", "explicit": "allow", "rhymeStrictness": "slant",
    "topic": "comeback", "mood": "aggressive", "styleBias": False,
    "lines": [
        {"index": 0, "text": "came back from the bottom with it on my mind",
         "locked": True, "rhymeGroup": "A"},
        {"index": 1, "text": "never had a hand out so i had to grind",
         "locked": True, "rhymeGroup": "A"},
        {"index": 2, "seedText": "____", "syllableTarget": 10, "syllableTol": 1,
         "rhymeGroup": "B"},
        {"index": 3, "seedText": "____", "syllableTarget": 10, "syllableTol": 1,
         "rhymeGroup": "B"},
        {"index": 4, "seedText": "i been ____", "syllableTarget": 9, "syllableTol": 1,
         "rhymeGroup": "C"},
        {"index": 5, "seedText": "____", "syllableTarget": 9, "syllableTol": 1,
         "rhymeGroup": "C"},
    ],
}


def run_fake(n=4, show_context=False, td=None, cache_dir=None):
    return pilot.run_pilot(copy.deepcopy(SPEC), n=n, backend="fake", run_dir=td,
                           show_context=show_context, cache_dir=cache_dir)


# ---- 1. end-to-end on the fake backend ----
with tempfile.TemporaryDirectory() as td:
    res = run_fake(n=4, td=td)
    text = open(os.path.join(td, "read-aloud.txt"), encoding="utf-8").read()
    rows = [json.loads(l) for l in
            open(os.path.join(td, "candidates.jsonl"), encoding="utf-8") if l.strip()]
    check("e2e: four candidate blocks in read-aloud.txt",
          text.count("Candidate ") == 4, str(text.count("Candidate ")))
    check("e2e: four rows in candidates.jsonl", len(rows) == 4, str(len(rows)))
    check("e2e: every sheet line appears in each candidate row",
          all(len(r["lines"]) == len(SPEC["lines"]) for r in rows))
    check("e2e: the two locked bars are tagged locked, the four gaps generated",
          all([x["source"] for x in r["lines"]]
              == ["locked", "locked", "generated", "generated", "generated", "generated"]
              for r in rows))
    check("e2e: no bar came back empty", all(x["text"].strip() for x in
                                             [y for r in rows for y in r["lines"]]))
    gen = [x for r in rows for x in r["lines"] if x["source"] == "generated"]
    # The loop's own gate, re-checked from the artifact: the fake backend is
    # constraint-aware, so a syllable miss here means assembly picked the wrong
    # proposal (or picked from the wrong line).
    by_index = {int(l["index"]): l for l in SPEC["lines"]}
    off = [(x["index"], x["syllables"], by_index[x["index"]]["syllableTarget"])
           for x in gen
           if x["syllables"] is not None
           and abs(x["syllables"] - by_index[x["index"]]["syllableTarget"])
           > by_index[x["index"]]["syllableTol"]]
    check("e2e: assembled bars hit their own line's syllable target ± tol",
          not off, str(off[:4]))
    check("e2e: a seeded bar keeps the producer's words",
          all("i been" in x["text"].lower() for x in gen if x["index"] == 4),
          str([x["text"] for x in gen if x["index"] == 4][:2]))

# ---- 1b. a bar with NO proposals surfaces the sentinel, it does not vanish ----
# The fake backend always proposes something, so test 1 can never exercise the
# empty branch — it passed a sabotage that deleted the sentinel outright. This
# drives `assemble_candidate` with the state the loop produces when a line comes
# back empty, which is the only way the fixture can carry the failure it guards.
_empty_result = {"ok": True, "backend": "llm", "lines": [
    {"index": 2, "proposals": []},
    {"index": 3, "proposals": [{"text": "held it down until i saw the gold",
                                "endWord": "gold", "syllables": 10}]},
    {"index": 4, "proposals": []},
    {"index": 5, "proposals": []},
]}
_assembled = pilot.assemble_candidate(SPEC, _empty_result)
_blanks = [r for r in _assembled if r["source"] == "generated" and r["proposalCount"] == 0]
check("empty proposals: the bar is marked, not dropped",
      len(_assembled) == len(SPEC["lines"]) and len(_blanks) == 3, str(len(_blanks)))
check("empty proposals: each carries the visible sentinel",
      all(r["text"] == pilot.NO_CANDIDATE for r in _blanks),
      str([r["text"] for r in _blanks]))
check("empty proposals: the sentinel reaches read-aloud (a blank would be filtered out)",
      pilot.render_read_aloud([_assembled], show_context=False).count(pilot.NO_CANDIDATE) == 3)

# ---- 2. N-distinctness under the fake backend (pins the regen threading) ----
with tempfile.TemporaryDirectory() as td:
    res = run_fake(n=4, td=td)
    joined = ["\n".join(x["text"] for x in cand if x["source"] == "generated")
              for cand in res["candidates"]]
    check("fake: the four candidates are pairwise distinct",
          len(set(joined)) == 4, f"{len(set(joined))} distinct of 4")


# ---- 3. regen NEVER reaches the LLM prompt (the fact the design rests on) ----
class SpyChat:
    """Scripted stand-in for brain_client. Records every messages list it sees."""

    def __init__(self):
        self.seen = []

    def available(self):
        return True

    def chat_json(self, messages, **kw):
        self.seen.append(json.dumps(messages, sort_keys=True, ensure_ascii=False))
        return {"ok": True, "provider": "spy", "model": "spy-1",
                "content": json.dumps({"lines": ["running up the numbers on my mind",
                                                 "counting up the paper on the grind",
                                                 "staying on the road until i shine"]})}


with tempfile.TemporaryDirectory() as td:
    spy = SpyChat()
    real = product_core.brain_client
    product_core.brain_client = spy
    try:
        pilot.run_pilot(copy.deepcopy(SPEC), n=3, backend="llm", run_dir=td,
                        show_context=False, cache_dir=None)
    finally:
        product_core.brain_client = real
    per_draw = len(spy.seen) // 3
    check("llm: regen does not vary the prompt — draw 1 and 2 send identical messages",
          per_draw > 0 and spy.seen[0:per_draw] == spy.seen[per_draw:2 * per_draw],
          f"{per_draw} calls/draw, {len(set(spy.seen))} distinct of {len(spy.seen)}")

# ---- 4. determinism: same spec, two fresh dirs → byte-identical artifacts ----
with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
    run_fake(n=3, td=a)
    run_fake(n=3, td=b)
    check("fake: artifacts are byte-identical across runs (manifest excluded)",
          all(open(os.path.join(a, f), encoding="utf-8").read()
              == open(os.path.join(b, f), encoding="utf-8").read()
              for f in ("read-aloud.txt", "candidates.jsonl", "spec.json")))


# ---- 5. replay: a recorded run re-serves from cache with a chat that RAISES ----
class BoomChat:
    def available(self):
        return True

    def chat_json(self, messages, **kw):
        raise AssertionError("provider called during replay — the cache did not serve")


with tempfile.TemporaryDirectory() as td:
    cache_dir = os.path.join(td, "cache")
    spy = SpyChat()
    real = product_core.brain_client
    product_core.brain_client = spy
    try:
        pilot.run_pilot(copy.deepcopy(SPEC), n=3, backend="llm",
                        run_dir=os.path.join(td, "r1"), show_context=False,
                        cache_dir=cache_dir)
    finally:
        product_core.brain_client = real

    product_core.brain_client = BoomChat()
    os.environ["MOSH_INFILL_CACHE_ONLY"] = "1"
    try:
        pilot.run_pilot(copy.deepcopy(SPEC), n=3, backend="llm",
                        run_dir=os.path.join(td, "r2"), show_context=False,
                        cache_dir=cache_dir)
        replayed, err = True, ""
    except Exception as e:  # noqa: BLE001 — a failed replay is the finding
        replayed, err = False, f"{type(e).__name__}: {e}"
    finally:
        os.environ.pop("MOSH_INFILL_CACHE_ONLY", None)
        product_core.brain_client = real

    check("replay: a recorded run replays with zero provider calls", replayed, err)
    if replayed:
        check("replay: replayed artifact is byte-identical to the original",
              open(os.path.join(td, "r1", "read-aloud.txt"), encoding="utf-8").read()
              == open(os.path.join(td, "r2", "read-aloud.txt"), encoding="utf-8").read())

# ---- 5b. the `draw` nonce: key-level ----
msgs = [{"role": "user", "content": "same"}]
check("cache: identical messages on different draws get DIFFERENT keys",
      llm_cache.cache_key({"pilot": 1, "draw": 1, "messages": msgs})
      != llm_cache.cache_key({"pilot": 1, "draw": 2, "messages": msgs}),
      "nonce absent ⇒ draws 2..N would replay draw 1")

# ---- 5c. BEHAVIOURAL: a cached run still calls the provider on every draw ----
# The key comparison above is true by arithmetic. This is the test that fails if
# the nonce is removed: with a live cache and byte-identical prompts across draws
# (test 3), draws 2 and 3 would be served from draw 1's entry.
with tempfile.TemporaryDirectory() as td:
    spy = SpyChat()
    real = product_core.brain_client
    product_core.brain_client = spy
    try:
        pilot.run_pilot(copy.deepcopy(SPEC), n=1, backend="llm",
                        run_dir=os.path.join(td, "one"), show_context=False,
                        cache_dir=os.path.join(td, "cache"))
        one_draw = len(spy.seen)
        pilot.run_pilot(copy.deepcopy(SPEC), n=3, backend="llm",
                        run_dir=os.path.join(td, "three"), show_context=False,
                        cache_dir=os.path.join(td, "cache"))
        three_draws = len(spy.seen) - one_draw
    finally:
        product_core.brain_client = real
    # Draw 1 of the n=3 run replays the n=1 run (same nonce, same messages), so the
    # provider is hit for draws 2 and 3 only — 2/3 of a cold run, never 0.
    check("cache: draws 2..N reach the provider rather than replaying draw 1",
          one_draw > 0 and three_draws >= one_draw * 2,
          f"one_draw={one_draw} extra_for_three={three_draws}")

# ---- 5d. two BARS with identical prompts must not collapse into one response ----
# Found by reading a real 11-bar run, not by a test: `_build_messages` carries no
# line index, so two gap lines with the same syllable target and no rhyme anchor
# send byte-identical prompts. With a prompt-keyed cache the second is a HIT, and
# the verse comes back with a bar literally repeated — duplication the UNCACHED
# product path does not have.
#
# SPEC cannot exhibit this: the first line of a rhyme group has no anchor yet and
# the second one does, so its prompts differ. The collision needs two UNGROUPED
# lines of equal length, which is what this sheet is.
COLLIDE_SPEC = {
    "grid": "1/16", "explicit": "allow", "rhymeStrictness": "slant",
    "topic": "comeback", "mood": "aggressive", "styleBias": False,
    "lines": [
        {"index": 0, "seedText": "____", "syllableTarget": 10, "syllableTol": 1},
        {"index": 1, "seedText": "____", "syllableTarget": 10, "syllableTol": 1},
    ],
}
class CountingChat:
    """Answers a DIFFERENT line every call, so a collapsed call is visible as a
    repeat rather than hidden behind a constant response."""

    def __init__(self):
        self.n = 0

    def available(self):
        return True

    def chat_json(self, messages, **kw):
        self.n += 1
        end = ["mind", "grind", "shine", "line", "sign", "climb"][self.n % 6]
        return {"ok": True, "provider": "count", "model": f"c-{self.n}",
                "content": json.dumps({"lines": [
                    f"this is candidate bar number {self.n} on the {end}"]})}


with tempfile.TemporaryDirectory() as td:
    counter = CountingChat()
    real = product_core.brain_client
    product_core.brain_client = counter
    try:
        res = pilot.run_pilot(copy.deepcopy(COLLIDE_SPEC), n=1, backend="llm",
                              run_dir=os.path.join(td, "r"), show_context=False,
                              cache_dir=os.path.join(td, "cache"))
    finally:
        product_core.brain_client = real
    bars = [x["text"] for x in res["candidates"][0] if x["source"] == "generated"]
    check("collision: two bars with identical prompts get DIFFERENT responses",
          len(set(bars)) == len(bars), f"{len(set(bars))} distinct of {len(bars)}: {bars}")
    # Fixture adequacy: the pair really does send one identical prompt, so the
    # check above is guarding something that can actually happen.
    rows = [json.loads(l) for l in
            open(os.path.join(td, "r", "transcript.jsonl"), encoding="utf-8") if l.strip()]
    prompts = [json.dumps(r["messages"], sort_keys=True) for r in rows]
    check("collision fixture: the sheet really does produce a repeated prompt",
          len(set(prompts)) < len(prompts),
          f"{len(set(prompts))} distinct of {len(prompts)} — no collision to guard")

# ---- 6. read-aloud purity ----
with tempfile.TemporaryDirectory() as td:
    run_fake(n=3, td=td)
    text = open(os.path.join(td, "read-aloud.txt"), encoding="utf-8").read()
    banned = [t for t in ("{", "}", "score", "syllab", "provider", "proposal", "index")
              if t in text.lower()]
    check("read-aloud: carries no scores, metadata or JSON", not banned, str(banned))
    numbered = [ln for ln in text.splitlines()
                if ln[:2].strip().rstrip(".)").isdigit() and not ln.startswith("Candidate")]
    check("read-aloud: no per-line numbering", not numbered, str(numbered[:3]))
    check("read-aloud: the fixture actually carries bars to be pure ABOUT",
          len([ln for ln in text.splitlines() if ln.strip()]) >= 3 + 3 * 4)

# ---- 7. context policy: hidden by default, shown on request ----
with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
    run_fake(n=1, show_context=False, td=a)
    run_fake(n=1, show_context=True, td=b)
    hidden = open(os.path.join(a, "read-aloud.txt"), encoding="utf-8").read()
    shown = open(os.path.join(b, "read-aloud.txt"), encoding="utf-8").read()
    locked_bar = SPEC["lines"][0]["text"]
    check("context: hide (default) keeps the real locked bars OUT of read-aloud",
          locked_bar not in hidden)
    check("context: --show-context puts them in", locked_bar in shown)
    check("context: hide still emits all four generated bars",
          len([l for l in hidden.splitlines() if l.strip()]) == 1 + 4)


# ---- 8. fallback honesty: a dead provider is recorded, never silently claimed ----
class DeadChat:
    def available(self):
        return True

    def chat_json(self, messages, **kw):
        return {"ok": False, "error": "provider down"}


with tempfile.TemporaryDirectory() as td:
    real = product_core.brain_client
    product_core.brain_client = DeadChat()
    try:
        res = pilot.run_pilot(copy.deepcopy(SPEC), n=1, backend="llm", run_dir=td,
                              show_context=False, cache_dir=None)
    finally:
        product_core.brain_client = real
    man = json.load(open(os.path.join(td, "manifest.json"), encoding="utf-8"))
    check("dead provider: the run still produces bars (core degrades to the fake)",
          all(x["text"].strip() and x["text"] != pilot.NO_CANDIDATE
              for c in res["candidates"] for x in c if x["source"] == "generated"))
    check("dead provider: the manifest records the backend that was ASKED for",
          man["backends"] == ["llm"], str(man["backends"]))
    check("dead provider: the transcript records the failure rather than hiding it",
          any(not r["response"].get("ok")
              for r in [json.loads(l) for l in
                        open(os.path.join(td, "transcript.jsonl"), encoding="utf-8")
                        if l.strip()]))

# ---- 9. data policy: repo paths refused ----
ok_refused = False
try:
    pilot.refuse_repo_path(os.path.join(pilot.REPO_ROOT, "service", "leak"))
except ValueError:
    ok_refused = True
check("data policy: an --out inside the repo tree is refused", ok_refused)
outside = True
try:
    pilot.refuse_repo_path(os.path.join(tempfile.gettempdir(), "fine"))
except ValueError:
    outside = False
check("data policy: a path outside the repo is allowed (the guard is not blanket)",
      outside)

# ---- 10. itemId parsing survives the colon inside songId ----
check("itemId: songId's own colon does not break the parse",
      pilot.parse_item_id("v2:rhyme:gs:10359264:s3:l12") == ("gs:10359264", 3, 12),
      str(pilot.parse_item_id("v2:rhyme:gs:10359264:s3:l12")))
bad = False
try:
    pilot.parse_item_id("nonsense")
except ValueError:
    bad = True
check("itemId: an unparseable id raises rather than guessing", bad)

# ---- 11. verse spec: real syllable shape + recovered rhyme scheme ----
SONG = {"songId": "gs:1", "artist": "x", "views": 10, "sections": [
    {"kind": "verse", "lines": [
        "i was counting up the paper in my mind",       # mind
        "everything i ever wanted on the grind",        # grind → rhymes
        "took the long way from the bottom to the gold",  # gold
        "never gonna let it go until it cold",          # cold  → rhymes
    ]}]}
vs = pilot.verse_spec_from_section(SONG, 0, keep_context=1)
check("verse spec: opening bar locked, the rest are gaps",
      [bool(l.get("locked")) for l in vs["lines"]] == [True, False, False, False],
      str([bool(l.get("locked")) for l in vs["lines"]]))
check("verse spec: each gap carries the REAL line's syllable count",
      all(l["syllableTarget"] == product_core.syllables(SONG["sections"][0]["lines"][i])
          for i, l in enumerate(vs["lines"]) if not l.get("locked")))
groups = [l.get("rhymeGroup") for l in vs["lines"]]
check("verse spec: the artist's rhyme scheme is recovered (AABB here)",
      groups[0] == groups[1] and groups[2] == groups[3]
      and groups[0] is not None and groups[0] != groups[2], str(groups))
# Fixture adequacy: a singleton must NOT be handed a group.
SOLO = {"songId": "gs:2", "artist": "x", "views": 1, "sections": [
    {"kind": "verse", "lines": ["put the whole thing in a basket",
                                "everybody wanna have an orange"]}]}
solo_groups = [l.get("rhymeGroup")
               for l in pilot.verse_spec_from_section(SOLO, 0, keep_context=0)["lines"]]
check("verse spec: a bar with no rhyme partner gets no group (no spurious anchor)",
      all(g is None for g in solo_groups), str(solo_groups))
check("verse spec: keep_context=0 locks nothing (whole verse generated)",
      not any(l.get("locked")
              for l in pilot.verse_spec_from_section(SONG, 0, keep_context=0)["lines"]))

# ---- 12. budget estimate reflects the sheet, not a constant ----
check("budget: the estimate counts fillable bars x 3 attempts x draws",
      pilot.estimate_calls(SPEC, 5) == 4 * 3 * 5, str(pilot.estimate_calls(SPEC, 5)))
check("budget: locked lines are not counted", pilot.generated_line_count(SPEC) == 4,
      str(pilot.generated_line_count(SPEC)))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
