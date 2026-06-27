#!/usr/bin/env python3
"""Golden tests for the STYLE-RAG flywheel (Finish-My-Song §7) — the anti-slop, "sounds
like me" bias, fake-first + hermetic.

The flywheel: the producer's OWN lyric lines accumulate in an opt-in corpus; at generation
time we RETRIEVE the most relevant exemplars (lexical relevance over the topic/mood + what's
already written) and inject them into the prompt as a voice reference, with a near-verbatim
NOVELTY guard so the model is steered by *style*, not by parroting an exemplar line. Corpus
management is backend-only (a safety wall); retrieval + the guard are deterministic.

Real embeddings are a parked upgrade behind the same `retrieve` seam — this v1 uses a
deterministic lexical scorer (stdlib only), so the whole flywheel runs hermetically with no
model. Style biasing is gated on spec["styleBias"], so with it OFF (the default) the
generation loop is byte-identical to before — the L2 golden is unaffected.

Run:  python3 service/lyrics/style_rag_test.py     (exit 0 = all pass)
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

import brain_client  # noqa: E402
from lyrics import core, style_corpus  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


MY_LINES = [
    "they counted me out so I came back stronger",
    "city lights blur as the engine roars louder",
    "every closed door taught me how to build my own",
    "no handouts taken, every brick I laid alone",
]


# ── 1. Corpus persistence: add (dedup) + stats + clear (opt-in, backend-only) ─────
with tempfile.TemporaryDirectory() as d:
    sc = style_corpus.StyleCorpus(os.path.join(d, "corpus.jsonl"))
    sc.add_lines(MY_LINES, meta={"source": "my-track"})
    sc.add_lines([MY_LINES[0]], meta={"source": "dup"})  # exact dup ignored
    check("corpus stats count = unique lines added", sc.stats()["lines"] == 4, str(sc.stats()))
    check("corpus persists to disk (a second reader sees them)",
          style_corpus.StyleCorpus(os.path.join(d, "corpus.jsonl")).stats()["lines"] == 4)
    sc.clear()
    check("clear empties the corpus", sc.stats()["lines"] == 0)


# ── 2. Retrieval is relevance-ranked + deterministic ──────────────────────────────
corpus = [{"text": t} for t in MY_LINES]
spec = {"topic": "comeback stronger", "mood": "defiant",
        "lines": [{"index": 0, "seedText": "they counted me out ___", "text": ""}]}
query = core._style_query(spec)
got = style_corpus.retrieve(corpus, query, k=2)
check("retrieve returns at most k exemplars", len(got) <= 2)
check("retrieve surfaces the most topically-relevant line first",
      got and "counted me out" in got[0], str(got))
check("retrieve is deterministic",
      style_corpus.retrieve(corpus, query, 2) == style_corpus.retrieve(corpus, query, 2))


# ── 3. Near-verbatim novelty guard catches a parroted exemplar, passes a fresh line ─
check("an (almost) verbatim corpus line is flagged near-verbatim",
      style_corpus.near_verbatim("they counted me out so I came back stronger", corpus) is not None)
check("a genuinely novel line is NOT flagged",
      style_corpus.near_verbatim("dreaming in colour while the night gets colder", corpus) is None)


# ── 4. The prompt carries exemplars ONLY when styleBias is on (back-compat) ───────
line = {"index": 1, "role": "verse", "seedText": "they counted me out ___ ___", "text": "",
        "syllableTarget": 8, "syllableTol": 1, "rhymeGroup": "A", "locked": False}
base_spec = {"grid": "1/16", "topic": "comeback stronger", "mood": "defiant", "rhymeStrictness": "slant",
             "lines": [line]}
msg_off = core._build_messages(line, base_spec, "flame", 8, 1, "slant", None)[-1]["content"]
check("styleBias OFF ⇒ no exemplar block (prompt unchanged)", "voice" not in msg_off.lower())

bias_spec = dict(base_spec, styleBias=True, styleCorpus=MY_LINES)
msg_on = core._build_messages(line, bias_spec, "flame", 8, 1, "slant", None)[-1]["content"]
check("styleBias ON ⇒ the prompt injects a voice/exemplar reference",
      "voice" in msg_on.lower() and any(ex.split()[0] in msg_on for ex in MY_LINES[:1]), msg_on[-300:])
check("styleBias ON ⇒ the prompt forbids copying the exemplars verbatim",
      "verbatim" in msg_on.lower() or "don't copy" in msg_on.lower() or "do not copy" in msg_on.lower())


# ── 5. The loop drops a parroted exemplar (novelty wall), keeps a styled fresh line ─
_real = brain_client.chat_json
try:
    # First reply parrots an exemplar verbatim (must be rejected); the retry returns a
    # fresh, constraint-meeting line (must survive).
    replies = iter([
        {"ok": True, "content": '{"lines":["they counted me out so I came back stronger"]}'},
        {"ok": True, "content": '{"lines":["they counted me out lit the flame"]}'},
    ])
    brain_client.chat_json = lambda *a, **k: next(replies, {"ok": True, "content": '{"lines":[]}'})
    props = core._llm_propose_line(line, bias_spec, anchor="flame", regen=0)
    texts = [p["text"] for p in props]
    check("the parroted exemplar is NOT surfaced (novelty guard)",
          "they counted me out so I came back stronger" not in texts, str(texts))
    check("a styled, fresh, constraint-meeting line survives", any(p["passes"] for p in props), str(texts))
finally:
    brain_client.chat_json = _real


# ── 6. styleBias ON but EMPTY corpus ⇒ graceful (no exemplars, no crash) ───────────
empty_bias = dict(base_spec, styleBias=True, styleCorpus=[])
msg_empty = core._build_messages(line, empty_bias, "flame", 8, 1, "slant", None)[-1]["content"]
check("empty corpus + styleBias ⇒ no exemplar block, no crash", "voice" not in msg_empty.lower())


# ── 7. Determinism: identical inputs → identical retrieval, 3x ────────────────────
r = [style_corpus.retrieve(corpus, query, 3) for _ in range(3)]
check("retrieval is stable across 3 runs", r[0] == r[1] == r[2])

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
