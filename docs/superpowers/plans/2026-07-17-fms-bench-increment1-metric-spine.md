# FMS-Bench Increment 1 — Metric Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `score_vocal(reference_wav, generated_wav) → stats` — one function that scores a generated vocal against a ground-truth human vocal on two axes (correctness + naturalness) — plus a pure aggregation/validity layer and a registered metric-validity gate, so we can prove the ruler before scaling any dataset.

**Architecture:** Thin adapter over the existing lab. `overlap.analyze()` already produces the entire correctness bundle (lag, onset F1, F0 register, silence leakage, phrases) as a pure list-in/dict-out call; `qa._pq()` already returns Audiobox PQ with graceful degradation. `score_vocal` points `original=clean_vocal`, `render=generated`, adds naturalness (pq + SingMOS-Pro) and lexical match against the *true* words, and reshapes into `{correctness, naturalness, meta}`. A pure `bench_metrics` layer aggregates and ranks good-vs-bad for the validity gate.

**Tech Stack:** Python 3.11 (stdlib + the lab's existing venvs). No new native/`--selftest` surface. Correctness venvs live locally (skeleton=FCPE/MMS_FA, nsf=pyin, whisper=ASR); naturalness (pq judges venv, new singmos venv) degrade to `None` when absent.

## Global Constraints

- Files live at `scripts/fms-killshot/bench_*.py` (flat siblings, so `import overlap`/`from skeleton import core` work as in the existing lab). New singmos venv lives at `~/Library/Mosh/venvs/singmos` (outside iCloud); its setup script + CLI go at `service/singmos/`.
- **Nothing touches `--selftest` or the native gate.** No C++, no `ui/` changes.
- Pure cores golden-tested **×3-deterministic** via the house `check()` + sha256-of-3-runs convention (mirror `overlap.py::main --selftest`).
- Naturalness is **graceful-degrade**: a missing venv yields `None`, never a crash (the real→fake posture).
- Datasets + generated artifacts **never in git**; only harness code + goldens are committed.
- Registered prediction is written **before** the validity smoke is run.
- Commit after each task with a `feat(fms-bench):` / `test(fms-bench):` subject and the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

### Task 1: Pure metric aggregation + good-vs-bad ranking (`bench_metrics.py`)

**Files:**
- Create: `scripts/fms-killshot/bench_metrics.py`
- Test: `scripts/fms-killshot/bench_metrics_test.py`

**Interfaces:**
- Produces:
  - `POLARITY: dict[str,str]` — per metric key, `"hi"` (higher better) or `"lo"` (lower-abs better).
  - `aggregate(stats_list: list[dict]) -> dict` → `{"n": int, "correctness": {key: mean}, "naturalness": {key: mean}}` (means over present numeric leaves, `None`/non-numeric skipped).
  - `ranks(good: dict, bad: dict) -> dict` → `{"correctness_ok": bool, "naturalness_ok": bool, "detail": {axis: {key: "good"|"bad"|"tie"}}}` (per axis: `ok` iff good wins a strict majority of comparable keys).

- [ ] **Step 1: Write the failing test**

```python
# scripts/fms-killshot/bench_metrics_test.py
import hashlib, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import bench_metrics as bm

fails = []
def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok: fails.append(name)

GOOD = {"correctness": {"onsets": {"f1": 0.9}, "f0": {"abs_median_st": 0.3},
                        "energy": {"render_in_take_silence_pct": 5.0}},
        "naturalness": {"pq": 6.5, "singmos": 4.1}}
BAD  = {"correctness": {"onsets": {"f1": 0.4}, "f0": {"abs_median_st": 3.0},
                        "energy": {"render_in_take_silence_pct": 40.0}},
        "naturalness": {"pq": 4.0, "singmos": 2.2}}

check("polarity: f1 higher-better", bm.POLARITY["f1"] == "hi")
check("polarity: abs_median_st lower-better", bm.POLARITY["abs_median_st"] == "lo")

agg = bm.aggregate([GOOD, BAD])
check("aggregate counts items", agg["n"] == 2)
check("aggregate means pq", abs(agg["naturalness"]["pq"] - 5.25) < 1e-9, str(agg["naturalness"]))
check("aggregate skips None", bm.aggregate([{"naturalness": {"pq": None}}, {"naturalness": {"pq": 4.0}}])
      ["naturalness"]["pq"] == 4.0)

r = bm.ranks(GOOD, BAD)
check("good beats bad on correctness", r["correctness_ok"] is True)
check("good beats bad on naturalness", r["naturalness_ok"] is True)
check("ranks is symmetric-false", bm.ranks(BAD, GOOD)["correctness_ok"] is False)

det = {hashlib.sha256(json.dumps(bm.ranks(GOOD, BAD), sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("ranks deterministic (3x)", len(det) == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/Library/Mosh/venvs/teardown/bin/python3 scripts/fms-killshot/bench_metrics_test.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'bench_metrics'`

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/fms-killshot/bench_metrics.py
"""Pure aggregation + good-vs-bad ranking over score_vocal() stats (no audio, no venvs)."""
from __future__ import annotations

# Direction each metric key improves. "hi" = higher is better; "lo" = smaller |value| is better.
POLARITY = {
    "f1": "hi", "precision": "hi", "recall": "hi",
    "median_abs_dt_ms": "lo", "global_lag_ms": "lo",
    "abs_median_st": "lo", "median_dsemitones": "lo", "octave_error_rate": "lo", "spread_st": "lo",
    "render_in_take_silence_pct": "lo", "take_in_render_silence_pct": "lo",
    "seq_ratio": "hi", "bag_coverage": "hi",
    "median_vowel_onset_delta_ms": "lo",
    "pq": "hi", "singmos": "hi",
}

def _leaves(d, out):
    """Flatten nested dicts to {key: numeric}; last-key wins, non-numeric/None skipped."""
    for k, v in (d or {}).items():
        if isinstance(v, dict):
            _leaves(v, out)
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = float(v)
    return out

def aggregate(stats_list):
    n = len(stats_list)
    acc = {"correctness": {}, "naturalness": {}}
    cnt = {"correctness": {}, "naturalness": {}}
    for s in stats_list:
        for axis in ("correctness", "naturalness"):
            for k, v in _leaves(s.get(axis), {}).items():
                acc[axis][k] = acc[axis].get(k, 0.0) + v
                cnt[axis][k] = cnt[axis].get(k, 0) + 1
    means = {axis: {k: round(acc[axis][k] / cnt[axis][k], 4) for k in acc[axis]}
             for axis in acc}
    return {"n": n, **means}

def _better(key, a, b):
    """Is `a` strictly better than `b` for `key`? None if incomparable."""
    pol = POLARITY.get(key)
    if pol is None:
        return None
    a2, b2 = (abs(a), abs(b)) if pol == "lo" else (a, b)
    if a2 == b2:
        return "tie"
    return "good" if a2 > b2 else "bad"

def ranks(good, bad):
    out = {"detail": {}}
    for axis in ("correctness", "naturalness"):
        ga, ba = _leaves(good.get(axis), {}), _leaves(bad.get(axis), {})
        detail, wins, comps = {}, 0, 0
        for k in sorted(set(ga) & set(ba)):
            v = _better(k, ga[k], ba[k])
            if v is None:
                continue
            detail[k] = v
            if v != "tie":
                comps += 1
                wins += 1 if v == "good" else 0
        out["detail"][axis] = detail
        out[f"{axis}_ok"] = comps > 0 and wins * 2 > comps
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/Library/Mosh/venvs/teardown/bin/python3 scripts/fms-killshot/bench_metrics_test.py`
Expected: PASS (all checks, "ALL PASS")

- [ ] **Step 5: Commit**

```bash
git add scripts/fms-killshot/bench_metrics.py scripts/fms-killshot/bench_metrics_test.py
git commit -m "feat(fms-bench): pure metric aggregation + good-vs-bad ranking

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Naturalness wrappers + SingMOS venv (`bench_naturalness.py`)

**Files:**
- Create: `scripts/fms-killshot/bench_naturalness.py`
- Create: `service/singmos/singmos_cli.py` (real model runner — a wav → `{"ok":true,"mos":float}`)
- Create: `service/singmos/setup-singmos.sh` (dedicated venv, graceful, writes `.singmos.env`)
- Test: `scripts/fms-killshot/bench_naturalness_test.py`

**Interfaces:**
- Consumes: `service/sa3/qa.py::_pq` / `_pq_of` (Task 0 — existing).
- Produces: `naturalness(wav: str, *, pq_fn=None, singmos_fn=None) -> dict` → `{"pq": float|None, "singmos": float|None}` (injectable back-ends for tests; defaults call the real reuse). `pq_score(wav)->float|None`, `singmos_score(wav)->float|None`.

- [ ] **Step 1: Write the failing test** (stubs — no real models needed for green)

```python
# scripts/fms-killshot/bench_naturalness_test.py
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import bench_naturalness as bn

fails = []
def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok: fails.append(name)

# injected back-ends → deterministic, no venv/model needed
got = bn.naturalness("x.wav", pq_fn=lambda w: 6.4, singmos_fn=lambda w: 4.2)
check("naturalness wires both scores", got == {"pq": 6.4, "singmos": 4.2}, str(got))

# absent back-ends degrade to None, never crash
none = bn.naturalness("x.wav", pq_fn=lambda w: None, singmos_fn=lambda w: None)
check("absent back-ends -> None", none == {"pq": None, "singmos": None}, str(none))

# a raising back-end is caught -> None (best-effort, never fails a benchmark row)
crash = bn.naturalness("x.wav", pq_fn=lambda w: (_ for _ in ()).throw(RuntimeError("boom")),
                       singmos_fn=lambda w: 3.0)
check("raising pq back-end -> None", crash == {"pq": None, "singmos": 3.0}, str(crash))

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/Library/Mosh/venvs/teardown/bin/python3 scripts/fms-killshot/bench_naturalness_test.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'bench_naturalness'`

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/fms-killshot/bench_naturalness.py
"""Naturalness scores for a generated vocal (human-likeness, NOT distance-to-reference).

pq   — Audiobox Production Quality, reused from service/sa3/qa.py (None if judges venv absent).
singmos — SingMOS-Pro singing MOS via service/singmos/singmos_cli.py (None if venv absent).
Both are best-effort: any failure returns None so a benchmark row never dies on naturalness.
"""
from __future__ import annotations
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

def pq_score(wav):
    try:
        sys.path.insert(0, os.path.join(REPO, "service"))
        from sa3 import qa
        scores = qa._pq([wav]) or {}
        return qa._pq_of(scores.get(wav))
    except Exception:
        return None

def _singmos_py():
    envf = os.path.join(REPO, "service/singmos/.singmos.env")
    if os.path.isfile(envf):
        for line in open(envf):
            if line.startswith("SINGMOS_PY="):
                return line.split("=", 1)[1].strip()
    cand = os.path.expanduser("~/Library/Mosh/venvs/singmos/bin/python3")
    return cand if os.path.isfile(cand) else None

def singmos_score(wav):
    py = _singmos_py()
    cli = os.path.join(REPO, "service/singmos/singmos_cli.py")
    if not py or not os.path.isfile(cli):
        return None
    try:
        out = subprocess.run([py, cli, wav], capture_output=True, text=True, timeout=120)
        res = json.loads(out.stdout or "{}")
        return float(res["mos"]) if res.get("ok") else None
    except Exception:
        return None

def naturalness(wav, *, pq_fn=None, singmos_fn=None):
    pq_fn = pq_fn or pq_score
    singmos_fn = singmos_fn or singmos_score
    def _safe(fn):
        try:
            v = fn(wav)
            return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
        except Exception:
            return None
    return {"pq": _safe(pq_fn), "singmos": _safe(singmos_fn)}
```

- [ ] **Step 4: Write the SingMOS CLI + setup (real path; gated, not run in tests)**

```python
# service/singmos/singmos_cli.py
"""SingMOS-Pro singing MOS for one wav → {"ok":true,"mos":float}. Requires the singmos venv."""
import json, sys
def main():
    wav = sys.argv[1]
    try:
        import torch, librosa  # noqa: F401
        predictor = torch.hub.load("South-Twilight/SingMOS:v0.2.0", "singing_ssl_mos", trust_repo=True)
        wave, sr = librosa.load(wav, sr=16000, mono=True)
        x = torch.from_numpy(wave).unsqueeze(0)
        length = torch.tensor([x.shape[1]])
        score = float(predictor(x, length).item())
        print(json.dumps({"ok": True, "mos": round(score, 4)}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:200]}))
if __name__ == "__main__":
    main()
```

```bash
# service/singmos/setup-singmos.sh  (mirror service/whisper/setup-whisper.sh; graceful)
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
VENV_ROOT="${MOSH_VENVS_DIR:-$HOME/Library/Mosh/venvs}"; VENV="$VENV_ROOT/singmos"; PY="$VENV/bin/python3"
if [[ ! -x "$PY" ]]; then
  mkdir -p "$VENV_ROOT"
  python3 -m venv "$VENV"; "$PY" -m pip install -q --upgrade pip
  "$PY" -m pip install -q torch torchaudio librosa "setuptools<81"
fi
"$PY" - <<'PY'
import torch, librosa  # noqa
print("  singmos imports ok")
PY
printf 'SINGMOS_PY=%s\n' "$PY" > .singmos.env
echo "✓ singmos venv ready ($PY)"
```

- [ ] **Step 5: Run test to verify it passes** (uses stubs; real venv NOT required)

Run: `~/Library/Mosh/venvs/teardown/bin/python3 scripts/fms-killshot/bench_naturalness_test.py`
Expected: PASS ("ALL PASS")

- [ ] **Step 6: Commit**

```bash
git add scripts/fms-killshot/bench_naturalness.py scripts/fms-killshot/bench_naturalness_test.py service/singmos/
git commit -m "feat(fms-bench): naturalness wrappers (pq reuse + SingMOS venv), graceful-degrade

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `score_vocal` adapter (`bench_score.py`)

**Files:**
- Create: `scripts/fms-killshot/bench_score.py`
- Test: `scripts/fms-killshot/bench_score_test.py`

**Interfaces:**
- Consumes: `overlap.analyze` (existing), `bench_naturalness.naturalness` (Task 2), `overlap.word_match` (existing).
- Produces: `score_vocal(reference_wav, generated_wav, *, score_clip=None, true_words=None, deps=None) -> dict` → `{"correctness": {...}, "naturalness": {"pq":…, "singmos":…}, "meta": {...}}`. `deps` is an injectable dict `{"read","f0","analyze","naturalness","asr"}` for hermetic tests; defaults wire the real lab.

- [ ] **Step 1: Write the failing test** (inject `deps` → no audio/venvs)

```python
# scripts/fms-killshot/bench_score_test.py
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import bench_score as bs

fails = []
def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok: fails.append(name)

# fake lab: read returns (mono,sr), f0 returns [], analyze returns a canned correctness bundle
CORR = {"global_lag_ms": 12.0, "onsets": {"f1": 0.8}, "energy": {"render_in_take_silence_pct": 6.0},
        "f0": {"abs_median_st": 0.4, "octave_error_rate": 0.0}}
deps = {
    "read": lambda p: ([0.0, 0.1], 44100),
    "f0":   lambda mono, sr: [],
    "analyze": lambda ref, sr_r, gen, sr_g, f0r, f0g, clip: dict(CORR),
    "naturalness": lambda wav: {"pq": 6.1, "singmos": 4.0},
    "asr":  lambda wav: ["hold", "the", "flame"],
}
st = bs.score_vocal("clean.wav", "gen.wav", true_words=["hold", "the", "flame"], deps=deps)
check("has correctness axis", "onsets" in st["correctness"], str(st["correctness"].keys()))
check("has naturalness axis", st["naturalness"] == {"pq": 6.1, "singmos": 4.0}, str(st["naturalness"]))
check("word-match vs TRUE words", st["correctness"]["words"]["bag_coverage"] == 1.0, str(st["correctness"].get("words")))
check("meta names files", st["meta"]["reference"] == "clean.wav" and st["meta"]["generated"] == "gen.wav")

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/Library/Mosh/venvs/teardown/bin/python3 scripts/fms-killshot/bench_score_test.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'bench_score'`

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/fms-killshot/bench_score.py
"""score_vocal(reference, generated) -> {correctness, naturalness, meta}.

Thin adapter over the lab: overlap.analyze() carries the correctness bundle (point
original=reference/clean, render=generated); naturalness scores the generated alone;
word_match is against the dataset's TRUE words (ground truth), not the score's words.
`deps` injects the lab back-ends so tests run with zero audio/venvs.
"""
from __future__ import annotations
import os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

def _real_deps():
    import overlap, bench_naturalness, diagnose
    from skeleton import core as skcore  # noqa: F401
    def read(path):
        with tempfile.TemporaryDirectory() as td:
            mono, sr, _wav = overlap._read_mono(path, td)
        return mono, sr
    def f0(mono, sr):
        # dense pyin voicing/F0 via the nsf venv probe (as overlap.main does)
        py = os.path.expanduser(os.environ.get("NSF_PY", "~/Library/Mosh/venvs/nsf/bin/python3"))
        probe = os.path.join(HERE, "pyin_probe.py")
        if not (os.path.isfile(py) and os.path.isfile(probe)):
            return None
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            import wave, struct
            w = wave.open(f.name, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
            w.writeframes(b"".join(struct.pack("<h", int(max(-32767, min(32767, x*32767)))) for x in mono)); w.close()
            r = diagnose._run_json(py, probe, f.name)
        return [{"t": t, "hz": hz} for t, hz, _v in r.get("frames", [])] if r.get("ok") else None
    def asr(wav):
        wp = diagnose._venv_python("whisper/.whisper.env", "WHISPER_PY")
        if not wp:
            return None
        cli = os.path.join(os.path.dirname(HERE), "service/whisper/whisper_cli.py")
        r = diagnose._run_json(wp, cli, wav, "small")
        return [w.get("word", "").strip() for w in r.get("words", [])] if r.get("ok") else None
    return {"read": read, "f0": f0, "analyze": overlap.analyze,
            "naturalness": bench_naturalness.naturalness, "asr": asr}

def score_vocal(reference_wav, generated_wav, *, score_clip=None, true_words=None, deps=None):
    d = deps or _real_deps()
    ref, sr_r = d["read"](reference_wav)
    gen, sr_g = d["read"](generated_wav)
    f0_ref = d["f0"](ref, sr_r)
    f0_gen = d["f0"](gen, sr_g)
    correctness = dict(d["analyze"](ref, sr_r, gen, sr_g, f0_ref, f0_gen, score_clip))
    if true_words:
        import overlap
        aw = d["asr"](generated_wav)
        if aw is not None:
            correctness["words"] = overlap.word_match(true_words, aw)
    return {"correctness": correctness,
            "naturalness": d["naturalness"](generated_wav),
            "meta": {"reference": os.path.basename(reference_wav),
                     "generated": os.path.basename(generated_wav),
                     "sr": {"reference": sr_r, "generated": sr_g}}}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/Library/Mosh/venvs/teardown/bin/python3 scripts/fms-killshot/bench_score_test.py`
Expected: PASS ("ALL PASS")

- [ ] **Step 5: Commit**

```bash
git add scripts/fms-killshot/bench_score.py scripts/fms-killshot/bench_score_test.py
git commit -m "feat(fms-bench): score_vocal adapter (overlap.analyze + naturalness + true-word match)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Metric-validity gate + registered prediction (`bench_validity.py`)

**Files:**
- Create: `scripts/fms-killshot/bench_validity.py`
- Test: `scripts/fms-killshot/bench_validity_test.py`
- Create (registered prediction, committed): `docs/superpowers/specs/2026-07-17-fms-bench-metric-validity-prediction.md`

**Interfaces:**
- Consumes: `bench_score.score_vocal` (Task 3), `bench_metrics.ranks` / `aggregate` (Task 1).
- Produces: `validity_verdict(reference, good, bad, *, deps=None) -> dict` → `{"ranks": {...}, "pass": bool}`; CLI `bench_validity.py --reference R --good G --bad B [--out DIR]`.

- [ ] **Step 1: Write the failing test** (inject a fake score_vocal → deterministic)

```python
# scripts/fms-killshot/bench_validity_test.py
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import bench_validity as bv

fails = []
def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok: fails.append(name)

def fake_score(ref, gen, **kw):
    good = gen.endswith("good.wav")
    return {"correctness": {"onsets": {"f1": 0.9 if good else 0.4},
                            "f0": {"abs_median_st": 0.3 if good else 3.0}},
            "naturalness": {"pq": 6.5 if good else 4.0, "singmos": 4.1 if good else 2.0}}

v = bv.validity_verdict("ref.wav", "good.wav", "bad.wav", deps={"score_vocal": fake_score})
check("gate PASSES when good beats bad on both axes", v["pass"] is True, str(v))
check("verdict records per-axis ranks", v["ranks"]["correctness_ok"] and v["ranks"]["naturalness_ok"])

v2 = bv.validity_verdict("ref.wav", "bad.wav", "good.wav", deps={"score_vocal": fake_score})
check("gate FAILS when 'good' is actually worse", v2["pass"] is False, str(v2))

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/Library/Mosh/venvs/teardown/bin/python3 scripts/fms-killshot/bench_validity_test.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'bench_validity'`

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/fms-killshot/bench_validity.py
"""Metric-validity gate: does score_vocal rank a known-GOOD render above a known-BAD one?
This is the ruler-check that earns the benchmark the right to gate real pipeline changes.
"""
from __future__ import annotations
import argparse, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import bench_metrics as bm

def validity_verdict(reference, good, bad, *, deps=None):
    score = (deps or {}).get("score_vocal")
    if score is None:
        import bench_score
        score = bench_score.score_vocal
    g = score(reference, good)
    b = score(reference, bad)
    r = bm.ranks(g, b)
    return {"ranks": r, "pass": bool(r["correctness_ok"] and r["naturalness_ok"]),
            "good": g, "bad": b}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", required=True)
    ap.add_argument("--good", required=True)
    ap.add_argument("--bad", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()
    v = validity_verdict(a.reference, a.good, a.bad)
    print(json.dumps(v, indent=1, sort_keys=True))
    if a.out:
        os.makedirs(a.out, exist_ok=True)
        json.dump(v, open(os.path.join(a.out, "validity.json"), "w"), indent=1, sort_keys=True)
    return 0 if v["pass"] else 1

if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/Library/Mosh/venvs/teardown/bin/python3 scripts/fms-killshot/bench_validity_test.py`
Expected: PASS ("ALL PASS")

- [ ] **Step 5: Write the registered prediction (BEFORE the real smoke)**

Create `docs/superpowers/specs/2026-07-17-fms-bench-metric-validity-prediction.md` with, verbatim, the registered predictions:
1. Build a synthetic sanity triple under `~/mosh-fms-ksb/bench/sanity/` (NOT git): `reference.wav` = a clean 3-note sung-ish tone with rests; `good.wav` = reference + −40 dB noise; `bad.wav` = reference transposed +3 semitones and shifted +150 ms.
2. **Prediction:** `bench_validity.py --reference reference.wav --good good.wav --bad bad.wav` returns `pass: true` — good beats bad on correctness (higher onset f1, lower f0 `abs_median_st`) and (if the judges/singmos venvs are present) naturalness; and the verdict JSON is byte-identical across 3 runs.
3. **Falsifier:** if `pass` is false, or good does not beat bad on onset f1 / f0 abs_median_st, the ruler is not trustworthy — stop and fix `score_vocal` before any dataset work.
4. Owner-gated remainder: axis (b) of the metric-validity gate — agreement with the owner's ear on the real self-recorded pairs — is deferred until those pairs exist.

- [ ] **Step 6: Run the real synthetic-sanity smoke, record the verdict**

Generate the sanity triple (a short Python script using `wave`/`struct`, or reuse `overlap._selftest`'s tone helper) under `~/mosh-fms-ksb/bench/sanity/`, then:

Run: `~/Library/Mosh/venvs/teardown/bin/python3 scripts/fms-killshot/bench_validity.py --reference ~/mosh-fms-ksb/bench/sanity/reference.wav --good ~/mosh-fms-ksb/bench/sanity/good.wav --bad ~/mosh-fms-ksb/bench/sanity/bad.wav --out ~/mosh-fms-ksb/bench/sanity`
Expected: `"pass": true`; append the actual numbers + PASS/FAIL to the prediction doc as the verdict.

- [ ] **Step 7: Commit**

```bash
git add scripts/fms-killshot/bench_validity.py scripts/fms-killshot/bench_validity_test.py docs/superpowers/specs/2026-07-17-fms-bench-metric-validity-prediction.md
git commit -m "feat(fms-bench): metric-validity gate + registered prediction & synthetic-sanity verdict

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes
- **Spec coverage:** covers staging item 1 (metric spine + validity gate + registered prediction). Real-pairs anchor (spec §E) axis (b) is explicitly owner-gated and deferred; the harness accepts it later via the same `ranks`. Mumble synthesizer / datasets / scoreboard are increments 2–3 (separate plans).
- **Hermetic:** every `*_test.py` runs with the teardown venv and injected deps/stubs — no models, no network, no `--selftest` impact.
- **Type consistency:** `score_vocal` → `{correctness, naturalness, meta}`; `aggregate`/`ranks` consume exactly that shape; `naturalness()` returns `{"pq","singmos"}` used identically in Tasks 2–4.
- **Determinism:** pure layers sha256-pinned ×3; the only nondeterminism (F0/ASR models) is outside the golden suite, in the real smoke.

## Verification (increment 1 exit)
- `bench_metrics_test.py`, `bench_naturalness_test.py`, `bench_score_test.py`, `bench_validity_test.py` all PASS (run each ×3 → identical).
- Registered prediction written before the smoke; synthetic-sanity `bench_validity.py` returns `pass: true`, verdict recorded, deterministic ×3.
- Existing lab suites green ×3 (`overlap.py --selftest`, soulx/skeleton/lyrics goldens); `--selftest` untouched (no C++/ui).
