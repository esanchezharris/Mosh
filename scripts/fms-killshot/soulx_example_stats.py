#!/usr/bin/env python3
"""V4a of the mechanism-verify spec: what do SoulX's OWN shipped example scores look like,
vs what we feed it?

Two registered probes (design doc §5):
  1. P-CENTER / voicing-lag — shipped English examples embed a 50fps `f0` string aligned to
     the clip. For each voiceless-onset note, find the unvoiced→voiced transition nearest
     the note start: lag ≈ cluster duration ⇒ the training convention keeps onset consonants
     INSIDE the note; lag ≈ 0 ⇒ consonants are budgeted into the prior tail (verbatim
     per-syllable transfer is then out-of-distribution — strengthens H).
  2. JOINT COVERAGE — duration and phones-per-note distributions, shipped vs ours
     (u2full/t1full chunk scores): fraction of our sung notes below the shipped 5th
     percentile, notes-per-word, syllables-per-note.

Caveat registered in the spec: the shipped corpus is a handful of clips — DIRECTIONAL
evidence only, never gates alone.

Usage (base python3, from scripts/fms-killshot/):
  python3 soulx_example_stats.py [--out ~/mosh-fms-ksb/used2/asserted-proof/mechanism/v4]
"""
from __future__ import annotations

import argparse
import glob
import html
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import vowel_landmark as vl  # noqa: E402  (word_events, onset_cluster, median, phones_of)

MAC = os.path.expanduser(os.environ.get("SOULX_MAC_DIR", "~/AI/soulx-mac"))
EXAMPLES = os.path.join(MAC, "SoulX-Singer-MLX", "example", "audio")
ROOT = os.path.expanduser("~/mosh-fms-ksb/used2")
OURS = [
    os.path.join(ROOT, "asserted-proof", "back-half", "sing-handoff", "scores", "u2full-c0*.json"),
    os.path.join(ROOT, "asserted-proof", "back-half", "sing-handoff", "scores_prev", "t1full-c*.json"),
]
F0_FPS = 50.0


def notes_of(clip):
    """Per sung note (type != 1): dict(dur, phon, n_phones, cluster, voiceless, type, start)."""
    durs = [float(d) for d in clip["duration"].split()]
    phons = clip["phoneme"].split()
    types = [int(x) for x in clip["note_type"].split()]
    t0 = float(clip["time"][0]) / 1000.0
    out, t = [], 0.0
    for d, ph, nt in zip(durs, phons, types):
        if nt != 1:
            cluster, voiceless = vl.onset_cluster(ph)
            out.append({"start": round(t, 4), "dur": d, "phon": ph, "type": nt,
                        "n_phones": len(vl.phones_of(ph)),
                        "cluster_len": len(cluster), "voiceless": voiceless})
        t += d
    # sanity: chain length == clip span. Shipped examples carry 2-decimal durations with
    # NO error diffusion (up to ~40ms drift over 51s — itself informative about the
    # format's native precision), so tolerate 0.1s and record larger as a hard error.
    span = float(clip["time"][1]) / 1000.0 - t0
    if abs(t - span) > 0.1:
        raise RuntimeError(f"{clip.get('index')}: chain {t:.3f}s != span {span:.3f}s")
    return out


def f0_frames(clip):
    v = clip.get("f0")
    if v is None:
        return None
    vals = [float(x) for x in (v.split() if isinstance(v, str) else v)]
    return vals


def voicing_lags(clip, window_s=0.15):
    """For each voiceless-onset type-2 note: (word, cluster, lag_ms) where lag = the
    unvoiced→voiced transition nearest the note start (within ±window_s) minus the note
    start. 'no_gap' when the boundary region is voiced throughout."""
    f0 = f0_frames(clip)
    if not f0:
        return []
    hop = 1.0 / F0_FPS
    texts = clip["text"].split()
    types = [int(x) for x in clip["note_type"].split()]
    sung = notes_of(clip)
    # map sung notes back to text tokens (walk in parallel)
    toks = [tx for tx, nt in zip(texts, types) if nt != 1]
    out = []
    for note, tok in zip(sung, toks):
        if note["type"] != 2 or not (note["voiceless"] and note["cluster_len"] >= 1):
            continue
        ns = note["start"]
        transitions = []
        i0 = max(1, int((ns - window_s) / hop))
        i1 = min(len(f0) - 1, int((ns + window_s) / hop) + 1)
        for i in range(i0, i1 + 1):
            if f0[i] > 0 and f0[i - 1] <= 0:
                transitions.append(i * hop)
        if not transitions:
            out.append({"word": tok, "cluster_len": note["cluster_len"], "lag_ms": None,
                        "no_gap": True})
            continue
        best = min(transitions, key=lambda t: abs(t - ns))
        out.append({"word": tok, "cluster_len": note["cluster_len"],
                    "lag_ms": round((best - ns) * 1000, 1), "no_gap": False})
    return out


def dist(xs):
    if not xs:
        return None
    s = sorted(xs)
    n = len(s)
    return {"n": n, "min": round(s[0], 3), "p5": round(s[max(0, n // 20)], 3),
            "p25": round(s[n // 4], 3), "median": round(vl.median(s), 3),
            "p75": round(s[(3 * n) // 4], 3), "max": round(s[-1], 3)}


def corpus_stats(clips, label):
    notes = [n for c in clips for n in notes_of(c)]
    sung2 = [n for n in notes if n["type"] == 2]
    words = [w for c in clips for w in vl.word_events(c)]
    return {
        "label": label, "clips": len(clips),
        "sung_notes": len(notes), "words": len(words),
        "dur_all": dist([n["dur"] for n in notes]),
        "dur_type2": dist([n["dur"] for n in sung2]),
        "phones_per_note": dist([float(n["n_phones"]) for n in notes]),
        "notes_per_word": dist([float(w["n_notes"]) for w in words]),
        "frac_notes_multiphone_ge4": round(
            sum(1 for n in notes if n["n_phones"] >= 4) / len(notes), 3) if notes else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "asserted-proof", "mechanism", "v4"))
    args = ap.parse_args()
    out_dir = os.path.abspath(os.path.expanduser(args.out))
    os.makedirs(out_dir, exist_ok=True)

    shipped, shipped_en = [], []
    for p in sorted(glob.glob(os.path.join(EXAMPLES, "*.json"))):
        with open(p) as f:
            d = json.load(f)
        clip = d[0] if isinstance(d, list) else d
        clip["_file"] = os.path.basename(p)
        shipped.append(clip)
        if clip.get("language") == "English":
            shipped_en.append(clip)

    ours = []
    for pat in OURS:
        for p in sorted(glob.glob(pat)):
            with open(p) as f:
                d = json.load(f)
            clip = d[0] if isinstance(d, list) else d
            clip["_file"] = os.path.basename(p)
            ours.append(clip)

    # probe 1: voicing lags on shipped English clips (they embed f0)
    lags = []
    for c in shipped_en:
        for l in voicing_lags(c):
            l["file"] = c["_file"]
            lags.append(l)
    lag_vals = [l["lag_ms"] for l in lags if l["lag_ms"] is not None]
    no_gap_frac = round(sum(1 for l in lags if l["no_gap"]) / len(lags), 3) if lags else None

    # probe 2: joint coverage
    ship_stats = corpus_stats(shipped, "shipped (all langs)")
    ship_en_stats = corpus_stats(shipped_en, "shipped (English)")
    our_stats = corpus_stats(ours, "ours (u2full+t1full)")
    p5 = (ship_en_stats["dur_type2"] or {}).get("p5")
    below = None
    if p5 is not None:
        our_durs = [n["dur"] for c in ours for n in notes_of(c) if n["type"] == 2]
        below = round(sum(1 for d in our_durs if d < p5) / len(our_durs), 3) if our_durs else None

    result = {
        "shipped_files": [c["_file"] for c in shipped],
        "our_files": [c["_file"] for c in ours],
        "voicing_lag": {
            "n_voiceless_onset_notes": len(lags),
            "no_gap_frac": no_gap_frac,
            "lag_ms": dist([float(v) for v in lag_vals]),
            "per_note": lags,
        },
        "corpora": [ship_stats, ship_en_stats, our_stats],
        "our_frac_type2_below_shipped_en_p5": below,
        "shipped_en_p5_dur_s": p5,
        "notes": [
            "Registered read: shipped lag ~= 0 (or negative) on voiceless-onset notes means "
            "the convention budgets consonants BEFORE the note (vowel on the boundary); "
            "lag >> 0 means consonants live inside the note.",
            "Directional only: tiny shipped corpus.",
        ],
    }
    jpath = os.path.join(out_dir, "example-stats.json")
    with open(jpath, "w") as f:
        json.dump(result, f, indent=1)

    def esc(x):
        return html.escape(str(x))

    def drow(label, d):
        if not d:
            return f"<tr><td>{esc(label)}</td><td colspan=7>—</td></tr>"
        return (f"<tr><td>{esc(label)}</td><td>{d['n']}</td><td>{d['min']}</td><td>{d['p5']}</td>"
                f"<td>{d['p25']}</td><td>{d['median']}</td><td>{d['p75']}</td><td>{d['max']}</td></tr>")

    lag_rows = "".join(
        f"<tr><td>{esc(l['file'])}</td><td>{esc(l['word'])}</td><td>{l['cluster_len']}</td>"
        f"<td>{'no gap' if l['no_gap'] else f'{l[chr(108)+chr(97)+chr(103)+chr(95)+chr(109)+chr(115)]:+.0f}'}</td></tr>"
        if not l["no_gap"] else
        f"<tr><td>{esc(l['file'])}</td><td>{esc(l['word'])}</td><td>{l['cluster_len']}</td><td>no gap</td></tr>"
        for l in lags)
    corp_rows = ""
    for st in (ship_stats, ship_en_stats, our_stats):
        corp_rows += (f"<tr><td>{esc(st['label'])}</td><td>{st['clips']}</td><td>{st['sung_notes']}</td>"
                      f"<td>{st['words']}</td><td>{(st['dur_type2'] or {}).get('median')}</td>"
                      f"<td>{(st['phones_per_note'] or {}).get('median')}</td>"
                      f"<td>{(st['notes_per_word'] or {}).get('median')}</td>"
                      f"<td>{st['frac_notes_multiphone_ge4']}</td></tr>")

    page = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>V4a SoulX example-score stats</title>
<style>
 :root{{color-scheme:dark}}
 body{{margin:0;background:#0f1116;color:#e8ebf3;font:15px/1.45 -apple-system,system-ui,sans-serif}}
 .wrap{{max-width:1040px;margin:0 auto;padding:34px 18px 64px}}
 .card{{background:#16181f;border:1px solid #252934;border-radius:16px;padding:16px 18px;margin:0 0 16px}}
 h1{{margin:0 0 4px;font-size:24px}} h2{{margin:0 0 8px;font-size:16px}}
 .sub{{margin:0 0 16px;color:#9097a7;font-size:13px}}
 .meta{{display:flex;gap:14px;flex-wrap:wrap;color:#9097a7;font-size:12px;margin:8px 0}}
 .meta b{{color:#e8ebf3}}
 table{{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}}
 td,th{{border:1px solid #2a2f3c;padding:6px 8px;text-align:right}}
 td:first-child,th:first-child,td:nth-child(2),th:nth-child(2){{text-align:left}}
</style></head><body><div class="wrap">
  <h1>V4a — SoulX shipped-example score statistics</h1>
  <p class="sub">Registered spec §5. Probe 1: voicing lag at voiceless-onset notes (shipped 50fps f0).
  Probe 2: duration / phones-per-note joint coverage, shipped vs ours.</p>
  <div class="card"><h2>Voicing lag (shipped English, voiceless onsets)</h2>
    <div class="meta"><span>n {result['voicing_lag']['n_voiceless_onset_notes']}</span>
      <span>no-gap fraction {no_gap_frac}</span>
      <span>lag dist (ms): <b>{esc(result['voicing_lag']['lag_ms'])}</b></span></div>
    <table><tr><th>file</th><th>word</th><th>cluster</th><th>lag ms</th></tr>{lag_rows}</table>
  </div>
  <div class="card"><h2>Corpora</h2>
    <table><tr><th>corpus</th><th>clips</th><th>sung notes</th><th>words</th>
      <th>median dur (type2)</th><th>median phones/note</th><th>median notes/word</th><th>frac ≥4 phones</th></tr>
    {corp_rows}</table>
    <div class="meta"><span>our type-2 notes below shipped-EN p5 ({p5}s): <b>{below}</b></span></div>
  </div>
  <div class="card"><h2>Duration distributions (type-2 sung notes, seconds)</h2>
    <table><tr><th>corpus</th><th>n</th><th>min</th><th>p5</th><th>p25</th><th>median</th><th>p75</th><th>max</th></tr>
    {drow('shipped EN', ship_en_stats['dur_type2'])}
    {drow('shipped all', ship_stats['dur_type2'])}
    {drow('ours', our_stats['dur_type2'])}</table>
  </div>
</div></body></html>"""
    ppath = os.path.join(out_dir, "example-stats.html")
    with open(ppath, "w") as f:
        f.write(page)
    print(json.dumps({"ok": True, "json": jpath, "page": ppath,
                      "lag_median_ms": (result["voicing_lag"]["lag_ms"] or {}).get("median"),
                      "no_gap_frac": no_gap_frac,
                      "our_frac_below_shipped_p5": below}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
