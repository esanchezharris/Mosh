#!/usr/bin/env python3
"""Author a SoulX target score from a NUS-48E item + render it with the local MLX SoulX —
the REAL `pipeline` generator for FMS-Bench (oracle-lyrics: true words at true NUS timing,
pitch from the clean vocal's F0).

This is the third scoreboard curve's engine. The SoulX target score is a chunk dict:
  text     "<SP> word <SP> word ..."          (<SP> = rest)
  phoneme  "<SP> en_T-AY1-M ..."              (en_ + dash-joined uppercase ARPAbet, stress on vowels)
  note_pitch  "0 57 0 54 ..."                  (MIDI; 0 = rest)
  note_type   "1 2 1 2 ..."                    (1 rest, 2 word onset, 3 continuation)
  duration    "0.05 0.46 ..."                  (seconds)
  time [t0_ms, t1_ms], language, index

Phonemes come straight from NUS phones (stress-less lowercase → uppercase, stress 1 on the
first vowel). Renders each ≤12s chunk via SoulX-Singer-MLX/scripts/inference_mlx_bridge.py.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

VOWELS = {"aa", "ae", "ah", "ao", "aw", "ay", "eh", "er", "ey", "ih", "iy", "ow", "oy", "uh", "uw"}
MAC = os.path.expanduser(os.environ.get("SOULX_MAC_DIR", "~/AI/soulx-mac"))
BRIDGE = os.path.join(MAC, "SoulX-Singer-MLX")


def _syllabify(phones):
    """Split NUS phones into syllables — one per vowel, onset consonants attached to the
    following vowel, trailing consonants to the last syllable. SoulX sings ONE syllable per
    note, so a whole word crammed on one note garbles (proven — 'edelweiss' → 'S S S S')."""
    vidx = [i for i, p in enumerate(phones) if p.lower() in VOWELS]
    if not vidx:
        return [list(phones)] if phones else []
    groups, start = [], 0
    for k, vi in enumerate(vidx):
        end = vi + 1 if k + 1 < len(vidx) else len(phones)   # last syllable takes trailing codas
        groups.append(phones[start:end])
        start = end
    return [g for g in groups if g]


def _phoneme(phones):
    """One SoulX syllable phoneme: en_ dash-joined uppercase ARPAbet, stress on the vowel."""
    out = []
    for p in phones:
        u = p.upper()
        out.append(u + "1" if p.lower() in VOWELS else u)
    return "en_" + "-".join(out) if out else "<SP>"


def _midi(hz):
    return int(round(69 + 12 * math.log2(hz / 440.0))) if hz and hz > 0 else 0


def _pitch_for(f0_frames, a, b):
    """Median MIDI over [a,b] of voiced frames, else 0 (rest/unvoiced)."""
    hzs = sorted(hz for t, hz, v in f0_frames if a <= t < b and v and hz > 0)
    return _midi(hzs[len(hzs) // 2]) if hzs else 0


def author_score(item, f0_frames, t0, t1, *, name="nus"):
    """Build a SoulX chunk dict for the item's words in [t0,t1). One note per word
    (note_type 2) + rests (1) in the gaps. Pitch from the clean vocal's F0."""
    words = [w for w in item["words"] if w["end"] > t0 and w["start"] < t1]
    text, phon, pitch, ntype, dur = [], [], [], [], []
    cur = t0
    for w in words:
        s, e = max(t0, w["start"]), min(t1, w["end"])
        if s - cur > 0.02:                       # rest before the word
            text.append("<SP>"); phon.append("<SP>"); pitch.append(0); ntype.append(1)
            dur.append(round(s - cur, 4))
        syls = _syllabify(w["phones"])
        if not syls:                             # no phones → rest
            text.append("<SP>"); phon.append("<SP>"); pitch.append(0); ntype.append(1)
            dur.append(round(e - s, 4)); cur = e; continue
        seg = (e - s) / len(syls)                # split the word's span across its syllables
        for j, g in enumerate(syls):
            a, b = s + j * seg, s + (j + 1) * seg
            p = _pitch_for(f0_frames, a, b) or _pitch_for(f0_frames, s, e) or 55
            text.append(w["word"] if j == 0 else "-")
            phon.append(_phoneme(g))
            pitch.append(p)
            ntype.append(2 if j == 0 else 3)     # type 2 = word onset, 3 = continuation
            dur.append(round(b - a, 4))
        cur = e
    if t1 - cur > 0.02:                          # trailing rest
        text.append("<SP>"); phon.append("<SP>"); pitch.append(0); ntype.append(1); dur.append(round(t1 - cur, 4))
    return {"index": f"{name}_chunk_{int(t0)}", "language": "English",
            "time": [int(t0 * 1000), int(t1 * 1000)],
            "duration": " ".join(f"{d:.4f}" for d in dur),
            "text": " ".join(text), "phoneme": " ".join(phon),
            "note_pitch": " ".join(str(p) for p in pitch),
            "note_type": " ".join(str(n) for n in ntype)}


PHON_PY = os.path.expanduser("~/Library/Mosh/venvs/phonology/bin/python3")
REF_WAV = os.path.expanduser("~/mosh-fms-ksb/used2/asserted-proof/back-half/sing-handoff/refs/own-30s.wav")
REF_JSON = os.path.expanduser("~/mosh-fms-ksb/used2/asserted-proof/back-half/sing-handoff/refs/own-30s.json")


def author_payload(item, t0, t1, f0, durations="verbatim", convention="syllable",
                   note_floor_s=0.0, author_extra=None):
    """The author-script input (pure, so the NUS/own-pairs split is testable).

    Own-pairs items carry their own real-text ground-truth words and a `singer` that is not
    a NUS singer, so their words travel inline. NUS items get exactly the previous payload —
    no `words` key — and fall through to the author's lookup-by-singer path unchanged.

    `convention`/`note_floor_s` are the SoulX in-distribution re-authoring knobs; both are
    omitted at their defaults so the existing payload is byte-unchanged. `author_extra`
    merges additional author knobs (e.g. melisma thresholds for the iterate loop) — None/{}
    adds nothing."""
    payload = {"singer": item["singer"], "t0": t0, "t1": t1, "f0": f0}
    if "mumble_vocal" in item:
        payload["words"] = item["words"]
    if durations != "verbatim":          # absent key => the shipped default, byte-unchanged
        payload["durations"] = durations
    if convention != "syllable":
        payload["convention"] = convention
    if note_floor_s > 0.0:
        payload["noteFloorS"] = note_floor_s
    if author_extra:
        payload.update(author_extra)
    return payload


def place_chunk(y, a_ms, b_ms, sr):
    """Return exactly the chunk's span [a_ms,b_ms) from a chunk render.

    SoulX honors the score's time[0] (used2 GOTCHA), so a chunk render may arrive
    SELF-PLACED on the span clock (length ≈ b_ms) with leading silence — or CHUNK-LOCAL
    (length ≈ b_ms−a_ms). Decide by nearest length, slice/trim, zero-pad short tails."""
    import numpy as np
    y = np.asarray(y, dtype=np.float64)
    n_abs = int(round(b_ms / 1000.0 * sr))
    n_loc = int(round((b_ms - a_ms) / 1000.0 * sr))
    seg = y[n_abs - n_loc:] if abs(len(y) - n_abs) < abs(len(y) - n_loc) else y
    seg = seg[:n_loc]
    if len(seg) < n_loc:
        seg = np.concatenate([seg, np.zeros(n_loc - len(seg))])
    return seg


def assemble_chunks(rendered, chunks_meta, sr):
    """Concatenate per-chunk renders on the span clock (chunks tile — plain placement,
    NO adelay: the double-offset gotcha). Total length == the last chunk's end."""
    import numpy as np
    return np.concatenate([place_chunk(y, m["time"][0], m["time"][1], sr)
                           for y, m in zip(rendered, chunks_meta)])


def chunk_chain_ok(clips, chunks, tol_s=0.01):
    """Chain-sum guard: the chunks' durations must re-sum to the clips' total and the
    chunk timeline must tile without gaps."""
    total = sum(float(d) for c in clips for d in str(c["duration"]).split())
    csum = sum(float(d) for c in chunks for d in str(c["duration"]).split())
    if abs(total - csum) > tol_s:
        return False
    for a, b in zip(chunks[:-1], chunks[1:]):
        if a["time"][1] != b["time"][0]:
            return False
    span_ms = chunks[-1]["time"][1] - chunks[0]["time"][0]
    return abs(span_ms / 1000.0 - total) <= tol_s + 0.001 * len(chunks)


def _render_chunked(scorej, work, base, ref_wav, ref_json, chunk_s, out_wav):
    """Full-span render: chunk the authored score (≤chunk_s, melisma-safe breaks),
    render each chunk separately, reassemble on the span clock."""
    import numpy as np
    import soundfile as sf
    from asserted_proof_score import chunk_score
    clips = json.load(open(scorej))
    clips = clips if isinstance(clips, list) else [clips]
    chunks = chunk_score(clips, max_chunk_s=chunk_s)
    if len(chunks) <= 1:
        gen = render_chunk(scorej, os.path.join(work, base + "_render"), ref_wav, ref_json)
        import shutil
        shutil.copyfile(gen, out_wav)
        return out_wav
    if not chunk_chain_ok(clips, chunks):
        raise RuntimeError("chunk chain-sum mismatch — refusing to render")
    import mumble_probe as mp
    rendered, sr = [], None
    for i, ch in enumerate(chunks):
        cj = os.path.join(work, f"{base}_c{i:02d}_score.json")
        json.dump([ch], open(cj, "w"))
        gen = render_chunk(cj, os.path.join(work, f"{base}_c{i:02d}_render"), ref_wav, ref_json)
        y, y_sr = mp._read_mono(gen)
        if sr is None:
            sr = y_sr
        elif y_sr != sr:
            raise RuntimeError(f"chunk {i} sample rate {y_sr} != {sr}")
        rendered.append(y)
        print(f"    chunk {i + 1}/{len(chunks)} rendered "
              f"[{ch['time'][0] / 1000:.1f}-{ch['time'][1] / 1000:.1f}s]", flush=True)
    audio = assemble_chunks(rendered, chunks, sr)
    sf.write(out_wav, np.asarray(audio, dtype=np.float32), sr, subtype="PCM_16")
    return out_wav


def pipeline_generate(item, out_wav, *, t0=0.0, t1=12.0, ref_wav=None, ref_json=None,
                      f0_from="clean_vocal", durations="verbatim", convention="syllable",
                      note_floor_s=0.0, author_extra=None, chunk_s=None):
    """THE real `pipeline` generator: true words + F0 → product author_score (phonology venv)
    → local SoulX render → out_wav. Returns (out_wav, true_words). Oracle-lyrics; one ≤12 s
    window by default, or a chunked full span when `chunk_s` is set.

    `f0_from` names the item key the melody is read from, and is LOAD-BEARING. For NUS the
    default `clean_vocal` is correct: there the clean vocal IS the source being degraded, so
    reading its F0 leaks nothing. For **own-pairs it must be `mumble_vocal`** — the finished
    take is the answer, and reading its F0 would hand the pipeline the very thing it is being
    asked to produce. Explicit rather than inferred, so a leak cannot happen silently."""
    import mumble_probe as mp
    ref_wav, ref_json = ref_wav or REF_WAV, ref_json or REF_JSON
    work = os.path.dirname(out_wav) or "."
    os.makedirs(work, exist_ok=True)
    base = os.path.splitext(os.path.basename(out_wav))[0]

    # 1. F0 of the SOURCE the pipeline is allowed to see (in-process pyin)
    src, sr = mp._read_mono(item[f0_from])
    f0 = [[p["t"], p["hz"], 1 if p["v"] else 0] for p in mp._pyin(src, sr)]
    inj = os.path.join(work, base + "_in.json")
    json.dump(author_payload(item, t0, t1, f0, durations, convention, note_floor_s,
                             author_extra), open(inj, "w"))

    # 2. author the SoulX score under the phonology venv (real words + author_score)
    scorej = os.path.join(work, base + "_score.json")
    r = subprocess.run([PHON_PY, os.path.join(HERE, "bench_soulx_author.py"), inj, scorej],
                       capture_output=True, text=True)
    if r.returncode != 0 or not os.path.isfile(scorej):
        raise RuntimeError(f"author_score failed: {r.stderr[-400:] or r.stdout[-400:]}")
    true_words = []
    for line in r.stdout.splitlines():
        if line.startswith("WORDS "):
            true_words = json.loads(line[6:])

    # 3. render via the local SoulX bridge, move generated.wav to out_wav
    if chunk_s:
        _render_chunked(scorej, work, base, ref_wav, ref_json, chunk_s, out_wav)
        return out_wav, true_words
    outd = os.path.join(work, base + "_render")
    gen = render_chunk(scorej, outd, ref_wav, ref_json)
    import shutil
    shutil.copyfile(gen, out_wav)
    return out_wav, true_words


def render_chunk(score_json_path, out_dir, ref_wav, ref_json):
    """Render one SoulX target score to out_dir/generated.wav via the local MLX bridge."""
    os.makedirs(out_dir, exist_ok=True)
    py = os.path.join(MAC, "venv", "bin", "python")
    # SOULX_SEED pins the flow-matching init noise (bridge env knob added 2026-07-18):
    # without it, identical scores render differently run to run and round-to-round
    # comparisons are mostly noise (measured: byte-identical score, conformance swung
    # silent-notes 4->0 and rhythm 103->40ms). Callers may override; "" disables.
    env = dict(os.environ, PYTHONPATH=BRIDGE, PYTORCH_ENABLE_MPS_FALLBACK="1")
    env.setdefault("SOULX_SEED", "4242")
    r = subprocess.run(
        [py, "scripts/inference_mlx_bridge.py",
         "--model", "models/SoulX-Singer-bf16", "--component", "svs", "--control", "score",
         "--device", "mps", "--prompt_wav_path", ref_wav, "--prompt_metadata_path", ref_json,
         "--target_metadata_path", score_json_path,
         "--phoneset_path", "soulxsinger/utils/phoneme/phone_set.json",
         # sampler knobs are env-overridable for the iterate loop (defaults = the originals)
         "--n_steps", os.environ.get("SOULX_NSTEPS", "32"),
         "--cfg", os.environ.get("SOULX_CFG", "3.0"),
         "--pitch_shift", "0", "--save_dir", out_dir],
        cwd=BRIDGE, env=env, capture_output=True, text=True)
    gen = os.path.join(out_dir, "generated.wav")
    if r.returncode != 0 or not os.path.isfile(gen):
        raise RuntimeError(f"SoulX render failed (rc={r.returncode}): {r.stderr[-600:]}")
    return gen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--singer", required=True)
    ap.add_argument("--t0", type=float, default=0.0)
    ap.add_argument("--t1", type=float, default=12.0)
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-fms-ksb/bench/pipeline"))
    ap.add_argument("--ref-wav", default=os.path.expanduser(
        "~/mosh-fms-ksb/used2/asserted-proof/back-half/sing-handoff/refs/own-30s.wav"))
    ap.add_argument("--ref-json", default=os.path.expanduser(
        "~/mosh-fms-ksb/used2/asserted-proof/back-half/sing-handoff/refs/own-30s.json"))
    a = ap.parse_args()

    import bench_dataset as bd
    import mumble_probe as mp
    it = bd.nus_items(singers=[a.singer], limit=1)[0]
    clean, sr = mp._read_mono(it["clean_vocal"])
    f0 = [(p["t"], p["hz"], p["v"]) for p in mp._pyin(clean, sr)]
    score = author_score(it, f0, a.t0, a.t1, name=it["id"])
    os.makedirs(a.out, exist_ok=True)
    sp = os.path.join(a.out, f"{it['id']}_{int(a.t0)}-{int(a.t1)}.json")
    json.dump([score], open(sp, "w"), indent=1)
    print("authored:", sp)
    print("  text:", score["text"][:120])
    print("  note_type:", score["note_type"][:80], "| events:", len(score["note_type"].split()))
    outd = os.path.join(a.out, f"{it['id']}_{int(a.t0)}-{int(a.t1)}")
    print("rendering via local SoulX …", flush=True)
    gen = render_chunk(sp, outd, a.ref_wav, a.ref_json)
    print("RENDERED:", gen)
    return 0


if __name__ == "__main__":
    sys.exit(main())
