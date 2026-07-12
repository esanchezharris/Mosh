#!/usr/bin/env python3
"""Performance lock — constrain the writer-round renders to the MUMBLE's delivery.

Owner verdict on the writer round: words/notes are close, but none of the renders
are "constrained enough to my mumble — the note being hit, the volume being hit
at the attack and decay". The score we hand SoulX carries NO dynamics, so this
round transfers the take's performance onto the EXISTING renders deterministically
(no pod, no seed lottery):

  1. phrase time-align   render phrases snapped onto the take's clock
                         (align_render: per-phrase envelope cross-correlation,
                         windows from each candidate's own chunk scores)
  2. envelope transfer   the take's energy envelope gain-matched onto the render
                         (soulx.perform: silence-gated, boost-capped, smoothed)

Honest metric: envCorr (envelope correlation on take-active frames — the ACE-audit
convention) before -> after, per candidate. Nothing under ~/mosh-fms-ksb enters git.

Usage:  backhalf_perform.py           lock A/B/C + write report
        backhalf_perform.py page      rebuild the panel page + daw-kit delivery
"""
from __future__ import annotations

import html
import json
import statistics
import struct
import subprocess
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "service"))

import align_render as ar            # noqa: E402
import overlap as ov                 # noqa: E402
from backhalf_ab_bench import BH, ROOT  # noqa: E402
from skeleton import core as skcore  # noqa: E402
from soulx import ab_mix, perform    # noqa: E402

HANDOFF = BH / "sing-handoff"
SCORES = HANDOFF / "scores"
SERVE = ROOT / "asserted-proof"
KIT = ROOT / "daw-kit"
MANIFEST = BH / "writer-round-manifest.json"
REPORT = BH / "perf-lock-report.json"
TAKE = BH / "source-backhalf-48k.wav"
SPLIT_S = 55.06
MAX_SHIFT_S = 0.25    # calibrated: 150ms clamped 4/23 phrase snaps; 250ms only 1
MAX_BOOST = 8.0       # asymmetric — only frames the render actually VOICES get lifted


def write_wav(path: Path, mono, sr: int) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(v * 32767))))
                               for v in mono))


def candidate_windows(cand: dict, rest_split_s: float = 0.35) -> list:
    """Phrase windows for one candidate, on the take's timeline (chunk-score windows
    rebased by each chunk's assembly offset). rest_split_s=0.05 yields the score's
    SUNG spans (every real rest splits) — the reachable-target mask for metrics."""
    wins = []
    for ch in cand["chunks"]:
        doc = json.loads((SCORES / f"{ch['name']}.json").read_text())
        clip = doc[0] if isinstance(doc, list) else doc
        off = float(ch["offsetS"])
        wins += [(round(a + off, 3), round(b + off, 3), n)
                 for a, b, n in ov.phrase_windows_from_score(clip, rest_split_s=rest_split_s)]
    return wins


def candidate_events(cand: dict) -> list:
    """Word events [(start, end)] on the take's timeline — one per note_type-2 event,
    the end extended through its continuation (type-3) run. The slot-snap unit."""
    events = []
    for ch in cand["chunks"]:
        doc = json.loads((SCORES / f"{ch['name']}.json").read_text())
        clip = doc[0] if isinstance(doc, list) else doc
        off = float(ch["offsetS"])
        durs = [float(d) for d in clip["duration"].split()]
        types = [int(x) for x in clip["note_type"].split()]
        t, cur = 0.0, None
        for d, nt in zip(durs, types):
            if nt == 2:
                if cur:
                    events.append(cur)
                cur = [round(t + off, 4), round(t + d + off, 4)]
            elif nt == 3 and cur:
                cur[1] = round(t + d + off, 4)
            elif nt == 1 and cur:
                events.append(cur)
                cur = None
            t += d
        if cur:
            events.append(cur)
    return [(a, b) for a, b in events]


def masked_env_corr(env_t: list, sig: list, sr: int, voiced: list) -> float:
    """Envelope correlation restricted to the score's SUNG spans — the honest target:
    the d5 hold cap DELIBERATELY rests the tail of long held notes, so the raw take
    envelope is not fully reachable and unmasked envCorr has a structural ceiling."""
    import math
    env_o = skcore.energy_envelope(sig, sr)
    n = min(len(env_t), len(env_o))
    mask = [False] * n
    for a, b, _ in voiced:
        for i in range(max(0, int(a / ov.HOP_S)), min(n, int(b / ov.HOP_S))):
            mask[i] = True
    xs = [(env_t[i], env_o[i]) for i in range(n) if mask[i]]
    if len(xs) < 2:
        return 0.0
    ma = sum(a for a, _ in xs) / len(xs)
    mb = sum(b for _, b in xs) / len(xs)
    cov = sum((a - ma) * (b - mb) for a, b in xs)
    va = sum((a - ma) ** 2 for a, _ in xs)
    vb = sum((b - mb) ** 2 for _, b in xs)
    return cov / math.sqrt(va * vb) if va > 0 and vb > 0 else 0.0


def lock() -> int:
    take, sr = skcore.read_pcm_mono(str(TAKE))
    env_t = skcore.energy_envelope(take, sr)
    man = json.loads(MANIFEST.read_text())
    report = {"takeS": round(len(take) / sr, 2), "candidates": []}
    for cand in man["candidates"]:
        key = cand["key"]
        wav = SERVE / f"voice-writer-{key}.wav"
        rend, sr_r = skcore.read_pcm_mono(str(wav))
        rend = ov.resample_linear(rend, sr_r, sr)
        env_r = skcore.energy_envelope(rend, sr)

        glag = ov.global_lag(env_t, env_r, ov.HOP_S, max_lag_s=0.5)
        assert abs(glag) < 0.4, f"{key}: render {glag:.2f}s off the take's timeline — wrong file?"

        wins = candidate_windows(cand)
        shifts = ar.phrase_shifts(env_t, env_r, wins, max_shift_s=MAX_SHIFT_S)
        aligned = ar.apply_shifts(rend, sr, wins, shifts, total_s=len(take) / sr)
        # strict round: after phrase starts, snap each WORD onto its slot's exact start
        events = candidate_events(cand)
        syl_lags = perform.event_lags(take, aligned, sr, events)
        snapped = perform.snap_to_events(take, aligned, sr, events)
        out = perform.transfer_envelope(take, snapped, sr, max_boost=MAX_BOOST)

        peak = max(abs(v) for v in out) or 1.0
        if peak > 0.99:
            out = [v * 0.99 / peak for v in out]

        corr0 = perform.env_corr(take, rend, sr)
        corr1 = perform.env_corr(take, aligned, sr)
        corr2 = perform.env_corr(take, out, sr)
        voiced = candidate_windows(cand, rest_split_s=0.05)
        sung0 = masked_env_corr(env_t, rend, sr, voiced)
        sung2 = masked_env_corr(env_t, out, sr, voiced)
        perf_wav = SERVE / f"voice-writer-{key}-perf.wav"
        write_wav(perf_wav, out, sr)
        ab_mix.stereo_ab(str(TAKE), str(perf_wav), str(SERVE / f"ab-perf-{key}.wav"),
                         sr=sr, right_gain=0.9)

        abs_ms = sorted(abs(s) * 1000 for s in shifts)
        syl_ms = sorted(abs(s) * 1000 for s in syl_lags)
        entry = {"key": key, "phrases": len(wins), "globalLagMs": round(glag * 1000, 1),
                 "shiftMedianMs": round(statistics.median(abs_ms), 1),
                 "shiftP90Ms": round(abs_ms[int(0.9 * (len(abs_ms) - 1))], 1),
                 "words": len(events),
                 "sylSnapMedianMs": round(statistics.median(syl_ms), 1) if syl_ms else 0.0,
                 "sylSnapP90Ms": round(syl_ms[int(0.9 * (len(syl_ms) - 1))], 1) if syl_ms else 0.0,
                 "envCorr": {"before": round(corr0, 3), "aligned": round(corr1, 3),
                             "after": round(corr2, 3)},
                 "envCorrSung": {"before": round(sung0, 3), "after": round(sung2, 3)},
                 "peakScaled": peak > 0.99}
        report["candidates"].append(entry)
        print(f"{key}: envCorr {corr0:.3f} -> {corr1:.3f} (aligned) -> {corr2:.3f} (perf) | "
              f"sung-spans {sung0:.3f} -> {sung2:.3f} | "
              f"{len(wins)} phrases shift med {entry['shiftMedianMs']}ms p90 {entry['shiftP90Ms']}ms | "
              f"{len(events)} words syl-snap med {entry['sylSnapMedianMs']}ms "
              f"p90 {entry['sylSnapP90Ms']}ms", flush=True)
    REPORT.write_text(json.dumps(report, indent=2))
    print(f"report -> {REPORT}", flush=True)
    return 0


def page() -> int:
    man = json.loads(MANIFEST.read_text())
    rep = {c["key"]: c for c in json.loads(REPORT.read_text())["candidates"]}
    cards = []
    for cand in man["candidates"]:
        key = cand["key"]
        r = rep[key]
        for suffix in ("-perf",):
            src = SERVE / f"voice-writer-{key}{suffix}.wav"
            subprocess.run(["ffmpeg", "-y", "-i", str(src),
                            str(KIT / "demo-clips" / f"writer-{key}{suffix}.wav")],
                           check=True, capture_output=True)
            subprocess.run(["ffmpeg", "-y", "-i", str(src), "-af",
                            f"adelay={int(SPLIT_S * 1000)}:all=1",
                            str(KIT / "demo-clips-padded-to-song-start" / f"writer-{key}{suffix}.wav")],
                           check=True, capture_output=True)
        rows = "".join(
            f"<tr><td class='idx'>L{w['index']}</td>"
            f"<td class='txt'>{html.escape(w['text'])}</td>"
            f"<td class='sim'>{('%.2f' % w['mouthSim']) if w.get('mouthSim') is not None else ''}</td></tr>"
            for w in cand["words"])
        ec = r["envCorr"]
        mouth = cand.get("mouthSimMean")
        mouth_txt = f"mouth echo {mouth:.2f} (old round 0.36) · " if mouth else ""
        syl_txt = (f" · syllable snap med {r['sylSnapMedianMs']:.0f} ms"
                   if r.get("sylSnapMedianMs") is not None else "")
        cards.append(f"""
      <div class="card">
        <div class="chead"><span class="tag">{key}</span><h2>{html.escape(cand['label'])} — mouth-matched + performance-locked</h2>
          <span class="stat">{mouth_txt}envCorr {ec['before']:.2f} → {ec['after']:.2f} · phrase snap med {r['shiftMedianMs']:.0f} ms{syl_txt}</span></div>
        <audio controls preload="metadata" src="voice-writer-{key}-perf.wav"></audio>
        <div class="row"><span>overlay — your mumble LEFT, locked render RIGHT</span>
          <audio controls preload="metadata" src="ab-perf-{key}.wav"></audio></div>
        <details><summary style="color:#8b949e;font-size:13px;cursor:pointer;margin-top:8px">the lines (with per-line mouth echo)</summary>
        <table><tbody>{rows}</tbody></table></details>
      </div>""")
    if (SERVE / "voice-writer-A-perf.wav").is_file():
        cards.append("""
      <div class="card">
        <div class="chead"><span class="tag">A</span><h2>last round's pick (mouth-blind words, performance-locked)</h2>
          <span class="stat">mouth echo 0.36 · envCorr 0.31 → 0.70</span></div>
        <audio controls preload="metadata" src="voice-writer-A-perf.wav"></audio>
        <div class="row"><span>overlay — your mumble LEFT, A RIGHT</span>
          <audio controls preload="metadata" src="ab-perf-A.wav"></audio></div>
      </div>""")
    cal_json = BH / "regrid-calibrate.json"
    if cal_json.is_file():
        cal = json.loads(cal_json.read_text())
        blocks = []
        for ph in cal["phrases"]:
            vars_html = "".join(f"""
        <div class="grow"><div class="ghead"><span class="tag">variant {v['variant']}</span>
          <b>{v['clicks']} clicks</b></div>
          <audio controls preload="none" src="{v['wav']}"></audio></div>"""
                                for v in ph["variants"])
            blocks.append(f"""
      <div class="card">
        <div class="chead"><span class="tag">L{ph['index']}</span>
          <h2>calibration phrase — which variant's clicks match your syllables?</h2>
          <span class="gspan">{ph['startS']:.1f}–{ph['endS']:.1f}s</span></div>
        {vars_html}
      </div>""")
        cards.append(f"""
      <div class="card">
        <div class="chead"><h2>DETECTOR CALIBRATION — the new grid, picked by your ear</h2></div>
        <p class="blurb">The grid is being rebuilt from scratch. For each phrase below, three
           BLIND variants place clicks where a different detector hears your syllables
           (mumble LEFT, mumble + clicks RIGHT). Reply per phrase with the variant whose
           clicks match what you sang — e.g. “L9: 2, L7: 1, L2: 3, L4: 2”.</p>
      </div>{''.join(blocks)}""")
    grid_json = BH / "grid-check.json"
    if grid_json.is_file():
        g = json.loads(grid_json.read_text())
        rows = sorted(g["rows"], key=lambda r: (not r["suspect"], r["index"]))
        items = []
        for r in rows:
            badge = (f"<span class='sus'>CHECK: {html.escape('; '.join(r['reasons']))}</span>"
                     if r["suspect"] else "<span class='oksus'>detectors agree</span>")
            heard = f" · heard: “{html.escape(r['heardText'])}”" if r.get("heardText") else ""
            items.append(f"""
        <div class="grow">
          <div class="ghead"><span class="tag">L{r['index']}</span>
            <b>{r['slots']} syllables</b> {badge}
            <span class="gspan">{r['startS']:.1f}–{r['endS']:.1f}s{heard}</span></div>
          <audio controls preload="none" src="{r['wav']}"></audio>
        </div>""")
        cards.append(f"""
      <div class="card">
        <div class="chead"><h2>GRID CHECK — verify the syllable counts before the next render</h2></div>
        <p class="blurb">Every strictness gate measures against this grid, and you said some counts
           feel wrong. Each phrase below: your mumble LEFT, your mumble + a CLICK at every counted
           syllable RIGHT. Count against your own ear and reply in chat with corrections
           (e.g. “L3 is 9, L14 is 3”) or “grid good”. Flagged phrases first.</p>
        {''.join(items)}
      </div>""")
    (SERVE / "index.html").write_text(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Used2 — strict round: verify the grid, hear the timing lock</title>
<style>
  body{{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
  .wrap{{max-width:820px;margin:0 auto;padding:26px 20px 80px}}
  h1{{font-size:22px;margin:0 0 4px}} .sub{{color:#8b949e;margin:0 0 22px}}
  .card{{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px 18px;margin:0 0 16px}}
  .chead{{display:flex;align-items:center;gap:10px;flex-wrap:wrap}} .chead h2{{font-size:16px;margin:0}}
  .tag{{background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb55;border-radius:6px;padding:1px 8px;font-weight:700}}
  .stat{{margin-left:auto;font-size:12px;color:#3fb950}}
  audio{{width:100%;margin-top:8px}}
  .row{{margin-top:10px}} .row span{{font-size:12px;color:#8b949e}}
  table{{width:100%;border-collapse:collapse;font-size:13px}} td{{padding:5px 8px;border-top:1px solid #21262d}}
  .idx{{color:#6e7681;width:34px}} .txt{{font-weight:600}} .sim{{color:#8b949e;width:44px;text-align:right}}
  .blurb{{color:#8b949e;font-size:13px;margin:6px 0 10px}}
  .grow{{border-top:1px solid #21262d;padding:8px 0}}
  .ghead{{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}}
  .gspan{{color:#6e7681;font-size:12px;margin-left:auto}}
  .sus{{background:#f8514922;color:#f85149;border:1px solid #f8514955;border-radius:6px;padding:0 6px;font-size:11px}}
  .oksus{{color:#3fb950;font-size:11px}}
  .ref h2{{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 8px}}
</style></head><body><div class="wrap">
  <h1>Used2 — strict round</h1>
  <p class="sub">M1/M2 below are now SYLLABLE-TIMING-LOCKED: every word snapped onto its
     slot's exact start (median correction ~44 ms/word), on top of the phrase snap and your
     volume/attack/decay envelope. The GRID CHECK section at the bottom is the gate for the
     next render — verify the counts, reply with corrections or “grid good”.
     Kit: writer-M1/M2-perf.wav (plain + padded).</p>
  <div class="card ref"><h2>Raw back half (your take, reference)</h2>
    <audio controls preload="metadata" src="back-half/source-backhalf-48k.wav"></audio></div>
  {''.join(cards)}
</div></body></html>""")
    print(f"page + kit delivery done ({len(cards)} candidates)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(page() if "page" in sys.argv else lock())
