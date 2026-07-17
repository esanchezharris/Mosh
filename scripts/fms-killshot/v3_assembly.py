#!/usr/bin/env python3
"""V3 of the mechanism-verify spec: the assembly ablation. Isolates the stage-5 snap
machinery — motivated twice: V0-S3 (snapped output measured +30…50ms later-and-more-
squeezed than the raw chunk renders) and V2's residual gap (oracle durations beat the
baseline blind but still read synthetic).

ONE plain-sum assembly of the existing u2 chunk renders is pushed through stage 5 three
ways, using the PRODUCT functions (`service/soulx/perform.py`) so the only variable is the
snap stage itself:
  N  no snap          — the plain sum (renders are self-placed; assembly is addition)
  P  phrase-snap only — phrase_shifts + apply_shifts (±250ms, seams at phrase edges)
  W  full snap        — snap_render_to_take (phrase snap + per-word snap_to_events,
                        ±120ms with 10ms crossfades at every word event)

Two judge windows are sliced from each arm (the V1/V2 line windows), level-matched
(RMS 0.08, peak-safe), independently blind-shuffled, and served as a listen page. NO NSF —
re-vocoding could mask or add artifacts; raw assemblies isolate the micro-edit variable.

Usage (base python3, from scripts/fms-killshot/):
  python3 v3_assembly.py [--out ~/mosh-fms-ksb/used2/asserted-proof/mechanism/v3]
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import random
import struct
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

from skeleton import core as skcore          # noqa: E402
from soulx import perform as sp              # noqa: E402
from soulx.score import phrase_windows, word_event_spans  # noqa: E402

ROOT = os.path.expanduser("~/mosh-fms-ksb/used2")
TAKE = os.path.join(ROOT, "asserted-proof", "fresh", "u2-full-mumble.wav")
ASSEMBLED_REF = os.path.join(ROOT, "asserted-proof", "fresh", "u2-full-assembled.wav")
CLIP = os.path.join(ROOT, "fresh-render", "audit", "u2-full-score.json")
MANIFEST = os.path.join(ROOT, "fresh-render", "u2-full-manifest.json")
RENDER_PAT = os.path.join(ROOT, "asserted-proof", "voice-soulx-{name}.wav")

WINDOWS = [("line2", 1.02, 3.90), ("line1", 37.925, 41.285)]
PAD_S = 0.75
TARGET_RMS = 0.08


def read_mono(path):
    r = skcore.read_pcm_mono(path)
    if not r:
        raise RuntimeError(f"not stdlib-readable: {path}")
    return r


def write_wav(path, xs, sr):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(xs)}h",
                                  *(max(-32767, min(32767, int(v * 32767))) for v in xs)))


def plain_sum(sr_out, total_s):
    """Sum the self-placed chunk renders (24k -> take rate). Assembly is plain addition —
    the renders carry their own leading-silence placement (the documented convention)."""
    with open(MANIFEST) as f:
        manifest = json.load(f)
    out = [0.0] * int(total_s * sr_out)
    for ch in manifest["chunks"]:
        mono, sr = read_mono(RENDER_PAT.format(name=ch["name"]))
        if sr != sr_out:
            mono = sp.resample_linear(mono, sr, sr_out)
        for i, v in enumerate(mono):
            if i < len(out):
                out[i] += v
    peak = max(abs(v) for v in out)
    if peak > 0.99:
        out = [v / peak * 0.97 for v in out]
    return out


def corr(a, b):
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    ma, mb = sum(a) / n, sum(b) / n
    a = [x - ma for x in a]
    b = [x - mb for x in b]
    da = math.sqrt(sum(x * x for x in a))
    db = math.sqrt(sum(x * x for x in b))
    return sum(x * y for x, y in zip(a, b)) / (da * db) if da and db else 0.0


def slice_norm(xs, sr, a, b):
    seg = xs[int(a * sr):int(b * sr)]
    rms = math.sqrt(sum(v * v for v in seg) / len(seg)) if seg else 0.0
    if rms <= 0:
        return seg
    g = TARGET_RMS / rms
    peak = max(abs(v) for v in seg) * g
    if peak > 0.97:
        g *= 0.97 / peak
    return [v * g for v in seg]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "asserted-proof", "mechanism", "v3"))
    args = ap.parse_args()
    out_dir = os.path.abspath(os.path.expanduser(args.out))
    os.makedirs(out_dir, exist_ok=True)

    take, sr = read_mono(TAKE)
    total_s = len(take) / sr
    with open(CLIP) as f:
        clips = json.load(f)
    clip = clips[0] if isinstance(clips, list) else clips

    print("assembling arm N (plain sum)", flush=True)
    arm_n = plain_sum(sr, total_s)
    ref, ref_sr = read_mono(ASSEMBLED_REF)
    if ref_sr == sr:
        c = corr(arm_n, ref)
        print(f"  provenance check vs u2-full-assembled.wav: corr {c:.3f}", flush=True)
        if c < 0.95:
            raise RuntimeError(f"plain-sum rebuild diverges from the lab assembly (corr {c:.3f})")

    print("arm P (phrase-snap only)", flush=True)
    windows = phrase_windows(clip)
    env_t = sp.energy_envelope(take, sr, hop_ms=10.0)
    env_n = sp.energy_envelope(arm_n, sr, hop_ms=10.0)
    shifts = sp.phrase_shifts(env_t, env_n, windows)
    arm_p = sp.apply_shifts(arm_n, sr, windows, shifts, total_s=total_s)

    print("arm W (full snap: phrase + per-word)", flush=True)
    arm_w = sp.snap_render_to_take(take, arm_n, sr, clip)

    arms = {"nosnap": arm_n, "phrase": arm_p, "word": arm_w}
    diag = {"phrase_shifts_ms": [round(s * 1000, 1) for s in shifts],
            "n_windows": len(windows), "n_word_events": len(word_event_spans(clip))}
    for name, xs in arms.items():
        write_wav(os.path.join(out_dir, f"arm-{name}.wav"), xs[:len(take)], sr)
        diag[f"env_corr_{name}"] = round(sp.env_corr(take, xs[:len(take)], sr), 3)

    # blind clips per judge window (independent shuffles)
    labels, groups_html = {}, ""
    for wname, a, b in WINDOWS:
        entries = []
        for name, xs in arms.items():
            seg = slice_norm(xs, sr, max(0.0, a - PAD_S), b + PAD_S)
            p = os.path.join(out_dir, f"src-{wname}-{name}.wav")
            write_wav(p, seg, sr)
            entries.append((name, p))
        seed = hashlib.sha256((wname + "".join(
            f"{p}:{os.path.getsize(p)}" for _n, p in sorted(entries))).encode()).hexdigest()
        random.Random(seed).shuffle(entries)
        cards = ""
        labels[wname] = {}
        for lab, (name, p) in zip("ABC", entries):
            blind = os.path.join(out_dir, f"{wname}-clip-{lab}.wav")
            os.replace(p, blind)
            labels[wname][lab] = name
            cards += (f"<div class='card'><h2>{html.escape(wname)} — clip {lab}</h2>"
                      f"<audio controls preload='none' src='{html.escape(os.path.basename(blind))}'></audio></div>")
        groups_html += f"<h1 class='grp'>{html.escape(wname)}</h1>{cards}"

    with open(os.path.join(out_dir, "v3-labels.json"), "w") as f:
        json.dump({"labels": labels}, f, indent=1)
    with open(os.path.join(out_dir, "v3-metrics.json"), "w") as f:
        json.dump(diag, f, indent=1)

    page = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>V3 assembly ablation — blind listen</title>
<style>
 :root{{color-scheme:dark}}
 body{{margin:0;background:#0f1116;color:#e8ebf3;font:15px/1.45 -apple-system,system-ui,sans-serif}}
 .wrap{{max-width:840px;margin:0 auto;padding:34px 18px 64px}}
 .card{{background:#16181f;border:1px solid #252934;border-radius:16px;padding:16px 18px;margin:0 0 16px}}
 h1{{margin:0 0 4px;font-size:24px}} h1.grp{{font-size:18px;margin:22px 0 10px}}
 h2{{margin:0 0 8px;font-size:16px}}
 .sub{{margin:0 0 16px;color:#9097a7;font-size:13px}}
 audio{{width:100%;margin:4px 0 10px}}
</style></head><body><div class="wrap">
  <h1>V3 — assembly ablation, blind</h1>
  <p class="sub">Two passages, each in three stage-5 variants (random order per passage,
  level-matched, no NSF). For each passage: which clip sounds most natural / least
  processed, and which least? Rank A/B/C per passage. Do not open v3-labels.json until
  you have ranked both.</p>
  {groups_html}
</div></body></html>"""
    ppath = os.path.join(out_dir, "v3-listen.html")
    with open(ppath, "w") as f:
        f.write(page)
    print(json.dumps({"ok": True, "page": ppath, "metrics": diag}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
