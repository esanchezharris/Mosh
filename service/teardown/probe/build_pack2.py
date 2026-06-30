#!/usr/bin/env python3
"""Build the v2 BLIND rating pack — taste, not brokenness.

Four sources (owner-selected), all on-grid / in-key / clean so ratings measure TASTE:
  • gold       — the owner's own beats (audio)          → ground-truth "fire"
  • auto       — real-kit + 808 bassline + melodic loop (program) → competent middle
  • degraded   — auto with ONE subtle, in-time flaw (program)     → tasteful-worse low end
  • sa3        — Stable-Audio-3 loops (audio, GATED; skipped gracefully if unwired)

Program candidates render via Oracle with a HEADROOM RETRY (re-render at lower gain if the raw
peak clips — a clipping "good" beat would sound bad yet score clean, a confound). Audio candidates
are scored directly. Every clip is loudness-normalized to the reward's target RMS (so the owner and
the reward judge the same signal). Emits a randomized blind pack + a private mapping + cross-source
A/B pairs (gold-vs-auto, auto-vs-degraded, gold-vs-degraded) — the direct "does the reward agree
your gold > auto > degraded?" test.

  TEARDOWN_PY build_pack2.py --out ~/mosh-reward-probe [--limit N]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import probe_score                       # noqa: E402
import gold, beats, degrade, sa3_gen     # noqa: E402

SHUFFLE_SEED = 20260629


def lower_volumes(prog: list, db: float) -> list:
    out = []
    for c in prog:
        if c.get("command") == "set_track_volume":
            c = {**c, "args": {**c["args"], "db": c["args"]["db"] - db}}
        out.append(c)
    return out


def render_program_headroom(oracle, reward, program, session) -> dict:
    """Render; if the raw peak clips, re-render at lower gain (real fix — array-attenuation can't
    undo baked clipping). Up to 2 retries (−4, −8 dB)."""
    last = None
    for trim in (0.0, 4.0, 8.0):
        r = probe_score.render_and_score(oracle, reward, lower_volumes(program, trim) if trim else program,
                                         session=f"{session}_{int(trim)}")
        last = r
        if not r.get("ok"):
            return r
        if r["peak"] < 0.985:
            r["trim_db"] = trim
            return r
    last["trim_db"] = 8.0
    last["clipped"] = True
    return last


def score_audio_file(reward, wav: str) -> dict:
    y, sr = sf.read(wav, dtype="float32", always_2d=True)
    y = y.mean(axis=1).astype(np.float32)
    if sr != 44100:  # gold/sa3 are pre-resampled, but be safe
        n = int(round(y.shape[0] * 44100 / sr))
        y = np.interp(np.linspace(0, y.shape[0] - 1, n), np.arange(y.shape[0]), y).astype(np.float32)
        sr = 44100
    scores = reward.score_audio(y, sr)
    return {"ok": True, "y": y, "sr": sr,
            "pq": round(float(scores.get("pq", 0.0)), 4), "clean": round(float(scores.get("clean", 1.0)), 4),
            "pull": round(float(scores["pull"]), 6) if "pull" in scores else None,
            "composite": round(float(reward.composite(scores)), 6),
            "rms": round(float(np.sqrt((y ** 2).mean())), 5), "peak": round(float(np.abs(y).max()), 5)}


def cross_source_pairs(by_intent: dict, rng) -> list[dict]:
    """Pairs that test the reward's ordering across taste tiers."""
    pairs = []

    def add(a, b, meta):
        if a and b:
            pairs.append({"A": a, "B": b, "_meta": meta})
    g, a, d = by_intent.get("gold", []), by_intent.get("auto", []), [v for k, v in by_intent.items() if k.startswith("deg")]
    d = [x for sub in d for x in sub]
    rng.shuffle(g); rng.shuffle(a); rng.shuffle(d)
    for i in range(min(5, len(g), len(a))):
        add(g[i], a[i], "gold vs auto")
    for i in range(min(5, len(a), len(d))):
        add(a[i], d[i], "auto vs degraded")
    for i in range(min(4, len(g), len(d))):
        add(g[-1 - i] if len(g) > i else None, d[-1 - i] if len(d) > i else None, "gold vs degraded")
    return pairs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-reward-probe"))
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    out = Path(a.out)
    clips = out / "clips"
    clips.mkdir(parents=True, exist_ok=True)

    cands = gold.build_gold() + beats.build_auto() + degrade.build_degraded() + sa3_gen.build_sa3()
    if a.limit:
        cands = cands[: a.limit]
    from collections import Counter
    print(f"[probe2] {len(cands)} candidates: {dict(Counter(c['intent'] for c in cands))}", flush=True)

    oracle, reward, info = probe_score.make_engine(range_s=10.0)
    print(f"[probe2] reward: {info}", flush=True)

    scored, fails = [], []
    for i, c in enumerate(cands):
        if c["kind"] == "audio":
            try:
                r = score_audio_file(reward, c["wav"])
            except Exception as e:
                r = {"ok": False, "error": f"audio_load_fail: {str(e)[:120]}"}
        else:
            r = render_program_headroom(oracle, reward, c["program"], session=f"p2_{c['cand_id']}")
        if not r.get("ok"):
            fails.append({"cand_id": c["cand_id"], "error": r.get("error")})
            print(f"  [{i+1}/{len(cands)}] {c['cand_id']:30s} FAIL {r.get('error')}", flush=True)
            continue
        flag = " CLIP" if r.get("clipped") else (f" trim{int(r['trim_db'])}" if r.get("trim_db") else "")
        scored.append({**{k: c[k] for k in ("cand_id", "group", "label", "intent")},
                       "pq": r["pq"], "clean": r["clean"], "pull": r["pull"], "composite": r["composite"],
                       "rms": r["rms"], "peak": r["peak"], "y": r["y"], "sr": r["sr"]})
        print(f"  [{i+1}/{len(cands)}] {c['cand_id']:30s} {c['intent']:8s} ok comp={r['composite']:.3f} "
              f"(pull={r['pull']:.3f} pq={r['pq']:.2f} clean={r['clean']:.2f}){flag}", flush=True)

    if not scored:
        print("[probe2] nothing scored — abort.", flush=True)
        return 1

    rng = random.Random(SHUFFLE_SEED)
    order = list(range(len(scored)))
    rng.shuffle(order)
    mapping, by_intent = {}, {}
    for new_i, si in enumerate(order, start=1):
        s = scored[si]
        idx = f"{new_i:03d}"
        yn = probe_score.normalize_for_listening(reward, s["y"], s["sr"])
        sf.write(str(clips / f"{idx}.wav"), yn, s["sr"], subtype="PCM_16")
        mapping[idx] = {k: s[k] for k in ("cand_id", "group", "label", "intent",
                                          "pq", "clean", "pull", "composite", "rms", "peak")}
        by_intent.setdefault(s["intent"], []).append(idx)

    (out / "RATINGS.csv").write_text("index,rating,notes\n" + "".join(f"{i},,\n" for i in sorted(mapping)))
    ab = cross_source_pairs(by_intent, random.Random(SHUFFLE_SEED + 1))
    (out / "AB_PAIRS.csv").write_text("pair,A,B,winner\n" + "".join(f"{k},{p['A']},{p['B']},\n" for k, p in enumerate(ab, 1)))
    (out / ".ab_public.json").write_text(json.dumps([{"pair": k, "A": p["A"], "B": p["B"]} for k, p in enumerate(ab, 1)], indent=1))
    (out / ".mapping.json").write_text(json.dumps(
        {"mapping": mapping, "ab_pairs": ab, "fails": fails, "reward_version": info.get("version")}, indent=1))
    (out / "README.txt").write_text(
        "MOSH REWARD-VALIDITY PROBE v2 — blind rating pack\n"
        "==================================================\n\n"
        f"{len(mapping)} short (~10s) loops in clips/ (001..{max(mapping)}.wav), RANDOM order.\n"
        "These are all competent, in-time, in-key beats from real drums/808s + your own beats —\n"
        "the differences are about TASTE, not whether they're broken. Loudness-matched: judge music.\n\n"
        "1) RATINGS.csv — rate each index 1 (worst) .. 7 (best) musical quality. Optional notes.\n"
        "2) AB_PAIRS.csv — for each pair, write A or B (which sounds musically better).\n"
        "Open index.html to rate in the browser. Don't open .mapping.json (hidden scores).\n")

    print(f"\n[probe2] WROTE {len(mapping)} clips → {clips}", flush=True)
    print(f"[probe2] by source: {dict(Counter(m['intent'] for m in mapping.values()))}", flush=True)
    print(f"[probe2] fails: {len(fails)} {[f['cand_id'] for f in fails][:6]}", flush=True)
    clipped = [i for i, m in mapping.items() if m["peak"] >= 0.99]
    comps = [m["composite"] for m in mapping.values()]
    pulls = [m["pull"] for m in mapping.values() if m["pull"] is not None]
    print(f"[probe2] clipped-after-retry: {len(clipped)} | composite {min(comps):.3f}..{max(comps):.3f} | "
          f"pull {min(pulls):.3f}..{max(pulls):.3f} (spread {max(pulls)-min(pulls):.3f})", flush=True)
    # honest aggregate: mean pull/composite per source (NOT per-clip → no rating bias)
    for it in sorted(by_intent):
        ids = by_intent[it]
        mp = sum(mapping[i]["pull"] or 0 for i in ids) / len(ids)
        mc = sum(mapping[i]["composite"] for i in ids) / len(ids)
        print(f"           {it:9s} n={len(ids):2d}  mean pull={mp:.3f}  mean composite={mc:.3f}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
