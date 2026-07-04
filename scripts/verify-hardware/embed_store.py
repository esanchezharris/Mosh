#!/usr/bin/env python3
"""Persistent per-beat audio-embedding store — the latent-space substrate (owner:
"we need to start moving into latent space… more complex representation").

Until now every bench run recomputed CLAP embeddings and persisted nothing. This
store embeds each WAV once (keyed by content SHA256 of the decoded mono PCM — the
drummatch load_audio hash) and serves the taste ranker, style centroids, the
more-like-top-pick lane, and the bench.

Runs UNDER THE JUDGES VENV (laion_clap + muq installed there):

    ~/AI/judges_venv/bin/python scripts/verify-hardware/embed_store.py \
        --wavs a.wav b.wav …      # embed + persist (skips already-stored: idempotent)
    python3 embed_store.py --backfill   # all rated pack + owner-dna beats (re-execs venv)

Store layout: ~/mosh-beats/labels/embeddings/index.jsonl — one row per beat:
{"sha": …, "path": last-seen path, "clap": [512 floats], "muq": [... floats]|null}
(+ optional "source"/"chunks" on corpus rows). MuQ is best-effort
(advisory-never-fatal, like the axes attach).

TASTE CORPUS (the Long Pass data unlock): `--corpus [~/mosh-taste]` walks the
owner's drop folders with per-dir provenance — own/ = his finished beats,
refs/ = tracks he loves (embed-only), samples/ = loop-length library subset —
windows long files into 30 s mean-pooled embeddings, and keeps an authoritative
manifest at ~/mosh-beats/labels/corpus.jsonl. Incremental + idempotent
(content-SHA; same-content new-path gets a cheap alias row).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

BEATS = Path(os.path.expanduser("~/mosh-beats"))
# env overrides (priors pattern) — hermetic tests + the re-exec inherits them
STORE = Path(os.environ.get("MOSH_EMBED_STORE")
             or BEATS / "labels" / "embeddings" / "index.jsonl")
CORPUS_MANIFEST = Path(os.environ.get("MOSH_CORPUS_MANIFEST")
                       or BEATS / "labels" / "corpus.jsonl")
TASTE = Path(os.path.expanduser("~/mosh-taste"))
JUDGES_PY = os.path.expanduser("~/AI/judges_venv/bin/python")

AUDIO_EXT = {".wav", ".mp3", ".m4a", ".aif", ".aiff", ".flac", ".ogg"}
CORPUS_WINDOW_S = 30.0     # long files embed as mean-pooled 30 s windows
SAMPLE_MIN_S, SAMPLE_MAX_S = 3.0, 60.0   # samples/: loops only — one-shots carry
SAMPLE_CAP = 500                          # near-zero info and would swamp the PCA


def load_store() -> dict:
    out = {}
    if STORE.is_file():
        for line in STORE.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                out[row["sha"]] = row
    return out


def content_sha(path: str) -> str:
    """SHA of the RAW FILE bytes (cheap, no decode) — stable because shipped pack WAVs
    are immutable once rated. (drummatch hashes decoded PCM; file bytes are fine here
    and let the ranker key without the audio stack.)"""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def rated_wavs() -> list:
    """Every rated beat on disk: pack-*/NN_*.wav named in RATINGS CSVs + owner-dna."""
    import csv
    out = []
    for d in sorted(BEATS.glob("pack-*")):
        for c in d.glob("RATINGS*.csv"):
            for r in csv.DictReader(open(c)):
                p = d / (r.get("file") or "")
                if p.is_file():
                    out.append(str(p))
    for d in ("owner-dna/v1", "owner-dna", "owner-dna-v3", "owner-dna-v4"):
        full = BEATS / d
        if full.is_dir():
            out += [str(p) for p in sorted(full.glob("*.wav")) if " 2" not in p.name]
    return sorted(set(out))


def alias_known(paths: list) -> list:
    """Paths whose CONTENT is already stored under another path (e.g. a shipped pack
    WAV whose candidate render was embedded at build time) get a cheap ALIAS row —
    same sha and vectors, new path — so path-keyed readers (taste_ranker.load_embeddings,
    latent_lanes.load_store) resolve them without re-embedding. Returns the paths that
    still need a real embed. Needs no model → runs outside the judges venv."""
    if not STORE.is_file():
        return paths
    store = load_store()
    known_paths = {json.loads(l)["path"] for l in STORE.read_text().splitlines()
                   if l.strip()}
    todo, n = [], 0
    with open(STORE, "a") as f:
        for p in paths:
            if p in known_paths:
                continue
            sha = content_sha(p)
            row = store.get(sha)
            if row:
                f.write(json.dumps({**row, "path": p}) + "\n")
                n += 1
            else:
                todo.append(p)
    if n:
        print(f"embed store: +{n} alias rows (same content, new path)")
    return todo


def corpus_items(root: Path = TASTE) -> list:
    """(path, source) for every audio file in the drop folders. Deterministic walk;
    samples/ is capped (loops carry the info; the cap keeps one-shot dumps from
    swamping the map). iCloud ' 2' dupes skipped, dot-dirs included (refs/.fetch)."""
    out = []
    for sub, src in (("own", "own"), ("refs", "ref"), ("samples", "sample")):
        d = root / sub
        if not d.is_dir():
            continue
        files = sorted(p for p in d.rglob("*")
                       if p.is_file() and p.suffix.lower() in AUDIO_EXT
                       and " 2" not in p.name)
        if src == "sample":
            files = files[:SAMPLE_CAP]
        out += [(str(p), src) for p in files]
    return out


def corpus_manifest_rows() -> list:
    if not CORPUS_MANIFEST.is_file():
        return []
    return [json.loads(l) for l in CORPUS_MANIFEST.read_text().splitlines() if l.strip()]


def _append_jsonl(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(row) + "\n")


def run_corpus(root: Path = TASTE) -> int:
    """Incremental corpus pass: alias what's content-known, embed what isn't,
    manifest everything. Safe to run any time (corpus is data, not frozen code)."""
    from datetime import date
    items = corpus_items(root)
    if not items:
        print(f"corpus: nothing under {root} (drop audio into own/ refs/ samples/)")
        return 0
    seen = {r["path"] for r in corpus_manifest_rows()}
    new = [(p, s) for p, s in items if p not in seen]
    if not new:
        print(f"corpus: manifest current ({len(items)} items, nothing new)")
        return 0
    store = load_store()
    need = []
    n_alias = 0
    for p, src in new:
        sha = content_sha(p)
        row = store.get(sha)
        if row:
            _append_jsonl(STORE, {**row, "path": p, "source": src})
            _append_jsonl(CORPUS_MANIFEST,
                          {"sha": sha, "path": p, "source": src,
                           "addedAt": date.today().isoformat(),
                           "durationS": row.get("durationS"),
                           "chunks": row.get("chunks")})
            n_alias += 1
        else:
            need.append((p, src, sha))
    if n_alias:
        print(f"corpus: +{n_alias} alias rows (content already embedded)")
    if not need:
        return 0
    try:
        import laion_clap  # noqa: F401
    except ImportError:
        if not os.path.isfile(JUDGES_PY):
            print(f"judges venv missing at {JUDGES_PY} — cannot embed", file=sys.stderr)
            return 1
        return subprocess.run([JUDGES_PY, os.path.abspath(__file__),
                               "--corpus", str(root)]).returncode
    return _embed_corpus_under_venv(need)


def _embed_corpus_under_venv(items: list) -> int:
    """items = [(path, source, sha)]; must run under the judges venv. Long files
    embed as mean-pooled CORPUS_WINDOW_S windows (both views); samples outside the
    loop-length band are skipped (manifested with skip reason so re-runs stay
    incremental)."""
    import numpy as np
    from datetime import date
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))), "service"))
    from teardown.drummatch.embed import ClapEmbedder, load_audio

    clap = ClapEmbedder()
    muq_model = None
    try:
        from muq import MuQ
        import torch  # noqa: F401
        muq_model = MuQ.from_pretrained("OpenMuQ/MuQ-large-msd-iter").to("cpu").eval()
    except Exception as e:  # noqa: BLE001
        print(f"  (muq unavailable: {str(e)[:120]} — CLAP-only)", file=sys.stderr)

    def _pool(y, sr, fn):
        win = int(CORPUS_WINDOW_S * sr)
        if len(y) <= int(win * 1.2):
            return fn(y), 1
        vecs = []
        for st in range(0, len(y), win):
            seg = y[st:st + win]
            if len(seg) >= sr * 3:
                vecs.append(fn(seg))
        return np.mean(vecs, axis=0), len(vecs)

    def _muq_of(seg, sr):
        import torch
        import librosa
        y24 = librosa.resample(seg, orig_sr=sr, target_sr=24000)
        with torch.no_grad():
            out = muq_model(torch.from_numpy(y24).unsqueeze(0),
                            output_hidden_states=False)
        return out.last_hidden_state.mean(dim=1).squeeze(0).numpy()

    n = 0
    for path, src, sha in items:
        try:
            la = load_audio(path)
        except Exception as e:  # noqa: BLE001
            print(f"  skip {path}: {e}", file=sys.stderr)
            _append_jsonl(CORPUS_MANIFEST, {"sha": sha, "path": path, "source": src,
                                            "addedAt": date.today().isoformat(),
                                            "skipped": str(e)[:80]})
            continue
        dur = round(len(la.y) / float(la.sr), 2)
        if src == "sample" and not (SAMPLE_MIN_S <= dur <= SAMPLE_MAX_S):
            _append_jsonl(CORPUS_MANIFEST, {"sha": sha, "path": path, "source": src,
                                            "addedAt": date.today().isoformat(),
                                            "durationS": dur,
                                            "skipped": "outside loop-length band"})
            continue
        cvec, chunks = _pool(la.y, la.sr, lambda seg: clap.embed(seg, la.sr))
        row = {"sha": sha, "path": path, "source": src, "chunks": chunks,
               "durationS": dur,
               "clap": [round(float(v), 6) for v in cvec], "muq": None}
        if muq_model is not None:
            try:
                mvec, _ = _pool(la.y, la.sr, lambda seg: _muq_of(seg, la.sr))
                row["muq"] = [round(float(v), 6) for v in mvec]
            except Exception as e:  # noqa: BLE001
                print(f"  (muq failed on {os.path.basename(path)}: {str(e)[:80]})",
                      file=sys.stderr)
        _append_jsonl(STORE, row)
        _append_jsonl(CORPUS_MANIFEST, {"sha": sha, "path": path, "source": src,
                                        "addedAt": date.today().isoformat(),
                                        "durationS": dur, "chunks": chunks})
        n += 1
        print(f"  embedded [{src}] {os.path.basename(path)} ({dur}s, {chunks} win)")
    print(f"corpus: +{n} embedded → {STORE}")
    return 0


def _embed_under_venv(paths: list) -> int:
    """Embed the given paths (must run under the judges venv)."""
    import numpy as np  # noqa: F401
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))), "service"))
    from teardown.drummatch.embed import ClapEmbedder, load_audio

    store = load_store()
    todo = [(p, content_sha(p)) for p in paths]
    todo = [(p, s) for p, s in todo if s not in store]
    if not todo:
        print("embed store: nothing new (idempotent)")
        return 0

    clap = ClapEmbedder()
    muq_model = None
    try:  # MuQ best-effort second view
        from muq import MuQ
        import torch
        muq_model = MuQ.from_pretrained("OpenMuQ/MuQ-large-msd-iter")
        muq_model = muq_model.to("cpu").eval()
    except Exception as e:  # noqa: BLE001
        print(f"  (muq unavailable: {str(e)[:120]} — CLAP-only)", file=sys.stderr)

    STORE.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(STORE, "a") as f:
        for path, sha in todo:
            try:
                la = load_audio(path)
            except Exception as e:  # noqa: BLE001
                print(f"  skip {path}: {e}", file=sys.stderr)
                continue
            vec = clap.embed(la.y, la.sr)
            row = {"sha": sha, "path": path,
                   "clap": [round(float(v), 6) for v in vec], "muq": None}
            if muq_model is not None:
                try:
                    import torch
                    import librosa
                    y24 = librosa.resample(la.y, orig_sr=la.sr, target_sr=24000)
                    with torch.no_grad():
                        out = muq_model(torch.from_numpy(y24).unsqueeze(0),
                                        output_hidden_states=False)
                    mv = out.last_hidden_state.mean(dim=1).squeeze(0).numpy()
                    row["muq"] = [round(float(v), 6) for v in mv]
                except Exception as e:  # noqa: BLE001
                    print(f"  (muq failed on {os.path.basename(path)}: {str(e)[:80]})",
                          file=sys.stderr)
            f.write(json.dumps(row) + "\n")
            n += 1
            print(f"  embedded {os.path.basename(path)} (clap"
                  + (", muq" if row["muq"] else "") + ")")
    print(f"embed store: +{n} → {STORE}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wavs", nargs="*", default=[])
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--corpus", nargs="?", const=str(TASTE), default=None,
                    help="walk the taste drop folders (default ~/mosh-taste)")
    args = ap.parse_args(argv)
    if args.corpus:
        return run_corpus(Path(os.path.expanduser(args.corpus)))
    paths = list(args.wavs)
    if args.backfill:
        paths += rated_wavs()
    if not paths:
        print("nothing to embed (pass --wavs, --backfill or --corpus)")
        return 0
    paths = alias_known(list(dict.fromkeys(paths)))
    if not paths:
        print("embed store: nothing new (idempotent)")
        return 0
    # re-exec under the judges venv when needed (laion_clap lives there)
    try:
        import laion_clap  # noqa: F401
        return _embed_under_venv(paths)
    except ImportError:
        if not os.path.isfile(JUDGES_PY):
            print(f"judges venv missing at {JUDGES_PY} — cannot embed", file=sys.stderr)
            return 1
        return subprocess.run([JUDGES_PY, os.path.abspath(__file__), "--wavs"] + paths).returncode


if __name__ == "__main__":
    raise SystemExit(main())
