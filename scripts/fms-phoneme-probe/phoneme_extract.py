#!/usr/bin/env python3
"""Take WAV → phoneme template JSON (the only torch script; runs under PROBE_PY).

wav2vec2-xlsr-53-espeak-cv-ft CTC per-frame argmax → template_build (collapse with
frame spans, line cut, held-vowel merge vs f0 voicing onsets, energy stress) →
<out>/template.json. The processor's phoneme TOKENIZER is deliberately not used (it
imports phonemizer/espeak-ng); ids decode against vocab.json directly.

Line segmentation priority (recorded in the output):
  1. --words <take>-words.json  (Whisper cache; phrase gaps ≥0.4s split — extract.py rule)
  2. blank-gap fallback         (≥0.4s hole in the phone stream)
  3. --lines-json               (explicit [[start,end],...] override)

Cached: an existing template.json with the same args hash is left alone (--force redoes).

Usage:
  phoneme_extract.py <input.wav> --out DIR [--words WORDS.json] [--f0 F0.json]
                     [--lines-json LINES.json] [--model NAME] [--force]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import template_build as tb  # noqa: E402

MODEL_DEFAULT = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
CHUNK_S = 30.0        # forward-pass window (memory bound); boundaries can split a
                      # phone — acceptable for a probe, noted in the template
RMS_HOP_S = 0.02


def _args_hash(ns: argparse.Namespace) -> str:
    key = json.dumps({"audio": os.path.abspath(ns.audio), "words": ns.words,
                      "f0": ns.f0, "lines_json": ns.lines_json, "model": ns.model,
                      "chunk_s": CHUNK_S}, sort_keys=True)
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--out", required=True)
    ap.add_argument("--words")
    ap.add_argument("--f0")
    ap.add_argument("--lines-json", dest="lines_json")
    ap.add_argument("--model", default=MODEL_DEFAULT)
    ap.add_argument("--force", action="store_true")
    ns = ap.parse_args()

    os.makedirs(ns.out, exist_ok=True)
    out_path = os.path.join(ns.out, "template.json")
    ah = _args_hash(ns)
    if os.path.exists(out_path) and not ns.force:
        with open(out_path, encoding="utf-8") as f:
            existing = json.load(f)
        if existing.get("args_hash") == ah:
            print(f"cached: {out_path}")
            return 0

    import torch
    import torchaudio
    from huggingface_hub import hf_hub_download
    from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC

    # Stdlib PCM reader from the product's skeleton module (torchaudio.load now routes
    # through torchcodec/ffmpeg, which this probe does not install; the takes are plain
    # PCM WAVs). Resample stays pure-torch DSP.
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))), "service"))
    from skeleton.core import read_pcm_mono  # noqa: E402

    loaded = read_pcm_mono(ns.audio)
    if loaded is None:
        print(f"unreadable WAV (not plain 16/24-bit PCM): {ns.audio}", file=sys.stderr)
        return 1
    mono, sr = loaded
    wave = torch.tensor(mono, dtype=torch.float32)
    if sr != 16000:
        wave = torchaudio.functional.resample(wave.unsqueeze(0), sr, 16000).squeeze(0)
    total_s = wave.shape[0] / 16000.0

    # RMS energy track for the stress proxy (same clock as the phones).
    hop = int(RMS_HOP_S * 16000)
    n_hops = max(1, wave.shape[0] // hop)
    rms = [float(wave[i * hop:(i + 1) * hop].pow(2).mean().sqrt()) for i in range(n_hops)]

    with open(hf_hub_download(ns.model, "vocab.json"), encoding="utf-8") as f:
        vocab = json.load(f)
    id_to_tok = {i: t for t, i in vocab.items()}
    blank_id = vocab.get("<pad>", 0)
    pad_ids = [i for t, i in vocab.items()
               if i != blank_id and (t.startswith("<") or t in ("|", " "))]

    fe = Wav2Vec2FeatureExtractor.from_pretrained(ns.model)
    model = Wav2Vec2ForCTC.from_pretrained(ns.model)
    model.eval()

    frame_ids: list = []
    frame_confs: list = []
    sec_per_frame = None
    chunk = int(CHUNK_S * 16000)
    with torch.no_grad():
        for start in range(0, wave.shape[0], chunk):
            piece = wave[start:start + chunk]
            if piece.shape[0] < 400:                            # < one receptive field
                break
            inputs = fe(piece.numpy(), sampling_rate=16000, return_tensors="pt")
            logits = model(inputs.input_values).logits[0]
            probs = torch.softmax(logits, dim=-1)
            conf, ids = probs.max(dim=-1)
            if sec_per_frame is None:
                sec_per_frame = (piece.shape[0] / 16000.0) / logits.shape[0]
            frame_ids.extend(int(i) for i in ids)
            frame_confs.extend(float(c) for c in conf)
    if not frame_ids:
        print("no frames decoded", file=sys.stderr)
        return 1

    phones = tb.ctc_collapse(frame_ids, frame_confs, blank_id, sec_per_frame,
                             lambda i: id_to_tok.get(i, "?"), pad_ids=pad_ids)

    onsets: list = []
    if ns.f0 and os.path.exists(ns.f0):
        with open(ns.f0, encoding="utf-8") as f:
            onsets = tb.onsets_from_f0(json.load(f))
    phones = tb.merge_held_vowels(phones, onsets)

    if ns.lines_json:
        with open(ns.lines_json, encoding="utf-8") as f:
            spans = [tuple(x) for x in json.load(f)]
        segmentation = "explicit"
    elif ns.words and os.path.exists(ns.words):
        with open(ns.words, encoding="utf-8") as f:
            spans = tb.lines_from_words(json.load(f))
        segmentation = "whisper-gaps"
    else:
        spans = tb.lines_from_blanks(phones)
        segmentation = "blank-gaps"

    lines = []
    for line_phones in tb.split_long_lines(tb.cut_lines(phones, spans)):
        built = tb.build_line(line_phones, rms, RMS_HOP_S, index=len(lines))
        if built is not None:
            built["span"] = [round(line_phones[0]["start"], 3),
                             round(line_phones[-1]["end"], 3)]
            lines.append(built)

    template = {
        "v": 1, "take": os.path.basename(ns.out.rstrip("/")),
        "audio": os.path.abspath(ns.audio), "model": ns.model, "args_hash": ah,
        "duration_s": round(total_s, 2), "sec_per_frame": round(sec_per_frame, 5),
        "segmentation": segmentation, "n_onsets": len(onsets),
        "lines": lines,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(template, f, ensure_ascii=False, indent=1)
    print(f"wrote {out_path}: {len(lines)} lines, "
          f"{sum(l['syllables'] for l in lines)} syllables, seg={segmentation}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
