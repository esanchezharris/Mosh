#!/usr/bin/env python3
"""LAION-CLAP embedding scorer — runs UNDER THE JUDGES VENV, called by
bench_evaluators.py as a subprocess (the bench itself is stdlib+numpy only).

    ~/AI/judges_venv/bin/python scripts/verify-hardware/clap_score.py \
        --request req.json --out embeds.json

request JSON: {"wavs": ["/abs/a.wav", ...], "texts": ["a trap beat", ...]}
output JSON:  {"audio": {"/abs/a.wav": [512 floats], ...},
               "text":  {"a trap beat": [512 floats], ...}}

Writes to --out (never stdout — laion_clap prints loading noise), checkpoint at
~/AI/clap_ckpt/630k-audioset-best.pt (HTSAT-tiny, no fusion — the documented pairing).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

CKPT = os.path.expanduser("~/AI/clap_ckpt/630k-audioset-best.pt")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--request", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    req = json.load(open(args.request))

    real_err = sys.stderr
    sys.stdout = sys.stderr  # keep library chatter off any pipes

    import laion_clap  # noqa: E402  (judges venv only)
    model = laion_clap.CLAP_Module(enable_fusion=False)
    model.load_ckpt(CKPT)

    out = {"audio": {}, "text": {}}
    wavs = [w for w in req.get("wavs", []) if os.path.isfile(w)]
    if wavs:
        emb = model.get_audio_embedding_from_filelist(x=wavs, use_tensor=False)
        for path, vec in zip(wavs, emb):
            out["audio"][path] = [float(v) for v in vec]
    texts = req.get("texts", [])
    if texts:
        emb = model.get_text_embedding(texts, use_tensor=False)
        for text, vec in zip(texts, emb):
            out["text"][text] = [float(v) for v in vec]

    json.dump(out, open(args.out, "w"))
    print(f"clap: {len(out['audio'])}/{len(req.get('wavs', []))} wavs, "
          f"{len(out['text'])} texts → {args.out}", file=real_err)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
