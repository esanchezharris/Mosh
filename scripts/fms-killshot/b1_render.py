#!/usr/bin/env python3
"""B1-lite render driver — derived-vs-verbatim blind ear round on the u2 back half.

Both arms re-rendered LOCALLY through the identical MLX arm (backend parity — the V2
lesson), assembled by plain sum (chunk renders are self-placed), pushed through the
(a)-fixed chain identically: PHRASE-only alignment (windows from the VERBATIM full-take
clip for BOTH arms — windows only partition time; identical treatment is the control)
then NSF `perform` at the take's own F0. vowelGate (the B3 metric) is measured on the
SNAPPED, pre-NSF arms — NSF perform paints take-shaped F0/voicing, which would
contaminate a voicing-landmark measurement.

Registered expectation (informative, NOT a gate — the ear is the only gate): the derived
arm's clean-subset vowel-onset delta shrinks toward the V2 oracle's ~10ms from the
verbatim arm's ~40ms.

Usage (base python3, from scripts/fms-killshot/):
  python3 b1_render.py render     # 2 arms x 5 chunks via local MLX (skips existing)
  python3 b1_render.py finish     # assemble + phrase-snap + NSF + metrics
  python3 b1_render.py page       # blind A/B page (labels JSON unlinked)
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import diagnose                              # noqa: E402
import melisma_probe as mp                   # noqa: E402
import oracle_duration as od                 # noqa: E402
import v3_assembly as v3                     # noqa: E402
import vowel_landmark as vl                  # noqa: E402
from soulx import perform as sp              # noqa: E402
from soulx.score import phrase_windows       # noqa: E402

ROOT = v3.ROOT
B1 = os.path.join(ROOT, "asserted-proof", "mechanism", "b1")
RENDERS = os.path.join(B1, "renders")
TEARDOWN_PY = os.path.expanduser("~/Library/Mosh/venvs/teardown/bin/python")
VIZ = os.path.join(REPO, "service", "viz", "waveform_compare.py")
SCORE_JSON = os.path.join(ROOT, "fresh-render", "audit", "u2-full-score.json")


def _panel(render_wav, out_png, t0, t1, label):
    """take-vs-render waveform+spectrogram panel via the teardown venv (PIL). Best-effort:
    a missing venv/PIL leaves the audio-only card intact."""
    import subprocess
    if not (os.path.isfile(TEARDOWN_PY) and os.path.isfile(VIZ)):
        return False
    cmd = [TEARDOWN_PY, VIZ, v3.TAKE, render_wav, out_png, "--label", label,
           "--t0", str(round(t0, 2)), "--t1", str(round(t1, 2))]
    if os.path.isfile(SCORE_JSON):
        cmd += ["--score", SCORE_JSON]
    try:
        return subprocess.run(cmd, capture_output=True, timeout=180).returncode == 0
    except Exception:  # noqa: BLE001
        return False
_HANDOFF = os.path.join(ROOT, "asserted-proof", "back-half", "sing-handoff")
SCORES = {
    "verbatim": os.path.join(_HANDOFF, "scores"),
    "derived": os.path.join(_HANDOFF, "scores-derived"),
    "derived-half": os.path.join(_HANDOFF, "scores-derived-half"),  # strength 0.5
}
# the third (half-strength) arm is opt-in via B1_THREE_WAY=1 (needs scores-derived-half +
# its renders); default stays the clean 2-way verbatim/derived contrast.
ARMS = (("verbatim", "derived", "derived-half") if os.environ.get("B1_THREE_WAY") == "1"
        else ("verbatim", "derived"))
_LAB = "ABC"
# judge windows: the whole back half (primary) + the two proven line windows
WINDOWS = [("full", None, None), ("line2", 1.02, 3.90), ("line1", 37.925, 41.285)]
NSF_PY = os.path.expanduser(os.environ.get("NSF_PY", "~/Library/Mosh/venvs/nsf/bin/python3"))


def chunks():
    with open(v3.MANIFEST) as f:
        return json.load(f)["chunks"]


def arm_render(arm, name):
    return os.path.join(RENDERS, f"{arm}-{name}.wav")


def cmd_render() -> int:
    os.makedirs(RENDERS, exist_ok=True)
    todo = [(arm, ch) for arm in ARMS for ch in chunks()
            if not os.path.isfile(arm_render(arm, ch["name"]))]
    print(f"chunks to render: {len(todo)}", flush=True)
    for arm, ch in todo:
        score = os.path.join(SCORES[arm], f"{ch['name']}.json")
        if not os.path.isfile(score):
            raise RuntimeError(f"missing score {score} — run b1_derive.py first")
        out = arm_render(arm, ch["name"])
        print(f"render {arm}/{ch['name']}", flush=True)
        mp.render(f"b1-{arm}-{ch['name']}", score, out)
        mono, sr = v3.read_mono(out)
        want = (ch["offsetMs"] + ch["durMs"]) / 1000.0
        got = len(mono) / sr
        if abs(got - want) > 0.08:
            raise RuntimeError(f"{arm}/{ch['name']}: self-placement broken — "
                               f"wav {got:.2f}s != offset+dur {want:.2f}s")
        rms = math.sqrt(sum(v * v for v in mono) / len(mono))
        if rms < 1e-4:
            raise RuntimeError(f"{arm}/{ch['name']}: render silent (rms {rms:.6f})")
        print(f"  ok {got:.2f}s rms {rms:.3f}", flush=True)
    print("all renders present", flush=True)
    return 0


def assemble(arm, sr_out, total_s):
    out = [0.0] * int(total_s * sr_out)
    for ch in chunks():
        mono, sr = v3.read_mono(arm_render(arm, ch["name"]))
        if sr != sr_out:
            mono = sp.resample_hq(mono, sr, sr_out)
        for i, v in enumerate(mono):
            if i < len(out):
                out[i] += v
    peak = max(abs(v) for v in out)
    if peak > 0.99:
        out = [v / peak * 0.97 for v in out]
    return out


def pyin_pairs(wav):
    r = diagnose._run_json(NSF_PY, os.path.join(HERE, "pyin_probe.py"), wav)
    if not r.get("ok"):
        raise RuntimeError(f"pyin probe failed on {wav}: {str(r)[:200]}")
    return [(t, bool(v)) for t, _hz, v in r["frames"]]


def cmd_finish() -> int:
    os.makedirs(B1, exist_ok=True)
    take, sr = v3.read_mono(v3.TAKE)
    total_s = len(take) / sr
    with open(v3.CLIP) as f:
        clips = json.load(f)
    clip = clips[0] if isinstance(clips, list) else clips
    windows = phrase_windows(clip)
    env_t = sp.energy_envelope(take, sr, hop_ms=10.0)

    metrics = {"n_windows": len(windows), "nsf": od.nsf_available(), "arms": {}}
    finals = {}
    for arm in ARMS:
        print(f"assemble {arm}", flush=True)
        raw = assemble(arm, sr, total_s)
        v3.write_wav(os.path.join(B1, f"arm-{arm}-raw.wav"), raw[:len(take)], sr)
        env_r = sp.energy_envelope(raw, sr, hop_ms=10.0)
        shifts = sp.phrase_shifts(env_t, env_r, windows)
        snapped = sp.apply_shifts(raw, sr, windows, shifts, total_s=total_s)
        spath = os.path.join(B1, f"arm-{arm}-snapped.wav")
        v3.write_wav(spath, snapped[:len(take)], sr)
        a = metrics["arms"][arm] = {
            "env_corr_raw": round(sp.env_corr(take, raw[:len(take)], sr), 3),
            "env_corr_snapped": round(sp.env_corr(take, snapped[:len(take)], sr), 3),
            "phrase_shifts_ms": [round(s * 1000, 1) for s in shifts],
        }
        final = spath
        if od.nsf_available():
            npath = os.path.join(B1, f"arm-{arm}-nsf.wav")
            print(f"nsf perform {arm}", flush=True)
            od.nsf_perform(spath, npath, v3.TAKE)
            final = npath
        else:
            a["nsf_skipped"] = True
        finals[arm] = final
        a["final"] = os.path.basename(final)

    print("vowelGate (snapped, pre-NSF)", flush=True)
    try:
        take_fr = pyin_pairs(v3.TAKE)
        for arm in ARMS:
            arm_fr = pyin_pairs(os.path.join(B1, f"arm-{arm}-snapped.wav"))
            metrics["arms"][arm]["vowelGate"] = vl.vowel_onset_report(
                clip, take_fr, arm_fr, offset_s=0.0)
    except Exception as e:  # noqa: BLE001 — metric extra, never blocks the ear round
        metrics["vowelGate_error"] = str(e)[:200]

    with open(os.path.join(B1, "b1-metrics.json"), "w") as f:
        json.dump(metrics, f, indent=1, sort_keys=True)
    with open(os.path.join(B1, "b1-finals.json"), "w") as f:
        json.dump(finals, f, indent=1)
    print(json.dumps(metrics, indent=1, sort_keys=True))
    return 0


def cmd_page() -> int:
    take, sr = v3.read_mono(v3.TAKE)
    total_s = len(take) / sr
    with open(os.path.join(B1, "b1-finals.json")) as f:
        finals = json.load(f)
    arms = {}
    for arm, path in finals.items():
        mono, asr = v3.read_mono(path)
        if asr != sr:
            mono = sp.resample_hq(mono, asr, sr)
        arms[arm] = mono

    labels, groups_html = {}, ""
    for wname, a, b in WINDOWS:
        a = 0.0 if a is None else max(0.0, a - v3.PAD_S)
        b = total_s if b is None else min(total_s, b + v3.PAD_S)
        entries = []
        for name, xs in arms.items():
            seg = v3.slice_norm(xs, sr, a, b)
            p = os.path.join(B1, f"src-{wname}-{name}.wav")
            v3.write_wav(p, seg, sr)
            entries.append((name, p))
        seed = hashlib.sha256((wname + "".join(
            f"{p}:{os.path.getsize(p)}" for _n, p in sorted(entries))).encode()).hexdigest()
        random.Random(seed).shuffle(entries)
        cards, labels[wname] = "", {}
        for lab, (name, p) in zip(_LAB, entries):
            blind = os.path.join(B1, f"{wname}-clip-{lab}.wav")
            os.replace(p, blind)
            labels[wname][lab] = name
            # blind-labeled take-vs-render panel (waveform + spectrogram) from this arm's
            # final nsf wav, cropped to the group window; name reveals nothing.
            png = os.path.join(B1, f"{wname}-clip-{lab}.png")
            has_png = _panel(finals[name], png, a, b, f"{wname} — clip {lab}")
            img = (f"<img loading='lazy' src='{html.escape(os.path.basename(png))}'>"
                   if has_png else "")
            cards += (f"<div class='card'><h2>{html.escape(wname)} — clip {lab}</h2>"
                      f"<audio controls preload='none' "
                      f"src='{html.escape(os.path.basename(blind))}'></audio>{img}</div>")
        groups_html += f"<h1 class='grp'>{html.escape(wname)}</h1>{cards}"

    with open(os.path.join(B1, "b1-labels.json"), "w") as f:
        json.dump({"labels": labels}, f, indent=1)

    page = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>B1-lite — derived vs verbatim durations, blind</title>
<style>
 :root{{color-scheme:dark}}
 body{{margin:0;background:#0f1116;color:#e8ebf3;font:15px/1.45 -apple-system,system-ui,sans-serif}}
 .wrap{{max-width:1080px;margin:0 auto;padding:34px 18px 64px}}
 .card{{background:#16181f;border:1px solid #252934;border-radius:16px;padding:16px 18px;margin:0 0 16px}}
 h1{{margin:0 0 4px;font-size:24px}} h1.grp{{font-size:18px;margin:22px 0 10px}}
 h2{{margin:0 0 8px;font-size:16px}}
 .sub{{margin:0 0 16px;color:#9097a7;font-size:13px}}
 audio{{width:100%;margin:4px 0 10px}}
 img{{width:100%;max-width:100%;border-radius:8px;margin-top:6px;display:block}}
 .note{{background:#152018;border:1px solid #24402c;border-radius:12px;padding:12px 16px;margin:0 0 18px;color:#bfe6c9;font-size:13px}}
</style></head><body><div class="wrap">
  <h1>B1-lite — duration derivation, blind {"3-way" if len(arms) > 2 else "A/B"}</h1>
  <p class="note"><b>Squeak fixed.</b> The harsh squeak across every clip was HF imaging
  from a linear-interpolation resampler (SoulX renders at 24k, upsampled to your 44.1k
  take) — replaced with a band-limited resampler; spurious 12–20 kHz energy dropped ~30×
  (0.00375→0.00012, now below the take's own). Each clip carries a <b>take-vs-render
  waveform + spectrogram panel</b> (top rows = your mumble vs the render on a shared clock;
  bottom rows = their spectrograms; green ticks = word onsets, grey = phrase edges). The
  render's high band (top of its spectrogram) should now read dark like the take, not bright.</p>
  <p class="sub">The u2 back half {"three ways" if len(arms) > 2 else "two ways"} (random
  order per group, level-matched; every arm rendered locally through the identical chain:
  MLX → plain-sum assembly → phrase-only alignment → NSF perform). Same words, same
  melody — only the note DURATIONS differ{" (one arm derives at half strength)"
  if len(arms) > 2 else ""}. "full" is the whole passage; the two line groups are focused
  re-listens of the same renders. First: is the squeak gone? Then per group: which reads
  most natural / most human, and does the render track your mumble's timing (green ticks)?
  {"Rank the clips per group" if len(arms) > 2 else "Pick one per group"} —
  reply like "full: A, line2: {'A>C>B' if len(arms) > 2 else 'A'}, line1: tie". Do not
  open b1-labels.json until done.</p>
  {groups_html}
</div></body></html>"""
    ppath = os.path.join(B1, "b1-listen.html")
    with open(ppath, "w") as f:
        f.write(page)
    print(json.dumps({"ok": True, "page": ppath}, indent=1))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["render", "finish", "page"])
    args = ap.parse_args()
    return {"render": cmd_render, "finish": cmd_finish, "page": cmd_page}[args.cmd]()


if __name__ == "__main__":
    raise SystemExit(main())
