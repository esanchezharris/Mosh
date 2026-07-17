#!/usr/bin/env python3
"""V4b of the mechanism-verify spec: does note_type=3 slur actually work (upstream
issue-#37 risk)? Gates whether melisma is available to the B2 lyric fix at all.

Three minimal clips, rendered through the IDENTICAL local MLX score-mode arm
(local_sing_render.sh's exact invocation, own-30s ref):
  M0  control — 'say' re-attacked on two notes (type 2/2, full en_S-EY1 both): MUST show
      an unvoiced gap at the boundary (the re-attacked /s/).
  M1  slur    — 'say' held across two notes +3 st (type 2→3, continuation = held vowel
      en_EY1 per soulx.score._held_vowel).
  M2  slur    — same, −4 st.

Registered pass criteria (design doc §5): (1) M1/M2 voicing continuous across the note
boundary (no unvoiced gap > 30ms within ±100ms of it) while M0 SHOWS a gap; (2) pitch step
within ±1 st of commanded between note-half medians; (3) rendered length within ±10%.
Measured with pyin (pyin_probe.py) — never ear alone; a listen page is emitted for the ear
confirmation on top.

Usage (base python3, from scripts/fms-killshot/):
  python3 melisma_probe.py [--out ~/mosh-fms-ksb/used2/asserted-proof/mechanism/v4/melisma]
                           [--measure-only]
"""
from __future__ import annotations

import argparse
import html
import json
import math
import os
import subprocess
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

MAC = os.path.expanduser(os.environ.get("SOULX_MAC_DIR", "~/AI/soulx-mac"))
BRIDGE = os.path.join(MAC, "SoulX-Singer-MLX")
PY = os.path.join(MAC, "venv", "bin", "python")
HANDOFF = os.path.expanduser("~/mosh-fms-ksb/used2/asserted-proof/back-half/sing-handoff")
REF = os.path.join(HANDOFF, "refs", "own-30s.wav")
REF_META = os.path.join(HANDOFF, "refs", "own-30s.json")
NSF_PY = os.path.expanduser(os.environ.get("NSF_PY", "~/Library/Mosh/venvs/nsf/bin/python3"))

REST = 0.5
NOTE = 0.6
BOUNDARY = REST + NOTE          # 1.1s
TOTAL = REST + 2 * NOTE + REST  # 2.2s


def clip(name, phon2, type2, p1, p2):
    return [{
        "index": f"{name}_0_{int(TOTAL * 1000)}",
        "language": "English",
        "time": [0, int(TOTAL * 1000)],
        "duration": f"{REST:.4f} {NOTE:.4f} {NOTE:.4f} {REST:.4f}",
        "text": "<SP> say say <SP>",
        "phoneme": f"<SP> en_S-EY1 {phon2} <SP>",
        "note_pitch": f"0 {p1} {p2} 0",
        "note_type": f"1 2 {type2} 1",
    }]


CLIPS = {
    "m0-reattack": clip("m0-reattack", "en_S-EY1", 2, 57, 60),
    "m1-slur-up3": clip("m1-slur-up3", "en_EY1", 3, 57, 60),
    "m2-slur-dn4": clip("m2-slur-dn4", "en_EY1", 3, 62, 58),
}
COMMANDED_ST = {"m0-reattack": 3.0, "m1-slur-up3": 3.0, "m2-slur-dn4": -4.0}


def render(name, score_path, out_wav):
    outd = os.path.join(MAC, "renders", f"probe-{name}")
    os.makedirs(outd, exist_ok=True)
    env = dict(os.environ, PYTHONPATH=BRIDGE, PYTORCH_ENABLE_MPS_FALLBACK="1")
    cmd = [PY, os.path.join(BRIDGE, "scripts", "inference_mlx_bridge.py"),
           "--model", "models/SoulX-Singer-bf16", "--component", "svs",
           "--control", "score", "--device", "mps",
           "--prompt_wav_path", REF, "--prompt_metadata_path", REF_META,
           "--target_metadata_path", score_path,
           "--phoneset_path", "soulxsinger/utils/phoneme/phone_set.json",
           "--n_steps", "32", "--cfg", "3.0", "--pitch_shift", "0", "--save_dir", outd]
    log = os.path.join(outd, "render.log")
    with open(log, "w") as lf:
        r = subprocess.run(cmd, cwd=BRIDGE, env=env, stdout=lf, stderr=lf, timeout=900)
    if r.returncode != 0:
        raise RuntimeError(f"{name}: render failed — tail {log}")
    gen = os.path.join(outd, "generated.wav")
    subprocess.run(["ffmpeg", "-y", "-i", gen, out_wav], capture_output=True, check=True)


def pyin_frames(wav):
    r = subprocess.run([NSF_PY, os.path.join(HERE, "pyin_probe.py"), wav],
                       capture_output=True, text=True, timeout=600)
    d = json.loads(r.stdout.strip())
    if not d.get("ok"):
        raise RuntimeError(f"pyin probe failed on {wav}")
    return d["frames"]  # [t, hz, voiced]


def measure(name, wav):
    frames = pyin_frames(wav)
    with wave.open(wav) as w:
        dur = w.getnframes() / float(w.getframerate())
    # voicing gap near the boundary
    win = [f for f in frames if BOUNDARY - 0.1 <= f[0] <= BOUNDARY + 0.1]
    gap_ms, run = 0.0, 0.0
    for f in win:
        if not f[2]:
            run += 10.0
            gap_ms = max(gap_ms, run)
        else:
            run = 0.0
    # pitch step between note-half medians (voiced frames only, away from edges)
    def med_hz(a, b):
        hz = sorted(f[1] for f in frames if a <= f[0] <= b and f[2] and f[1] > 0)
        return hz[len(hz) // 2] if hz else None
    h1 = med_hz(REST + 0.1, BOUNDARY - 0.05)
    h2 = med_hz(BOUNDARY + 0.05, BOUNDARY + NOTE - 0.1)
    step_st = round(12 * math.log2(h2 / h1), 2) if h1 and h2 else None
    return {"name": name, "dur_s": round(dur, 3), "boundary_gap_ms": gap_ms,
            "note1_hz": h1, "note2_hz": h2, "step_st": step_st,
            "commanded_st": COMMANDED_ST[name]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.expanduser(
        "~/mosh-fms-ksb/used2/asserted-proof/mechanism/v4/melisma"))
    ap.add_argument("--measure-only", action="store_true")
    args = ap.parse_args()
    out_dir = os.path.abspath(os.path.expanduser(args.out))
    os.makedirs(out_dir, exist_ok=True)

    results = []
    for name, score in CLIPS.items():
        spath = os.path.join(out_dir, f"{name}.json")
        with open(spath, "w") as f:
            json.dump(score, f, indent=1)
        wav = os.path.join(out_dir, f"{name}.wav")
        if not args.measure_only or not os.path.isfile(wav):
            print(f"== render {name}", flush=True)
            render(name, spath, wav)
        results.append(measure(name, wav))

    by = {r["name"]: r for r in results}
    m0, m1, m2 = by["m0-reattack"], by["m1-slur-up3"], by["m2-slur-dn4"]
    checks = {
        "m0_control_shows_gap": m0["boundary_gap_ms"] >= 30.0,
        "m1_voicing_continuous": m1["boundary_gap_ms"] <= 30.0,
        "m2_voicing_continuous": m2["boundary_gap_ms"] <= 30.0,
        "m1_step_within_1st": m1["step_st"] is not None and abs(m1["step_st"] - 3.0) <= 1.0,
        "m2_step_within_1st": m2["step_st"] is not None and abs(m2["step_st"] + 4.0) <= 1.0,
        "lengths_within_10pct": all(abs(r["dur_s"] - TOTAL) / TOTAL <= 0.10 for r in results),
    }
    verdict = "PASS" if all(checks.values()) else "FAIL"
    payload = {"verdict": verdict, "checks": checks, "results": results,
               "criteria": "design doc §5 V4b (registered)"}
    with open(os.path.join(out_dir, "melisma.json"), "w") as f:
        json.dump(payload, f, indent=1)

    rows = "".join(
        f"<tr><td>{html.escape(r['name'])}</td><td>{r['dur_s']}</td><td>{r['boundary_gap_ms']:.0f}</td>"
        f"<td>{r['note1_hz']}</td><td>{r['note2_hz']}</td><td>{r['step_st']}</td>"
        f"<td>{r['commanded_st']}</td></tr>" for r in results)
    players = "".join(
        f"<div>{html.escape(r['name'])}</div><audio controls preload='none' "
        f"src='{html.escape(r['name'])}.wav'></audio>" for r in results)
    chk = "".join(f"<li>{html.escape(k)}: <b>{v}</b></li>" for k, v in checks.items())
    page = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>V4b melisma probe</title>
<style>
 :root{{color-scheme:dark}}
 body{{margin:0;background:#0f1116;color:#e8ebf3;font:15px/1.45 -apple-system,system-ui,sans-serif}}
 .wrap{{max-width:840px;margin:0 auto;padding:34px 18px 64px}}
 .card{{background:#16181f;border:1px solid #252934;border-radius:16px;padding:16px 18px;margin:0 0 16px}}
 .verdict{{border-color:#3d7bfd;font-size:18px}}
 h1{{margin:0 0 4px;font-size:24px}} h2{{margin:0 0 8px;font-size:16px}}
 .sub{{margin:0 0 16px;color:#9097a7;font-size:13px}}
 audio{{width:100%;margin:4px 0 10px}}
 table{{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}}
 td,th{{border:1px solid #2a2f3c;padding:6px 8px;text-align:right}}
 td:first-child,th:first-child{{text-align:left}}
 ul{{margin:0;padding-left:18px}} li{{margin:4px 0}}
</style></head><body><div class="wrap">
  <h1>V4b — melisma probe (note_type=3 slur)</h1>
  <p class="sub">'say' on two notes: M0 re-attacked (control), M1 slurred +3 st, M2 slurred −4 st.
  Boundary at {BOUNDARY}s. Measured by pyin; confirm by ear that M1/M2 glide with no re-attack.</p>
  <div class="card verdict"><h2>Verdict: {verdict}</h2><ul>{chk}</ul></div>
  <div class="card"><h2>Measurements</h2>
    <table><tr><th>clip</th><th>dur s</th><th>boundary gap ms</th><th>note1 Hz</th><th>note2 Hz</th>
    <th>step st</th><th>commanded</th></tr>{rows}</table></div>
  <div class="card"><h2>Listen</h2>{players}</div>
</div></body></html>"""
    ppath = os.path.join(out_dir, "melisma.html")
    with open(ppath, "w") as f:
        f.write(page)
    print(json.dumps({"ok": True, "verdict": verdict, "checks": checks,
                      "json": os.path.join(out_dir, "melisma.json"), "page": ppath}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
