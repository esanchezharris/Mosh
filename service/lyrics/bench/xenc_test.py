#!/usr/bin/env python3
"""Guards for the cross-encoder scorer seam + arm (FMS M6).

The property that justifies this seam's existence: **the payload is truth-free.**
torchjudge's seam ships the truth-completed line with every pair (its judges
compare against it); a ranker that sees the truth is not ranking, it is copying.
The fixture's truth is a nonsense token that appears nowhere else, so its
absence from the backend payload is meaningful — and the sabotage that routes
through a truth-carrying payload turns the guard red at the payload boundary.

Hermetic: injected run_backend, no torch, no network.
Run:  python3 service/lyrics/bench/xenc_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import arms, llm_cache, xenc  # noqa: E402
from lyrics.bench._testlex import make_pron  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


TRUTH = "zorbulate"
ITEM = {
    "itemId": "x:1", "granularity": "rhyme", "songId": "gs:1", "split": "dev",
    "context": {"before": ["invented setup bar"],
                "maskedLine": "the bar ends with ____",
                "after": ["invented closing bar"]},
    "target": {"text": TRUTH, "syllables": 1},
    "constraints": {"syllables": 1, "rhymeWith": "mind",
                    "rhymeStrictness": "slant"},
}

SEEN_PAYLOADS = []


def fake_backend(python, script, payload):
    SEEN_PAYLOADS.append(json.dumps(payload))
    # Scores by passage length — deterministic, order-revealing.
    return {"ok": True,
            "scores": [float(len(p["passage"])) for p in payload["pairs"]],
            "backend": {"model": payload["model"], "kind": "xenc"}}


# ── the seam ────────────────────────────────────────────────────────────────────
out = xenc.score_candidates(ITEM, ["mine", "grind"], run_backend=fake_backend,
                            python="/fake/python")
check("seam: scores one per fill, higher for the longer passage",
      out["status"] == "ok" and len(out["scores"]) == 2
      and out["scores"][1] > out["scores"][0], str(out))
check("seam: TRUTH-FREE — the target never reaches the backend payload",
      TRUTH not in "\n".join(SEEN_PAYLOADS), "truth leaked into the payload")
check("seam: query keeps the blank a blank",
      "____" in json.loads(SEEN_PAYLOADS[-1])["pairs"][0]["query"])
check("seam: provenance travels with the scores",
      (out.get("backend") or {}).get("model") == xenc.XENC_MODEL)

with tempfile.TemporaryDirectory() as td:
    cache = llm_cache.Cache(td)
    n0 = len(SEEN_PAYLOADS)
    a = xenc.score_candidates(ITEM, ["mine", "grind"], cache=cache,
                              run_backend=fake_backend, python="/fake/python")
    b = xenc.score_candidates(ITEM, ["mine", "grind"], cache=cache,
                              run_backend=fake_backend, python="/fake/python")
    check("seam: second call is a full cache hit (no backend call)",
          a["scores"] == b["scores"] and len(SEEN_PAYLOADS) == n0 + 1,
          f"backend calls: {len(SEEN_PAYLOADS) - n0}")
    check("seam: cached scores keep their provenance",
          (b.get("backend") or {}).get("model") == xenc.XENC_MODEL,
          str(b.get("backend")))

out_u = xenc.score_candidates(ITEM, ["mine"], run_backend=lambda *a: {
    "ok": False, "error": "boom"}, python="/fake/python")
check("seam: backend failure → unavailable with None scores, never 0.0",
      out_u["status"] == "unavailable" and out_u["scores"] == [None])
out_m = xenc.score_candidates(ITEM, ["mine", "grind"], run_backend=lambda *a: {
    "ok": True, "scores": [1.0]}, python="/fake/python")
check("seam: a short score vector is unavailable, not silently zipped",
      out_m["status"] == "unavailable")

# ── the arm ─────────────────────────────────────────────────────────────────────
PRON = make_pron()


def fp_chat(messages, **kw):
    return {"ok": True, "provider": "fake", "model": "spy",
            "content": json.dumps({"fills": ["mine", "line", "shine"]})}


def xctx(scorer):
    return arms.ArmContext(chat=fp_chat, pron=PRON,
                           freq={"mine": 9, "line": 5, "shine": 1}, k=5,
                           xenc_score=scorer)


RHYME_ITEM = {
    "itemId": "x:2", "granularity": "rhyme", "songId": "gs:2", "split": "dev",
    "context": {"before": ["setup bar"], "maskedLine": "ends with ____",
                "after": []},
    "target": {"text": "shine", "syllables": 1},
    "constraints": {"syllables": 1, "rhymeWith": "mind",
                    "rhymeStrictness": "slant"},
}


def prefer_last(item, fills):
    return {"status": "ok", "scores": list(range(len(fills))),
            "backend": {"model": "fake-xenc"}}


res = arms.ARMS["xenc-rerank-fp40"](RHYME_ITEM, xctx(prefer_last))
check("arm: scorer preference REORDERS the base candidates",
      [c["text"] for c in res["candidates"]] == ["shine", "line", "mine"]
      and res["meta"]["movedTop1"] is True, str(res["candidates"]))
res_n = arms.ARMS["xenc-rerank-fp40"](RHYME_ITEM, xctx(None))
check("arm: no scorer configured → unavailable, base order NOT laundered",
      res_n["candidates"] == [] and res_n["meta"]["status"] == "unavailable")
res_u = arms.ARMS["xenc-rerank-fp40"](RHYME_ITEM, xctx(
    lambda item, fills: {"status": "unavailable", "scores": [None] * len(fills)}))
check("arm: scorer unavailable → unavailable, base order NOT laundered",
      res_u["candidates"] == [] and res_u["meta"]["status"] == "unavailable")
res_p = arms.ARMS["xenc-rerank-fp40"](RHYME_ITEM, xctx(
    lambda item, fills: {"status": "ok", "scores": [1.0, None, 0.0]}))
check("arm: a PARTIAL score vector is unavailable too (no half-rerank)",
      res_p["candidates"] == [] and res_p["meta"]["status"] == "unavailable")
wi = {**RHYME_ITEM, "granularity": "word",
      "constraints": {**RHYME_ITEM["constraints"], "rhymeWith": None}}
check("arm: declines non-rhyme granularity",
      arms.ARMS["xenc-rerank-fp40"](wi, xctx(prefer_last))
      ["meta"]["status"] == "declined")
res_t = arms.ARMS["xenc-rerank-fp40"](RHYME_ITEM, xctx(
    lambda item, fills: {"status": "ok", "scores": [0.0] * len(fills)}))
check("arm: tied scores preserve the base order (stable, deterministic)",
      [c["text"] for c in res_t["candidates"]] == ["mine", "line", "shine"])

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
