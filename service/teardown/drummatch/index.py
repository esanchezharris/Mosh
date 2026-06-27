"""Sample index + matcher.

The index scans a library, embeds each one-shot, **standardizes** features across the
corpus (so no single feature dominates), L2-normalizes, and does cosine NN. Brute-force
numpy is the default search (a 5k×D matmul is sub-millisecond); faiss is an optional
accelerator behind the venv. `DrumMatcher.match_into` writes results straight into a §0
Recipe element, so a tutorial references samples the owner OWNS.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Union

import numpy as np

from .embed import SR, WINDOW_S, AudioLike, EngineeredEmbedder, load_audio
from .roles import ROLE_VALUES, classify_role

AUDIO_EXTS = (".wav", ".aif", ".aiff", ".flac", ".ogg", ".mp3")
MATCHED_THRESHOLD = 0.15      # cosine distance below this → "matched", else "candidate"
NEAR_DUP_COSINE = 0.9999      # results closer than this to an already-picked one are dups


@dataclass
class Match:
    path: str
    distance: float           # cosine distance, 0 = identical
    role_guess: str
    kind: str


@dataclass
class IndexStats:
    indexed: int
    skipped: int
    skipped_files: list[tuple[str, str]] = field(default_factory=list)  # (path, reason)
    embedder_version: str = ""


def _l2(m: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(m, axis=-1, keepdims=True)
    n[n < 1e-12] = 1.0
    return m / n


class SampleIndex:
    def __init__(self, embedder=None) -> None:
        self.embedder = embedder or EngineeredEmbedder()
        self.version: str = self.embedder.version
        self.vectors: np.ndarray = np.zeros((0, 0), dtype=np.float32)  # (N, D) standardized + L2
        self.paths: list[str] = []
        self.roles: list[str] = []
        self.kinds: list[str] = []
        self.hashes: list[str] = []
        self.mean: Optional[np.ndarray] = None
        self.std: Optional[np.ndarray] = None

    # ── build ────────────────────────────────────────────────────────────────
    def build(self, library_root: Union[str, Path], exts: tuple[str, ...] = AUDIO_EXTS) -> IndexStats:
        raws: list[np.ndarray] = []
        meta: list[tuple[str, str, str, str]] = []
        seen: set[str] = set()
        skipped: list[tuple[str, str]] = []

        for p in sorted(Path(library_root).rglob("*")):
            if not p.is_file() or p.suffix.lower() not in exts:
                continue
            try:
                la = load_audio(p)
            except Exception as e:  # undecodable / silent / empty — flag, never fatal
                skipped.append((str(p), f"{type(e).__name__}: {e}"))
                continue
            if la.kind == "loop":
                skipped.append((str(p), "loop (excluded from one-shot index)"))
                continue
            if la.content_hash in seen:
                skipped.append((str(p), "duplicate (content hash)"))
                continue
            try:
                v = self.embedder.embed(la.y, la.sr)
            except Exception as e:
                skipped.append((str(p), f"embed {type(e).__name__}: {e}"))
                continue
            seen.add(la.content_hash)
            raws.append(np.asarray(v, dtype=np.float64))
            meta.append((str(p), classify_role(la.y, la.sr), la.kind, la.content_hash))

        if not raws:
            self.vectors = np.zeros((0, 0), dtype=np.float32)
            self.paths, self.roles, self.kinds, self.hashes = [], [], [], []
            self.mean = self.std = None
            return IndexStats(0, len(skipped), skipped, self.version)

        X = np.vstack(raws)
        self.mean = X.mean(axis=0)
        self.std = X.std(axis=0)
        self.std[self.std < 1e-9] = 1.0
        self.vectors = _l2((X - self.mean) / self.std).astype(np.float32)
        self.paths = [m[0] for m in meta]
        self.roles = [m[1] for m in meta]
        self.kinds = [m[2] for m in meta]
        self.hashes = [m[3] for m in meta]
        return IndexStats(len(raws), len(skipped), skipped, self.version)

    # ── query ─────────────────────────────────────────────────────────────────
    def _final_vec(self, audio: AudioLike) -> np.ndarray:
        if isinstance(audio, (str, Path)):
            la = load_audio(audio)
            y, sr = la.y, la.sr
        elif isinstance(audio, tuple):
            y, sr = audio
        else:
            y, sr = np.asarray(audio, dtype=np.float32), SR
        raw = np.asarray(self.embedder.embed(y, sr), dtype=np.float64)
        if self.mean is None or self.std is None:
            return raw.astype(np.float32)
        z = (raw - self.mean) / self.std
        n = float(np.linalg.norm(z))
        return (z / (n if n > 1e-12 else 1.0)).astype(np.float32)

    def _search(self, q: np.ndarray, role: Optional[str], k: int, collapse_dups: bool) -> list[Match]:
        if self.vectors.size == 0 or not self.paths:
            return []
        sims = self.vectors @ q
        order = np.argsort(-sims, kind="stable")
        out: list[Match] = []
        picked: list[np.ndarray] = []
        for i in order:
            if role and self.roles[i] != role:
                continue
            if collapse_dups and picked:
                vi = self.vectors[i]
                if max(float(vi @ pv) for pv in picked) >= NEAR_DUP_COSINE:
                    continue
            out.append(Match(self.paths[i], float(1.0 - sims[i]), self.roles[i], self.kinds[i]))
            picked.append(self.vectors[i])
            if len(out) >= k:
                break
        return out

    def query(self, audio: AudioLike, role: Optional[str] = None, k: int = 10,
              collapse_dups: bool = True) -> list[Match]:
        return self._search(self._final_vec(audio), role, k, collapse_dups)

    # ── persistence ─────────────────────────────────────────────────────────────
    def save(self, out_dir: Union[str, Path]) -> Path:
        d = Path(out_dir)
        d.mkdir(parents=True, exist_ok=True)
        np.save(d / "vectors.npy", self.vectors)
        manifest = {
            "version": self.version,
            "window_s": WINDOW_S,
            "sr": SR,
            "count": len(self.paths),
            "mean": None if self.mean is None else self.mean.tolist(),
            "std": None if self.std is None else self.std.tolist(),
            "items": [
                {"path": p, "role_guess": r, "kind": k, "content_hash": h}
                for p, r, k, h in zip(self.paths, self.roles, self.kinds, self.hashes)
            ],
        }
        (d / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True))
        return d

    def load(self, in_dir: Union[str, Path]) -> "SampleIndex":
        d = Path(in_dir)
        self.vectors = np.load(d / "vectors.npy")
        m = json.loads((d / "manifest.json").read_text())
        self.version = m["version"]
        self.mean = None if m["mean"] is None else np.asarray(m["mean"], dtype=np.float64)
        self.std = None if m["std"] is None else np.asarray(m["std"], dtype=np.float64)
        self.paths = [it["path"] for it in m["items"]]
        self.roles = [it["role_guess"] for it in m["items"]]
        self.kinds = [it["kind"] for it in m["items"]]
        self.hashes = [it["content_hash"] for it in m["items"]]
        return self


class DrumMatcher:
    """Facade per spec §1: build_index / query / match_into."""

    def __init__(self, index: Optional[SampleIndex] = None, matched_threshold: float = MATCHED_THRESHOLD) -> None:
        self.index = index or SampleIndex()
        self.matched_threshold = matched_threshold

    def build_index(self, library_root: Union[str, Path]) -> IndexStats:
        return self.index.build(library_root)

    def save(self, out_dir: Union[str, Path]) -> Path:
        return self.index.save(out_dir)

    def load(self, in_dir: Union[str, Path]) -> "DrumMatcher":
        self.index.load(in_dir)
        return self

    def query(self, audio: AudioLike, role: Optional[str] = None, k: int = 10) -> list[Match]:
        return self.index.query(audio, role=role, k=k)

    def match_into(self, recipe, element_id: str, k: int = 5) -> None:
        """Query for the element's audio and write `sample_match` into the Recipe (§0).

        References samples the owner owns; status=matched below the distance threshold,
        else candidate; the rest become `alternates`. No audio → status untouched."""
        from ..recipe import Alternate, SampleStatus

        el = next((e for e in recipe.elements if e.element_id == element_id), None)
        if el is None:
            raise KeyError(f"element {element_id!r} not in recipe")
        if not el.audio_ref:
            return
        role = el.role.value if el.role.value in ROLE_VALUES else None
        try:
            matches = self.query(el.audio_ref, role=role, k=k)
        except (OSError, ValueError, RuntimeError):  # missing/undecodable/silent ref → degrade, never crash
            # (soundfile.LibsndfileError is a RuntimeError; load_audio raises ValueError for silent/empty)
            el.sample_match.status = SampleStatus.none
            return
        if not matches:
            el.sample_match.status = SampleStatus.none
            return
        best = matches[0]
        el.sample_match.status = (
            SampleStatus.matched if best.distance <= self.matched_threshold else SampleStatus.candidate
        )
        el.sample_match.matched_path = best.path
        el.sample_match.distance = best.distance
        el.sample_match.alternates = [Alternate(path=m.path, distance=m.distance) for m in matches[1:]]
