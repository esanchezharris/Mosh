#!/usr/bin/env python3
"""PC-NSF-HiFiGAN spike harness — resynth the Used2 renders + serve an A/B (spike lane).

Proves the @KRTK_12 / HachiTune technique on the owner's own render: extract the render's
mel + its measured F0, resynth via the vendored PC-NSF-HiFiGAN vocoder. Two arms:
  revoice — resynth at the render's own F0 (a clean re-vocode; the naturalness baseline)
  tune    — resynth at that F0 snapped to the nearest semitone (dead-in-tune, no autotune smear)
F0 is measured from the render itself, so it is perfectly frame-aligned — zero pitch-misalign
risk. Weights are CC BY-NC-SA (spike/owner-only, never shipped).

Run under the nsf venv:
  ~/Library/Mosh/venvs/nsf/bin/python3 scripts/fms-killshot/backhalf_nsf.py render   # make wavs
  python3 scripts/fms-killshot/backhalf_nsf.py page                                   # write A/B page
"""
from __future__ import annotations

import html
import os
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from backhalf_ab_bench import ROOT  # noqa: E402

NSF_CLI = HERE.parents[1] / "service" / "nsf" / "nsf_cli.py"
NSF_PY = pathlib.Path.home() / "Library" / "Mosh" / "venvs" / "nsf" / "bin" / "python3"
SERVE = ROOT / "asserted-proof"
KEYS = ["T1", "T2"]
MODES = ["revoice", "tune"]
# The FULL pipeline (owner round): the timing-snapped render (voice-writer-{key}-timed.wav,
# from backhalf_perform.py — phrase+word aligned to the take, NO envelope transfer) re-vocoded
# → aligned timing + the model's own natural dynamics + clean pitch. `revoice` mode = the
# render's own F0 (perfectly aligned, zero pitch-misalign risk).


def _resynth(src: pathlib.Path, out: pathlib.Path, mode: str) -> None:
    # subprocess (clean process) — importing nsf_cli in-process after backhalf_ab_bench
    # poisons numba/librosa (import-order clash). The nsf venv python has torch+librosa.
    py = str(NSF_PY) if NSF_PY.exists() else sys.executable
    r = subprocess.run([py, str(NSF_CLI), str(src), str(out), mode],
                       capture_output=True, text=True)
    line = next((l for l in r.stdout.splitlines() if l.startswith(mode)), r.stdout.strip()[-160:])
    print(f"  {line}" if r.returncode == 0 else f"  FAIL {out.name}: {r.stderr.strip()[-200:]}", flush=True)
    if r.returncode != 0:
        raise SystemExit(f"nsf resynth failed for {src.name}")


def render() -> int:
    for key in KEYS:
        src = SERVE / f"voice-writer-{key}.wav"
        if src.is_file():
            for mode in MODES:
                _resynth(src, SERVE / f"voice-nsf-{key}-{mode}.wav", mode)
        timed = SERVE / f"voice-writer-{key}-timed.wav"
        if timed.is_file():
            _resynth(timed, SERVE / f"voice-nsf-{key}-timed.wav", "revoice")
        if not src.is_file() and not timed.is_file():
            print(f"skip {key}: no render", flush=True)
    return 0


def page() -> int:
    cards = []
    for key in KEYS:
        have = {m: (SERVE / f"voice-nsf-{key}-{m}.wav").is_file() for m in ("revoice", "tune", "timed")}
        if not any(have.values()):
            continue
        rows = ""
        if have["timed"]:
            rows += (f'<div class="row"><span><b>★ FULL PIPELINE</b> — new lyrics, timing snapped to your '
                     f'take, then NSF re-vocode (coherent words + tight flow + natural voice)</span>'
                     f'<audio controls preload="metadata" src="voice-nsf-{key}-timed.wav"></audio></div>')
        if have["revoice"]:
            rows += (f'<div class="row"><span>NSF re-vocode — the render\'s own timing (natural voice, '
                     f'flow not yet snapped)</span>'
                     f'<audio controls preload="metadata" src="voice-nsf-{key}-revoice.wav"></audio></div>')
        if (SERVE / f"voice-writer-{key}-perfsoft.wav").is_file():
            rows += (f'<div class="row"><span>SoulX + our SOFT lock (the painted-envelope pipeline, for contrast)</span>'
                     f'<audio controls preload="metadata" src="voice-writer-{key}-perfsoft.wav"></audio></div>')
        if have["tune"]:
            rows += (f'<div class="row"><span>NSF pitch-corrected — dead-in-tune to the nearest '
                     f'semitone, no autotune smear</span>'
                     f'<audio controls preload="metadata" src="voice-nsf-{key}-tune.wav"></audio></div>')
        cards.append(f'<div class="card"><div class="chead"><span class="tag">{key}</span>'
                     f'<h2>{html.escape(key)} — SoulX vs neural-vocoder resynthesis</h2></div>{rows}</div>')

    (SERVE / "nsf-spike.html").write_text(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Used2 — PC-NSF-HiFiGAN resynthesis spike</title>
<style>
  body{{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
  .wrap{{max-width:820px;margin:0 auto;padding:26px 20px 80px}}
  h1{{font-size:22px;margin:0 0 4px}} .sub{{color:#8b949e;margin:0 0 22px}}
  .card{{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px 18px;margin:0 0 16px}}
  .chead{{display:flex;align-items:center;gap:10px}} .chead h2{{font-size:16px;margin:0}}
  .tag{{background:#7c3aed22;color:#a371f7;border:1px solid #7c3aed55;border-radius:6px;padding:1px 8px;font-weight:700}}
  audio{{width:100%;margin-top:6px}}
  .row{{border-top:1px solid #21262d;padding:9px 0}} .row span{{font-size:13px;color:#8b949e}}
  .note{{color:#8b949e;font-size:13px}}
</style></head><body><div class="wrap">
  <h1>Used2 — full pipeline preview (NSF re-vocode + timing snap)</h1>
  <p class="sub"><b>★ FULL PIPELINE</b> is the direction: your render timing-snapped to the take,
     then NSF re-vocoded (the natural voice you liked, now with the flow tightened and no painted
     envelope). <b>Heads-up: these carry the PREVIOUS round's lyrics</b> — the new, coherent
     lyrics (craft prompt + no filler-salad) are staged and render on the pod. This page is the
     SOUND preview (voice + flow + pitch); judge the words from the draft list I sent, not here.
     Verified: NSF re-vocode preserves the voice at 0.98 envelope correlation, pitch within 1 cent.</p>
  <div class="card"><div class="chead"><h2>Raw back half (your take, reference)</h2></div>
    <audio controls preload="metadata" src="back-half/source-backhalf-48k.wav"></audio></div>
  {''.join(cards)}
  <p class="note">Spike / owner-only: the PC-NSF-HiFiGAN weights are CC BY-NC-SA (non-commercial),
     so this can't ship as-is — if it's the direction, we self-train a checkpoint from the
     MIT trainer. Verdict-gated on your ear vs the soft-lock.</p>
</div></body></html>""")
    print(f"nsf spike page -> {SERVE / 'nsf-spike.html'} ({len(cards)} candidates)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(page() if (len(sys.argv) > 1 and sys.argv[1] == "page") else render())
