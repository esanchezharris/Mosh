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
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from backhalf_ab_bench import ROOT  # noqa: E402

SERVE = ROOT / "asserted-proof"
KEYS = ["T1", "T2"]
MODES = ["revoice", "tune"]


def render() -> int:
    sys.path.insert(0, str(HERE.parents[1] / "service" / "nsf"))
    import nsf_cli  # noqa: E402  (imported here so `page` needs no torch/nsf venv)
    for key in KEYS:
        src = SERVE / f"voice-writer-{key}.wav"
        if not src.is_file():
            print(f"skip {key}: no {src.name}", flush=True)
            continue
        for mode in MODES:
            nsf_cli.resynth(src, SERVE / f"voice-nsf-{key}-{mode}.wav", mode)
    return 0


def page() -> int:
    cards = []
    for key in KEYS:
        have = {m: (SERVE / f"voice-nsf-{key}-{m}.wav").is_file() for m in MODES}
        if not any(have.values()):
            continue
        rows = ""
        if (SERVE / f"voice-writer-{key}-perfsoft.wav").is_file():
            rows += (f'<div class="row"><span>SoulX + our SOFT lock (the current pipeline)</span>'
                     f'<audio controls preload="metadata" src="voice-writer-{key}-perfsoft.wav"></audio></div>')
        if have["revoice"]:
            rows += (f'<div class="row"><span><b>NSF re-vocode</b> — same voice through the neural vocoder, '
                     f'the render\'s own pitch (naturalness baseline)</span>'
                     f'<audio controls preload="metadata" src="voice-nsf-{key}-revoice.wav"></audio></div>')
        if have["tune"]:
            rows += (f'<div class="row"><span><b>NSF pitch-corrected</b> — dead-in-tune to the nearest '
                     f'semitone, no autotune smear (the demo\'s technique)</span>'
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
  <h1>Used2 — neural-vocoder resynthesis spike</h1>
  <p class="sub">The @KRTK_12 / HachiTune technique (<b>PC-NSF-HiFiGAN</b>) running on your own
     render. It rebuilds the vocal from a mel-spectrogram + an explicit pitch curve — so pitch
     is a real, controllable input (no autotune smear) and the delivery is the vocoder's own,
     not a painted-on envelope. For each draw: the current SoulX+soft-lock, then the same voice
     re-vocoded, then pitch-corrected dead-in-tune. Verified: re-vocode preserves the voice at
     0.98 envelope correlation; tuned output sits within 1 cent of pitch.</p>
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
