#!/usr/bin/env python3
"""FIM-LoRA training-triple miner (I4). Pure stdlib + bench.

Per train-slice rhyme item: `instruction`+`prefill` built by the SAME function
the local arms serve with (`arms._local_prompt` — byte-parity with eval is the
point: the bench's local arms then evaluate the adapter directly), and
`completion` = the artist's end word + newline (the newline teaches stopping).

The leakage rule from the I4 design (spec §Arms): constraints in the prompt
encode only SERVE-TIME-OBSERVABLE facts — syllable target, rhyme anchor,
context. `_local_prompt` already satisfies this by construction (it is the
serve prompt); the guard pins that the truth never appears anywhere in
instruction or prefill.

Same split discipline as `xenc_data` (train-only with counted refusals,
forbidden ids/songs belt, determinism via content sha). The written manifest
IS the `--exclude-manifest` evidence the design requires: it records the
forbidden-set sizes it was minted against.

Output under `{data_root}/fim/` — lyric text, never git. A second stage in the
mlx venv applies the worker's chat templating to produce mlx_lm
{"prompt","completion"} rows; this module stays hermetic.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Dict, Optional, Sequence, Set

from lyrics.bench import sampling
from lyrics.bench.metrics import normalize

MINT_VERSION = "v1"


def mint_triples(items: Sequence[dict], *, n_items: int, seed: int = 20260728,
                 forbidden_ids: Optional[Set[str]] = None,
                 forbidden_songs: Optional[Set[str]] = None) -> Dict:
    from lyrics.bench.arms import _local_prompt

    forbidden_ids = forbidden_ids or set()
    forbidden_songs = forbidden_songs or set()
    refused_split = refused_forbidden = leaked = 0
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
        truth = ((it.get("target") or {}).get("text") or "").strip()
        if not truth or " " in truth:
            continue
        instruction, prefill = _local_prompt(it)
        # The leakage rule, enforced per row: the serve prompt must not carry
        # the answer. A masked-line regression that leaked the truth into the
        # prefill would otherwise mint a copy-task dataset that trains a model
        # to look great and learn nothing.
        if normalize(truth) in (normalize(instruction).split()
                                + normalize(prefill).split()):
            leaked += 1
            continue
        triples.append({"itemId": it["itemId"], "songId": it.get("songId"),
                        "instruction": instruction, "prefill": prefill,
                        "completion": truth + "\n"})
    blob = "\n".join(json.dumps(t, ensure_ascii=False, sort_keys=True)
                     for t in triples)
    return {"version": MINT_VERSION, "triples": triples,
            "manifest": {"version": MINT_VERSION, "seed": seed,
                         "nItems": len(triples),
                         "refusedSplit": refused_split,
                         "refusedForbidden": refused_forbidden,
                         "leakedRefused": leaked,
                         "excludeManifest": {
                             "forbiddenIds": len(forbidden_ids),
                             "forbiddenSongs": len(forbidden_songs)},
                         "contentSha": hashlib.sha256(
                             blob.encode("utf-8")).hexdigest()}}


def write(out_dir: str, minted: Dict) -> Dict:
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "triples.jsonl"), "w", encoding="utf-8") as f:
        for t in minted["triples"]:
            f.write(json.dumps(t, ensure_ascii=False, sort_keys=True) + "\n")
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(minted["manifest"], f, indent=1, sort_keys=True)
    return minted["manifest"]
