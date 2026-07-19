#!/usr/bin/env python3
"""Real embedding backends for the taste probe — runs under the EVAL venv
(MOSH_TASTE_PY / MOSH_JUDGES_PY, default ~/AI/judges_venv/bin/python), never in the
service process. One family per invocation:

  taste_cli.py clap  a.wav b.wav ...   -> LAION-CLAP audio embeddings
  taste_cli.py mert  a.wav b.wav ...   -> MERT-v0-public mean-pooled hidden states
  taste_cli.py tunejury a.wav ...      -> TuneJury pretrained BT-head quality scores

stdout: one JSON object {ok, family, backend, dim, embeddings: {path: [floats]}}.
Any missing dependency/weights exits 1 with a one-line reason on stderr — the caller
(features.cli_embed) surfaces that as an honest per-family "unavailable" status.

LICENSE NOTE (charter Q4): LAION-CLAP `larger_clap_music` is Apache-2.0 (clean);
MERT-v0-public is the commercially-clean MERT variant (330M/MuQ are CC-BY-NC and are
deliberately NOT wired here). Internal eval harness either way — service/taste never
ships in the product bundle.
"""
from __future__ import annotations

import json
import os
import sys

CLAP_HF_ID = "laion/larger_clap_music"          # charter-named, Apache-2.0
CLAP_LOCAL_CKPT = os.path.expanduser("~/AI/clap_ckpt/630k-audioset-best.pt")
MERT_HF_ID = "m-a-p/MERT-v0-public"             # the commercially-clean MERT


def _die(msg):
    sys.stderr.write(msg.strip() + "\n")
    raise SystemExit(1)


def _load_audio(path, sr):
    import librosa
    y, _ = librosa.load(path, sr=sr, mono=True)
    return y


_REAL_STDOUT = sys.stdout


def _emit(family, backend, embeddings):
    dim = len(next(iter(embeddings.values()))) if embeddings else 0
    json.dump({"ok": True, "family": family, "backend": backend, "dim": dim,
               "embeddings": embeddings}, _REAL_STDOUT)
    _REAL_STDOUT.write("\n")


def run_clap(paths):
    import torch
    embeddings, backend = {}, None
    try:
        from transformers import ClapModel, ClapProcessor
        model = ClapModel.from_pretrained(CLAP_HF_ID)
        processor = ClapProcessor.from_pretrained(CLAP_HF_ID)
        model.eval()
        backend = CLAP_HF_ID
        with torch.no_grad():
            for p in paths:
                y = _load_audio(p, 48_000)
                inputs = processor(audios=[y], sampling_rate=48_000, return_tensors="pt")
                feat = model.get_audio_features(**inputs)
                embeddings[p] = [round(float(v), 6) for v in feat[0].tolist()]
    except Exception as hf_err:  # noqa: BLE001 — offline/no-cache -> local ckpt fallback
        if not os.path.exists(CLAP_LOCAL_CKPT):
            _die(f"clap unavailable: {hf_err}")
        try:
            import laion_clap
            model = laion_clap.CLAP_Module(enable_fusion=False)
            model.load_ckpt(CLAP_LOCAL_CKPT)
            backend = f"laion_clap local ckpt {os.path.basename(CLAP_LOCAL_CKPT)}"
            import numpy as np
            with torch.no_grad():
                for p in paths:
                    y = _load_audio(p, 48_000)
                    feat = model.get_audio_embedding_from_data(
                        x=np.expand_dims(y, 0), use_tensor=False)
                    embeddings[p] = [round(float(v), 6) for v in feat[0]]
        except Exception as e:  # noqa: BLE001
            _die(f"clap unavailable: {e}")
    _emit("clap", backend, embeddings)


def run_mert(paths):
    try:
        import torch
        from transformers import AutoModel, Wav2Vec2FeatureExtractor
        model = AutoModel.from_pretrained(MERT_HF_ID, trust_remote_code=True)
        extractor = Wav2Vec2FeatureExtractor.from_pretrained(
            MERT_HF_ID, trust_remote_code=True)
        model.eval()
        sr = int(extractor.sampling_rate)
        embeddings = {}
        with torch.no_grad():
            for p in paths:
                y = _load_audio(p, sr)
                inputs = extractor(y, sampling_rate=sr, return_tensors="pt")
                hidden = model(**inputs).last_hidden_state       # [1, T, D]
                embeddings[p] = [round(float(v), 6)
                                 for v in hidden.mean(dim=1)[0].tolist()]
    except Exception as e:  # noqa: BLE001
        _die(f"mert unavailable: {e}")
    _emit("mert", MERT_HF_ID, embeddings)


def run_tunejury(paths):
    """TuneJury (arXiv 2606.17006): frozen CLAP+MERT -> 2.8M pairwise-logistic head;
    scores one clip as a preference scalar (empty prompt = the paper's safe default).
    Needs the `tunejury` package — its OWN isolated venv (setup-taste.sh --tunejury,
    MOSH_TUNEJURY_PY), never the judges venv. The primary head is CC-BY-NC (internal
    eval only); A1_clap_audio_only.pt is the Apache-2.0 variant."""
    try:
        from huggingface_hub import hf_hub_download
        from tunejury.score import Scorer
        ckpt = hf_hub_download("TuneJury/tunejury", "tunejury.pt")
        sc = Scorer.from_pretrained(ckpt)
        embeddings = {p: [round(float(sc.score(p, "")), 6)] for p in paths}
    except Exception as e:  # noqa: BLE001
        _die(f"tunejury unavailable: {e} — run service/taste/setup-taste.sh --tunejury")
    _emit("tunejury", "TuneJury/tunejury tunejury.pt (empty prompt)", embeddings)


def main():
    # laion_clap/transformers print load noise straight to stdout; shield the JSON
    # stream — everything the libraries print lands on stderr, the final JSON object
    # goes to the real stdout via _emit.
    sys.stdout = sys.stderr
    if len(sys.argv) < 3:
        _die("usage: taste_cli.py <clap|mert|tunejury> <wav> [wav ...]")
    family, paths = sys.argv[1], sys.argv[2:]
    for p in paths:
        if not os.path.exists(p):
            _die(f"missing audio file: {p}")
    if family == "clap":
        run_clap(paths)
    elif family == "mert":
        run_mert(paths)
    elif family == "tunejury":
        run_tunejury(paths)
    else:
        _die(f"unknown family: {family}")


if __name__ == "__main__":
    main()
