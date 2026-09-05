#!/usr/bin/env python3
"""Eval + contract guard for the §1 drum matcher.

Self-contained — generates *procedural* one-shots (kick/snare/hat/clap) so it needs
neither the owner's library nor any model download:
    python3 service/teardown/drummatch/drummatch_test.py   (exit 0 = all pass)

Guards the spec's acceptance bar: perceptual ranking (same-type clusters), determinism
x3, messy-library tolerance (silent/corrupt/loop flagged, never fatal), content-hash
dedup, role-filtered query, warm query < 50 ms on a 5k index, and match_into writing a
§0 Recipe element.
"""
import os
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf

# librosa is needed by embed.py for every decode. The CI cheap gate's python
# (numpy/soundfile only) has no librosa, so skip loudly there — same posture as
# sa3_precompute_parity_test: this test is MANDATORY on a dev Mac.
#
# This import also used to have to happen BEFORE service/ went on sys.path,
# because numba probes `import coverage` at import time and service/coverage.py
# shadowed the PyPI package. That hazard is gone now that the module is
# service/clip_coverage.py, but the import stays here: it is where the skip
# belongs, and keeping it early costs nothing.
try:
    import librosa.effects  # noqa: F401
except ImportError as exc:  # pragma: no cover — CI-only path
    print(f"SKIP drummatch_test: librosa not importable ({exc})")
    print("     (this test is MANDATORY on a dev Mac — do not let it skip silently in CI)")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown import recipe as R  # noqa: E402
from teardown.drummatch import DrumMatcher, SampleIndex  # noqa: E402
from teardown.drummatch.embed import load_audio  # noqa: E402
from teardown.drummatch.roles import classify_role  # noqa: E402

SR = 44100
fails: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


# ── procedural one-shot synthesis (seeded → byte-stable across runs) ──────────
def synth(kind: str, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    if kind == "kick":
        n = int(0.35 * SR); t = np.arange(n) / SR
        f0, f1 = rng.uniform(110, 130), rng.uniform(45, 55)
        freq = f1 + (f0 - f1) * np.exp(-t * rng.uniform(25, 35))
        y = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t * rng.uniform(8, 12))
    elif kind == "hat":
        n = int(0.08 * SR)
        y = np.diff(rng.standard_normal(n + 1)) * np.exp(-np.arange(n) / SR * rng.uniform(80, 140))
    elif kind == "snare":
        n = int(0.2 * SR); t = np.arange(n) / SR
        y = (np.sin(2 * np.pi * rng.uniform(170, 200) * t) * 0.5 + rng.standard_normal(n) * 0.8) \
            * np.exp(-t * rng.uniform(15, 22))
    elif kind == "clap":
        n = int(0.18 * SR); y = np.zeros(n)
        for off in (0, int(0.008 * SR), int(0.016 * SR)):
            seg = rng.standard_normal(n); s = np.zeros(n); s[off:] = seg[: n - off]
            y += s * np.exp(-np.arange(n) / SR * 30)
        y *= np.exp(-np.arange(n) / SR * rng.uniform(10, 16))
    else:
        raise ValueError(kind)
    return (y / (np.max(np.abs(y)) or 1.0) * 0.9).astype(np.float32)


GROUPS = ("kick", "snare", "hat", "clap")
PER_GROUP = 6


def populate_library(d: Path) -> dict[str, str]:
    """Write PER_GROUP one-shots per kind; return {path: group}."""
    labels: dict[str, str] = {}
    for gi, g in enumerate(GROUPS):
        for i in range(PER_GROUP):
            p = d / f"{g}_{i}.wav"
            sf.write(str(p), synth(g, seed=gi * 100 + i), SR)
            labels[str(p)] = g
    return labels


def group_of(path: str) -> str:
    return Path(path).stem.split("_")[0]


# ── 1. ranking quality (the core value) ───────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    lib = Path(td); labels = populate_library(lib)
    dm = DrumMatcher()
    stats = dm.build_index(lib)
    check("index built all 24 one-shots", stats.indexed == len(GROUPS) * PER_GROUP, str(stats.indexed))

    nn_correct = 0; prec_sum = 0.0; n = 0
    for path, g in labels.items():
        res = dm.query(path, k=PER_GROUP)  # includes self at rank 0
        others = [m for m in res if m.path != path][:PER_GROUP - 1]
        if others:
            if group_of(others[0].path) == g:
                nn_correct += 1
            prec_sum += sum(group_of(m.path) == g for m in others) / len(others)
            n += 1
    nn_acc = nn_correct / n
    precision = prec_sum / n
    check("nearest-neighbour same-type >= 0.9", nn_acc >= 0.9, f"{nn_acc:.2f}")
    check("precision@5 same-type >= 0.8", precision >= 0.8, f"{precision:.2f}")
    check("self is rank-0 (distance ~0) for its own query",
          abs(dm.query(next(iter(labels)), k=1)[0].distance) < 1e-5)

# ── 2. determinism (the repo's bar) ──────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    lib = Path(td); populate_library(lib)
    a = SampleIndex(); a.build(lib)
    b = SampleIndex(); b.build(lib)
    check("rebuild → byte-identical vectors", np.array_equal(a.vectors, b.vectors))
    check("rebuild → identical path order", a.paths == b.paths)
    q = a.paths[0]
    rankings = {tuple(m.path for m in a.query(q, k=10)) for _ in range(3)}
    check("query ranking stable x3", len(rankings) == 1)

# ── 3. messy library: flagged, never fatal ───────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    lib = Path(td); labels = populate_library(lib)
    sf.write(str(lib / "silent.wav"), np.zeros(SR // 2, dtype=np.float32), SR)        # silent
    (lib / "corrupt.wav").write_bytes(b"this is definitely not a wav file")            # undecodable
    sf.write(str(lib / "loop.wav"), (np.random.default_rng(9).standard_normal(4 * SR)  # > 3 s
                                     * 0.3).astype(np.float32), SR)
    idx = SampleIndex()
    try:
        stats = idx.build(lib)
        crashed = False
    except Exception:
        crashed = True
    check("messy library builds without crashing", not crashed)
    check("only the 24 good one-shots indexed", stats.indexed == len(GROUPS) * PER_GROUP, str(stats.indexed))
    reasons = " | ".join(r for _, r in stats.skipped_files)
    check("silent file flagged", "silent" in reasons.lower())
    check("corrupt file flagged", "corrupt" in " ".join(p for p, _ in stats.skipped_files).lower())
    check("loop excluded from one-shot index", "loop" in reasons.lower())

# ── 4. content-hash dedup ────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    lib = Path(td)
    y = synth("kick", 1)
    sf.write(str(lib / "a.wav"), y, SR)
    sf.write(str(lib / "b_copy.wav"), y, SR)  # identical signal
    idx = SampleIndex(); s = idx.build(lib)
    check("identical signals dedup to one", s.indexed == 1, str(s.indexed))
    check("dup reason recorded", any("duplicate" in r for _, r in s.skipped_files))

# ── 5. role-filtered query is exact ──────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    lib = Path(td); labels = populate_library(lib)
    dm = DrumMatcher(); dm.build_index(lib)
    a_hat = next(p for p, g in labels.items() if g == "hat")
    hat_role = dm.index.roles[dm.index.paths.index(a_hat)]
    res = dm.query(a_hat, role=hat_role, k=10)
    check("role filter returns only that role", all(m.role_guess == hat_role for m in res) and len(res) > 0,
          f"role={hat_role} n={len(res)}")

# ── 6. warm query < 50 ms on a 5k index ──────────────────────────────────────
rng = np.random.default_rng(0)
big = SampleIndex()
D = 55
V = rng.standard_normal((5000, D)).astype(np.float32)
V /= np.linalg.norm(V, axis=1, keepdims=True)
big.vectors = V
big.paths = [f"s{i}.wav" for i in range(5000)]
big.roles = ["other"] * 5000
big.kinds = ["one_shot"] * 5000
qv = V[123]
t0 = time.perf_counter()
for _ in range(50):
    big._search(qv, None, 10, True)
ms = (time.perf_counter() - t0) / 50 * 1000
check("warm query < 50 ms on 5k index", ms < 50.0, f"{ms:.2f} ms")

# ── 7. match_into writes a §0 Recipe element ─────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    lib = Path(td); labels = populate_library(lib)
    dm = DrumMatcher(); dm.build_index(lib)
    kick_path = next(p for p, g in labels.items() if g == "kick")
    rec = R.Recipe(elements=[R.Element(element_id="k1", role="kick", audio_ref=kick_path)])
    dm.match_into(rec, "k1", k=5)
    sm = rec.elements[0].sample_match
    check("match_into set a status", sm.status in (R.SampleStatus.matched, R.SampleStatus.candidate),
          str(sm.status))
    check("match_into set matched_path", bool(sm.matched_path))
    check("match_into wrote alternates", len(sm.alternates) >= 1)
    check("matched recipe still round-trips", R.from_json(R.to_json(rec)) == rec)
    # missing audio_ref file → graceful (status none), never crashes (the §0 invariant)
    rec2 = R.Recipe(elements=[R.Element(element_id="g1", role="kick", audio_ref="/no/such/file.wav")])
    dm.match_into(rec2, "g1")
    check("match_into on a missing ref → none, no crash", rec2.elements[0].sample_match.status == R.SampleStatus.none)

# ── 808 vs kick role split (duration is the discriminator) ────────────────────
# punchy short low tone → kick; the same low pitch sustained → 808 (the rule that pulled
# 808s out of the kick/perc/other scatter on real libraries).
_kick = synth("kick", 1)                                            # 0.35 s low sine
_t = np.arange(int(1.4 * SR)) / SR                                  # sustained 1.4 s 808
_808 = (np.sin(2 * np.pi * 52 * _t) * np.exp(-_t / 0.9)).astype(np.float32)
_808 = (_808 / (np.max(np.abs(_808)) or 1.0) * 0.9).astype(np.float32)
check("short low tone → kick", classify_role(_kick, SR) == "kick", classify_role(_kick, SR))
check("sustained low tone → 808", classify_role(_808, SR) == "808", classify_role(_808, SR))
check("hat still classifies as hat", classify_role(synth("hat", 2), SR) == "hat", classify_role(synth("hat", 2), SR))
check("snare classifies as snare", classify_role(synth("snare", 3), SR) in ("snare", "clap"),
      classify_role(synth("snare", 3), SR))


# ── overlapping-loop-slice robustness (the polish target) ─────────────────────
# A sliced loop hit is a MIXTURE: a downbeat is kick+hat, a backbeat snare+hat, and the
# previous hit's tail bleeds in. The old single-centroid rule smeared all of these to
# "other" → one undifferentiated element. Band energies read them by their foundation.
def _mix(*parts: np.ndarray) -> np.ndarray:
    n = max(len(p) for p in parts)
    buf = np.zeros(n, np.float32)
    for p in parts:
        buf[: len(p)] += p
    return (buf / (np.max(np.abs(buf)) or 1.0) * 0.9).astype(np.float32)


_kick3, _snare3, _hat3, _clap3 = (synth("kick", 5), synth("snare", 6),
                                  synth("hat", 7), synth("clap", 8))
mixtures = {
    "kick+hat → kick": (_mix(_kick3, _hat3), "kick"),         # downbeat: read the low foundation
    "snare+hat → snare": (_mix(_snare3, _hat3), ("snare", "clap")),
    "808+hat → 808": (_mix(_808, _hat3), "808"),
}
for nm, (sig, want) in mixtures.items():
    got = classify_role(sig, SR)
    ok = got in want if isinstance(want, tuple) else got == want
    check(nm, ok, f"got {got}")
# the headline guarantee: NO real overlapping hit collapses to "other"
no_other = all(classify_role(s, SR) != "other"
               for s in (_mix(_kick3, _hat3), _mix(_snare3, _hat3), _mix(_808, _hat3),
                         _mix(_kick3, _hat3, _snare3), _mix(_clap3, _hat3)))
check("no overlapping mixture collapses to 'other'", no_other)
# a low-mid-dominant hit with only MODERATE sub must read perc, not kick/808 (the sub-dominance
# gate must compare against lowmid too — review finding: a tom/low-perc body at 250-800 Hz).
_t2 = np.arange(int(0.5 * SR)) / SR
_perc = ((0.40 * np.sin(2 * np.pi * 90 * _t2) + 0.70 * np.sin(2 * np.pi * 450 * _t2)) * np.exp(-3 * _t2)).astype(np.float32)
_perc = (_perc / (np.max(np.abs(_perc)) or 1.0) * 0.9).astype(np.float32)
check("low-mid-dominant + moderate-sub → not kick/808", classify_role(_perc, SR) not in ("kick", "808"),
      classify_role(_perc, SR))
# and a real silent/degenerate slice still → "other" (the only legitimate use of it)
check("silent slice → other", classify_role(np.zeros(SR // 4, np.float32), SR) == "other")
# deterministic x3 on a mixture (the repo's bar)
check("classify_role deterministic x3 on a mixture",
      len({classify_role(_mix(_kick3, _hat3), SR) for _ in range(3)}) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
