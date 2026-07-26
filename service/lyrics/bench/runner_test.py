#!/usr/bin/env python3
"""Golden tests for the arm registry + bench runner (FMS lyrics-bench I1).

The kill-shot bracket discipline: before trusting any metric, prove it RESPONDS —
oracle (truth) must score exact=1.0 and freq-floor must score below it. The LLM
arms run against an injected scripted chat (no network), and the cache makes a
second run make ZERO chat calls. product-llm drives the real shipped
lyrics.core.fill_gap loop with backend="fake" (deterministic, hermetic).

Run:  python3 service/lyrics/bench/runner_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import arms, build_eval, llm_cache, mask, runner  # noqa: E402
from lyrics.bench._testlex import make_pron  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


with open(os.path.join(HERE, "fixtures", "synthetic_songs.jsonl"), encoding="utf-8") as f:
    SONGS = [json.loads(ln) for ln in f if ln.strip()]

PRON = make_pron()
SPEC = {"version": 1, "artists": ["Golden Fixture"], "songs": [], "ownSources": [],
        "notes": ""}
splits, _ = build_eval.assign_splits(SONGS, SPEC, salt="runner-salt", dev_frac=0.9)
FREQ = mask.build_freq_table(SONGS)
ITEMS, _m = build_eval.build_items(SONGS, splits, PRON, golden_spec=SPEC,
                                   salt="runner-salt", freq=FREQ)
DEV = [i for i in ITEMS if i["split"] == "dev"]
check("setup: fixture dev slice non-trivial", len(DEV) >= 30, str(len(DEV)))

# ---- the cache key must move when an arm's BEHAVIOUR moves -------------------
# A real cost: `rhyme-floor` was fixed to exclude stopwords, re-run, and came
# back byte-identical — the runner keys its cache on (arm, version, item), so
# without a version bump the old candidates replayed and the "fixed" run was a
# ghost. Anything that changes what an arm answers must change its version.
_ARM_BEHAVIOUR_VERSIONS = {
    # arm -> version at the time its current behaviour was pinned. Bump here in
    # the same commit that changes the arm, or the sweep silently re-serves the
    # previous behaviour.
    "oracle": "v1", "freq-floor": "v1", "llm-zeroshot": "v1",
    "llm-constrained": "v1", "product-llm": "v2",
    "rhyme-floor": "v2", "prompt-rhyme-menu": "v1", "nbest-rerank": "v1",
    "fusion-rerank": "v2",
}
check("every registered arm is version-pinned in the test",
      set(arms.ARMS) == set(_ARM_BEHAVIOUR_VERSIONS),
      f"registry={sorted(arms.ARMS)} pinned={sorted(_ARM_BEHAVIOUR_VERSIONS)}")
check("no arm changed behaviour without bumping its version",
      all(arms.ARM_VERSIONS[a] == v for a, v in _ARM_BEHAVIOUR_VERSIONS.items()
          if a in arms.ARM_VERSIONS),
      str({a: (arms.ARM_VERSIONS.get(a), v)
           for a, v in _ARM_BEHAVIOUR_VERSIONS.items()
           if arms.ARM_VERSIONS.get(a) != v}))


def ctx_with(chat_fn=None, cache_dir=None):
    return arms.ArmContext(chat=chat_fn, pron=PRON, freq=FREQ, k=5,
                           cache=llm_cache.Cache(cache_dir) if cache_dir else None,
                           product_backend="fake")


# ---- bracket: oracle ceiling ----
with tempfile.TemporaryDirectory() as td:
    res = runner.run_arm("oracle", DEV, ctx_with(cache_dir=td), out_dir=td)
    summ = res["summary"]
    for gran in ("word", "rhyme", "span"):
        check(f"oracle: exact=1.0 on {gran}",
              summ["metrics"][gran]["exact"] == 1.0, str(summ["metrics"].get(gran)))
    check("oracle: syl_fit=1.0 (truth fits its own constraints)",
          all(summ["metrics"][g]["syl_fit"] == 1.0 for g in summ["metrics"]),
          str({g: summ["metrics"][g].get("syl_fit") for g in summ["metrics"]}))
    check("oracle: results.jsonl row per item",
          res["rows"] == len(DEV), f"{res['rows']} vs {len(DEV)}")
    check("runner: summary carries arm version + item manifest hash",
          summ["arm"]["name"] == "oracle" and summ["arm"]["version"]
          and len(summ["itemsSha"]) == 64)

    # determinism: 3x identical summaries with a FRESH cache each run — a shared
    # cache would let replay satisfy this even for a nondeterministic arm
    # (review finding #9). Cache telemetry excluded (designed honesty signal).
    def scored(s):
        return {k: v for k, v in s.items() if k != "cache"}
    with tempfile.TemporaryDirectory() as td2, tempfile.TemporaryDirectory() as td3:
        s2 = runner.run_arm("oracle", DEV, ctx_with(cache_dir=td2),
                            out_dir=td2)["summary"]
        s3 = runner.run_arm("oracle", DEV, ctx_with(cache_dir=td3),
                            out_dir=td3)["summary"]
    check("oracle: 3x deterministic summary (fresh cache per run)",
          scored(summ) == scored(s2) == scored(s3))

# ---- bracket: floor below ceiling ----
with tempfile.TemporaryDirectory() as td:
    fl = runner.run_arm("freq-floor", DEV, ctx_with(cache_dir=td), out_dir=td)["summary"]
    check("freq-floor: exact strictly below oracle on word",
          fl["metrics"]["word"]["exact"] < 1.0, str(fl["metrics"]["word"]["exact"]))
    check("freq-floor: produces a candidate for every item", fl["emptyCandidates"] == 0)

# ---- scripted LLM arm + cache behavior ----
CALLS = {"n": 0}


def scripted_chat(messages, **kw):
    CALLS["n"] += 1
    # Always proposes "gold" first then "cold" — parseable JSON fills.
    return {"ok": True, "provider": "fake", "model": "scripted",
            "content": json.dumps({"fills": ["gold", "cold"]})}


with tempfile.TemporaryDirectory() as td:
    r1 = runner.run_arm("llm-zeroshot", DEV, ctx_with(scripted_chat, td), out_dir=td)
    n_after_first = CALLS["n"]
    check("llm-zeroshot: chat called on first run", n_after_first > 0)
    check("llm-zeroshot: candidates parsed from JSON fills",
          r1["summary"]["emptyCandidates"] == 0)
    r2 = runner.run_arm("llm-zeroshot", DEV, ctx_with(scripted_chat, td), out_dir=td)
    check("cache: second run makes ZERO new chat calls",
          CALLS["n"] == n_after_first, f"{CALLS['n']} vs {n_after_first}")
    check("cache: replayed run scores identically",
          r1["summary"]["metrics"] == r2["summary"]["metrics"])
    check("cache stats recorded in summary",
          r2["summary"]["cache"]["hits"] > 0 and r2["summary"]["cache"]["misses"] == 0,
          str(r2["summary"]["cache"]))

# ---- constrained arm prompt carries constraints; blind to the answer ----
SEEN = []


def spy_chat(messages, **kw):
    SEEN.append(json.dumps(messages))
    return {"ok": True, "provider": "fake", "model": "spy",
            "content": json.dumps({"fills": ["gold"]})}


rhyme_items = [i for i in DEV if i["granularity"] == "rhyme"][:3]
with tempfile.TemporaryDirectory() as td:
    runner.run_arm("llm-constrained", rhyme_items, ctx_with(spy_chat, td), out_dir=td)
    joined = "\n".join(SEEN)
    check("llm-constrained: prompt names the rhyme constraint",
          all(i["constraints"]["rhymeWith"] in joined for i in rhyme_items))
    # Blindness is PER-ITEM: item A's answer may legitimately be item B's
    # rhymeWith constraint in the same stanza — only its OWN prompt must be clean.
    # Token-exact (substring would false-hit "rain" inside "train").
    check("prompt never contains its own held-out answer",
          all(i["target"]["text"].lower() not in
              [t.lower() for t in mask.tokenize(SEEN[n])]
              for n, i in enumerate(rhyme_items)))

# ---- cache must key on item CONTENT, not itemId alone: a corpus/salt rebuild
# can re-mask the same itemId to a different target (review finding #3) ----
with tempfile.TemporaryDirectory() as td:
    orig = [i for i in DEV if i["granularity"] == "word"][:1]
    r_a = runner.run_arm("oracle", orig, ctx_with(cache_dir=td), out_dir=td)
    changed = json.loads(json.dumps(orig))
    changed[0]["target"]["text"] = "somethingelse"
    r_b = runner.run_arm("oracle", changed, ctx_with(cache_dir=td), out_dir=td)
    check("cache: changed item content under the same itemId is NOT replayed stale",
          r_b["summary"]["metrics"]["word"]["exact"] == 1.0,
          f"exact={r_b['summary']['metrics']['word']['exact']} (stale replay if 0)")

# ---- fill extraction from full-line proposals (the review blocker: tokenize()
# strips underscore tokens, so blank location must NOT go through tokenize) ----
def mk_item(masked, gran="word"):
    return {"granularity": gran,
            "context": {"before": [], "maskedLine": masked, "after": []}}


check("extract: single word mid-line",
      arms._extract_fill(mk_item("flow so ____ it can go"),
                         "flow so cold it can go") == "cold")
check("extract: line-final blank",
      arms._extract_fill(mk_item("and you know I love my ____", "rhyme"),
                         "and you know I love my dream") == "dream")
check("extract: blank glued to punctuation",
      arms._extract_fill(mk_item("I kept it in my ____, no debate"),
                         "I kept it in my safe, no debate") == "safe")
check("extract: span run",
      arms._extract_fill(mk_item("I was ____ ____ ____ rent", "span"),
                         "I was counting up the rent") == "counting up the")
check("extract: misaligned proposal falls back to full text",
      arms._extract_fill(mk_item("flow so ____ it can go"),
                         "a completely different bar") ==
      "a completely different bar")

# ---- product spec: glued blanks must normalize to bare gap tokens (core._tokens
# splits on whitespace; '____,' would otherwise become a LOCKED word / end anchor)
spec_item = {
    "granularity": "rhyme", "songId": "t", "artist": "T", "si": 0, "li": 0,
    "sectionKind": "verse", "licenseTier": "train-ok", "views": 0,
    "maskPolicy": "rhyme-v1", "seed": 0,
    "context": {"before": ["some prior bar"], "maskedLine": "I love my ____.",
                "after": []},
    "target": {"text": "chain", "tokenIndex": 3, "tokenSpan": None,
               "phones": None, "phonesSource": "none", "syllables": 1,
               "stress": ""},
    "constraints": {"syllables": 1, "syllableTol": 0, "rhymeWith": "rain",
                    "rhymeStrictness": "slant", "lineSyllableTarget": None},
}
pspec = arms._product_spec(spec_item, ctx_with())
gap_line = pspec["lines"][pspec["_gapIndex"]]
check("product spec: seedText carries a bare ____ gap token (no glued punctuation)",
      "____" in gap_line["seedText"].split()
      and not any("_" in t and t != "____" for t in gap_line["seedText"].split()),
      repr(gap_line["seedText"]))

# ---- product-llm arm drives the real shipped loop (fake backend, hermetic) ----
# lyrics.core builds a module-level REAL Pronouncer (cmudict + lazy g2p_en — the
# g2p path can even reach an nltk download). Pin it to the injected lexicon for
# the duration of the lane so the test stays hermetic (review finding #12).
from lyrics import core as _product_core  # noqa: E402
_real_P = _product_core._P
_product_core._P = PRON
try:
    with tempfile.TemporaryDirectory() as td:
        pr = runner.run_arm("product-llm", DEV[:12], ctx_with(cache_dir=td),
                            out_dir=td)
        check("product-llm: shipped loop returns candidates for every item",
              pr["summary"]["emptyCandidates"] == 0,
              str(pr["summary"]["emptyCandidates"]))
        check("product-llm: backend recorded as fake in this hermetic run",
              pr["summary"]["arm"]["productBackend"] == "fake")
        with tempfile.TemporaryDirectory() as td2:
            pr2 = runner.run_arm("product-llm", DEV[:12], ctx_with(cache_dir=td2),
                                 out_dir=td2)
        check("product-llm: deterministic under the fake backend (fresh cache)",
              pr["summary"]["metrics"] == pr2["summary"]["metrics"])
finally:
    _product_core._P = _real_P

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
