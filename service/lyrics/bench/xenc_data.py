#!/usr/bin/env python3
"""Training-pair miner for the M6 cross-encoder (spec §3). Pure stdlib + bench.

Per item: `query` = the context with its blank still a blank (xenc.query_of),
`positive` = the artist's word in the bar, `negatives` = validated rhyming
pool-mates from the SAME item's freq pool — they rhyme, they scan, and they are
wrong: the hardest negatives obtainable, produced by the bench for free.

The guards, each RED-proved, in the order they would be tempting to skip:

  * **TRAIN slice only.** The ranker is evaluated on dev; a dev item in the
    training set makes the evaluation a memory test. Items from any other
    split are refused and counted, and an explicit `forbidden_ids` /
    `forbidden_songs` set (minted from dev+golden by the caller) is checked
    even though splits are disjoint by construction — "disjoint by
    construction" is a claim about code that ages.
  * **The truth is never a negative** (normalize-compare), and never comes
    from an LLM's top-5 (spec §3's label discipline: training on the
    generator's preferences makes the measurement circular).
  * **Determinism.** Same corpus + same seed ⇒ byte-identical output; the
    manifest carries the content sha so a drifted re-mint is a loud diff.

Output lives under `{data_root}/xenc/` — lyric text, never git.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
from typing import Dict, List, Optional, Sequence, Set

from lyrics.bench import sampling, xenc
from lyrics.bench.metrics import normalize

MINT_VERSION = "v1"


def mint_pairs(items: Sequence[dict], ctx, *, n_items: int, n_neg: int = 4,
               seed: int = 20260728,
               forbidden_ids: Optional[Set[str]] = None,
               forbidden_songs: Optional[Set[str]] = None) -> Dict:
    """Deterministic draw + per-item triple construction.

    Negatives: half from the pool head (the words an arm actually confuses),
    half seeded-random from the rest (so the scorer sees the tail too). Items
    whose pool cannot supply `n_neg` clean negatives are skipped and counted —
    a triple padded with junk is worse than one fewer triple.
    """
    from lyrics.bench.arms import _rhyme_menu

    forbidden_ids = forbidden_ids or set()
    forbidden_songs = forbidden_songs or set()
    refused_split = refused_forbidden = short_pool = 0
    usable = []
    for it in items:
        if it.get("split") != "train":
            refused_split += 1
            continue
        if it["itemId"] in forbidden_ids or it.get("songId") in forbidden_songs:
            refused_forbidden += 1
            continue
        if it.get("granularity") != "rhyme":
            continue
        usable.append(it)
    drawn = sampling.balanced(usable, limit=int(n_items),
                              key=lambda i: i["granularity"],
                              spread=lambda i: i["songId"], max_per_spread=3)
    triples = []
    for it in drawn:
        truth = (it.get("target") or {}).get("text") or ""
        tnorm = normalize(truth)
        if not tnorm:
            continue
        pool = _rhyme_menu(it, ctx, max_n=200, rank="freq")
        clean = [w for w in pool if normalize(w) != tnorm]
        if len(clean) < n_neg:
            short_pool += 1
            continue
        head = clean[:n_neg // 2]
        rng = random.Random(seed ^ int(hashlib.sha256(
            it["itemId"].encode()).hexdigest()[:8], 16))
        tail = rng.sample(clean[n_neg // 2:], n_neg - len(head))
        negs = head + tail
        triples.append({
            "itemId": it["itemId"], "songId": it.get("songId"),
            "query": xenc.query_of(it),
            "positive": xenc.passage_of(it, truth),
            "negatives": [xenc.passage_of(it, w) for w in negs],
        })
    blob = "\n".join(json.dumps(t, ensure_ascii=False, sort_keys=True)
                     for t in triples)
    return {"version": MINT_VERSION, "triples": triples,
            "manifest": {"version": MINT_VERSION, "seed": seed,
                         "nItems": len(triples), "nNeg": n_neg,
                         "poolRank": "freq",
                         "refusedSplit": refused_split,
                         "refusedForbidden": refused_forbidden,
                         "shortPool": short_pool,
                         "contentSha": hashlib.sha256(
                             blob.encode("utf-8")).hexdigest()}}


def write(out_dir: str, minted: Dict) -> Dict:
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "pairs.jsonl"), "w", encoding="utf-8") as f:
        for t in minted["triples"]:
            f.write(json.dumps(t, ensure_ascii=False, sort_keys=True) + "\n")
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(minted["manifest"], f, indent=1, sort_keys=True)
    return minted["manifest"]
