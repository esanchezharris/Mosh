#!/usr/bin/env python3
"""Build a static listening page over kill-shot output folders.

Scans <root>/*/ for audio (input.wav, overlay.wav, beeps.wav, or any *.wav/*.mp3) plus an
optional diagnostic.json, and writes <root>/index.html with inline players — the
listening-room pattern: serve with  python3 -m http.server 8189 -d <root>.

KS-B: each take folder shows input / overlay (L=take, R=beeps) / beeps + the bar table.
KS-A: drop render WAVs into folders (blind-name them r1/, r2/, ...) and it lists them the same.

Usage:  make_listening_page.py <root> [--title "..."]
"""
from __future__ import annotations

import argparse
import html
import json
import os

AUDIO_EXT = (".wav", ".mp3", ".m4a", ".flac")
PREFERRED = ("input.wav", "overlay.wav", "beeps.wav")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--title", default="FMS kill-shot listening")
    args = ap.parse_args()
    root = os.path.abspath(args.root)

    sections = []
    for name in sorted(os.listdir(root)):
        d = os.path.join(root, name)
        if not os.path.isdir(d):
            continue
        files = sorted(os.listdir(d))
        audio = [f for f in PREFERRED if f in files] + \
                [f for f in files if f.lower().endswith(AUDIO_EXT) and f not in PREFERRED]
        if not audio:
            continue
        rows = "".join(
            f'<div class="row"><span class="lbl">{html.escape(a)}</span>'
            f'<audio controls preload="none" src="{html.escape(name)}/{html.escape(a)}"></audio></div>'
            for a in audio)
        bars = ""
        diag_path = os.path.join(d, "diagnostic.json")
        if os.path.isfile(diag_path):
            try:
                diag = json.load(open(diag_path))
                cells = "".join(
                    f"<tr><td>{b['bar']}</td><td>{b['notes']}</td><td>{b['nuclei']}</td>"
                    f"<td>{b['syllableTarget']}{' ⚠' if b.get('clamped') else ''}</td>"
                    f"<td><code>{html.escape(b.get('stress', ''))}</code></td></tr>"
                    for b in diag.get("bars", []))
                meta = (f"bpm {diag.get('bpm')} · grid {diag.get('grid')} · "
                        f"notes {len(diag.get('input_notes', []))} · nuclei {len(diag.get('nuclei', []))} · "
                        f"splits {diag.get('splits_total')} · f0 {(diag.get('f0_stats') or {}).get('backend') or 'NONE'} · "
                        f"deterministic {diag.get('determinism', {}).get('stable')}")
                bars = (f'<p class="meta">{html.escape(meta)}</p>'
                        f'<table><tr><th>bar</th><th>notes</th><th>nuclei</th><th>syl</th><th>stress</th></tr>'
                        f"{cells}</table>")
            except Exception:
                bars = '<p class="meta">diagnostic.json unreadable</p>'
        sections.append(f'<section><h2>{html.escape(name)}</h2>{rows}{bars}</section>')

    page = f"""<!doctype html><meta charset="utf-8"><title>{html.escape(args.title)}</title>
<style>
 body{{font:15px/1.5 -apple-system,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;background:#141210;color:#e8e2d8}}
 h1{{font-size:1.3rem}} h2{{font-size:1.05rem;border-top:1px solid #3a352e;padding-top:1rem;margin-top:1.6rem}}
 .row{{display:flex;align-items:center;gap:.8rem;margin:.3rem 0}} .lbl{{width:9rem;color:#b8ae9e;font-family:ui-monospace,monospace;font-size:.8rem}}
 audio{{flex:1;height:2rem}} .meta{{color:#8f8778;font-size:.8rem}}
 table{{border-collapse:collapse;font-size:.8rem;margin:.4rem 0}} td,th{{border:1px solid #3a352e;padding:.15rem .5rem;text-align:right}}
 code{{color:#d8b46a}}
</style>
<h1>{html.escape(args.title)}</h1>
<p class="meta">overlay = take (left ear) vs detected syllables (right ear). v3 beeps are
articulation-aware: a pitch GLIDE with no re-attack = the system saying "same word, new note"
(melisma, one syllable slot); a fresh beep attack = a new syllable. v1 beeps re-attack on every
nucleus. Count against your own ear before reading the tables; listen for slides that should be
separate syllables and vice versa. Rate under the VocalFinisher rule: only after real listening.</p>
{"".join(sections) or "<p>No runs found.</p>"}"""
    out = os.path.join(root, "index.html")
    with open(out, "w") as f:
        f.write(page)
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
