#!/usr/bin/env python3
"""V1 of the mechanism-verify spec: the gold-sing kit (owner checkpoint, ~10 min).

Nominates the 1–2 Used2 back-half phrases with the heaviest voiceless onset-cluster load
(maximum diagnostic power for the P-center mechanism), cuts a beat slice around each from
the section beatbed, and emits a recording page. The owner sings ONE nominated line
naturally over the beat — their phrasing, NOT the render's — and drops the file at
mechanism/v1/gold.wav. Registered prediction P-V1: mostly fine in the mouth (words are an
amplifier, not the root).

Usage (base python3, from scripts/fms-killshot/):
  python3 v1_kit.py [--out ~/mosh-fms-ksb/used2/asserted-proof/mechanism/v1]
"""
from __future__ import annotations

import argparse
import html
import json
import os
import struct
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import vowel_landmark as vl  # noqa: E402

ROOT = os.path.expanduser("~/mosh-fms-ksb/used2")
SCORES = os.path.join(ROOT, "asserted-proof", "back-half", "sing-handoff", "scores")
BEATBED = os.path.join(ROOT, "asserted-proof", "fresh", "u2-full-beatbed.wav")
REST_SPLIT = 0.35
PAD_S = 2.0


def section_words():
    """All u2 word instances on the section clock."""
    import glob
    out = []
    for p in sorted(glob.glob(os.path.join(SCORES, "u2full-c0*.json"))):
        with open(p) as f:
            clip = json.load(f)[0]
        off = float(clip["time"][0]) / 1000.0
        for e in vl.word_events(clip):
            e["start"] = round(e["start"] + off, 4)
            e["end"] = round(e["end"] + off, 4)
            out.append(e)
    return out


def phrases(words):
    """Group section-clock words into phrases at gaps >= REST_SPLIT."""
    groups, cur = [], []
    for w in words:
        if cur and w["start"] - cur[-1]["end"] >= REST_SPLIT:
            groups.append(cur)
            cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    return groups


def score_phrase(ws):
    """Diagnostic power: voiceless-onset word fraction, cluster mass, length."""
    stats = [vl.onset_cluster(w["phon"]) for w in ws]
    n_voiceless = sum(1 for _c, v in stats if v)
    cluster_mass = sum(len(c) for c, _v in stats)
    return {
        "text": " ".join(w["word"] for w in ws),
        "start": ws[0]["start"], "end": ws[-1]["end"],
        "n_words": len(ws), "n_voiceless_onsets": n_voiceless,
        "voiceless_frac": round(n_voiceless / len(ws), 2),
        "cluster_mass": cluster_mass,
        "power": round(n_voiceless + 0.5 * cluster_mass, 1),
    }


def slice_wav(src, dst, t0, t1):
    r = None
    with wave.open(src) as w:
        sr = w.getframerate()
        w.setpos(int(max(0.0, t0) * sr))
        n = int((t1 - t0) * sr)
        raw = w.readframes(n)
        params = (1, w.getsampwidth(), sr)
    with wave.open(dst, "wb") as w:
        w.setnchannels(params[0])
        w.setsampwidth(params[1])
        w.setframerate(params[2])
        w.writeframes(raw)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "asserted-proof", "mechanism", "v1"))
    args = ap.parse_args()
    out_dir = os.path.abspath(os.path.expanduser(args.out))
    os.makedirs(out_dir, exist_ok=True)

    scored = [score_phrase(ws) for ws in phrases(section_words()) if len(ws) >= 4]
    scored.sort(key=lambda p: -p["power"])
    picks = scored[:2]

    cards = ""
    for i, p in enumerate(picks, 1):
        t0 = max(0.0, p["start"] - PAD_S)
        t1 = p["end"] + PAD_S
        beat = os.path.join(out_dir, f"line{i}-beat.wav")
        slice_wav(BEATBED, beat, t0, t1)
        p["beat_slice"] = os.path.basename(beat)
        p["beat_t0"] = round(t0, 2)
        cards += f"""<div class="card"><h2>Line {i} — sing this</h2>
  <p class="line">“{html.escape(p['text'])}”</p>
  <div class="meta"><span>section {p['start']:.1f}–{p['end']:.1f}s</span>
    <span>{p['n_words']} words · {p['n_voiceless_onsets']} voiceless onsets · cluster mass {p['cluster_mass']}</span></div>
  <div>beat slice (starts {PAD_S:.0f}s before your entry)</div>
  <audio controls preload="none" src="{html.escape(os.path.basename(beat))}"></audio>
</div>"""

    with open(os.path.join(out_dir, "nominations.json"), "w") as f:
        json.dump({"picks": picks, "all_phrases": scored}, f, indent=1)

    page = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>V1 gold sing — record one line</title>
<style>
 :root{{color-scheme:dark}}
 body{{margin:0;background:#0f1116;color:#e8ebf3;font:15px/1.45 -apple-system,system-ui,sans-serif}}
 .wrap{{max-width:840px;margin:0 auto;padding:34px 18px 64px}}
 .card{{background:#16181f;border:1px solid #252934;border-radius:16px;padding:16px 18px;margin:0 0 16px}}
 h1{{margin:0 0 4px;font-size:24px}} h2{{margin:0 0 8px;font-size:16px}}
 .sub{{margin:0 0 16px;color:#9097a7;font-size:13px}}
 .line{{font-size:20px;margin:6px 0 10px}}
 .meta{{display:flex;gap:14px;flex-wrap:wrap;color:#9097a7;font-size:12px;margin:8px 0}}
 audio{{width:100%;margin:4px 0 10px}}
 ol{{margin:0;padding-left:20px}} li{{margin:6px 0}}
 code{{background:#0d0f14;border:1px solid #252934;border-radius:6px;padding:1px 6px}}
</style></head><body><div class="wrap">
  <h1>V1 — sing one line, naturally</h1>
  <p class="sub">Mechanism-verify checkpoint (~10 min). This is the gold reference for the
  decisive V2 experiment. Registered prediction: the words feel mostly fine in your mouth.</p>
  <div class="card"><h2>How</h2><ol>
    <li><b>Headphones on</b> (the beat must NOT bleed into the mic — it poisons the pitch analysis).</li>
    <li>Play the beat slice for Line 1 below and sing the line <b>your way</b> — natural phrasing,
        your melody in your register. Do NOT listen to the render or your mumble first, and do not
        try to imitate any timing. One good take is enough.</li>
    <li>Save the recording (mono if possible, any sample rate) as
        <code>~/mosh-fms-ksb/used2/asserted-proof/mechanism/v1/gold.wav</code>
        (and note which line you sang if not Line 1: <code>gold-line2.wav</code>).</li>
    <li>Two quick notes while it's fresh: did anything feel awkward to sing? Which words?</li>
  </ol></div>
  {cards}
</div></body></html>"""
    ppath = os.path.join(out_dir, "record.html")
    with open(ppath, "w") as f:
        f.write(page)
    print(json.dumps({"ok": True, "page": ppath,
                      "picks": [{k: p[k] for k in ("text", "start", "end", "power")}
                                for p in picks]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
