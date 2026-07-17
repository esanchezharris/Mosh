#!/usr/bin/env python3
"""V2 of the mechanism-verify spec — the DECISIVE experiment: same lyric, same melody,
same render arm; ONLY the duration vector changes (mumble-slot vs the owner's real gold
performance). One blind listen gives the ceiling of the current architecture.

Given the V1 gold WAV (the owner singing one nominated line naturally over the beat):
  1. Forced-align the gold with the line's words; per-word syllable slots (even split,
     annotator-correctable via --marks).
  2. Author the ORACLE clip: the baseline chunk with the line's note durations replaced
     from gold. `note_pitch` copied VERBATIM (= "same melody"). Note-count mapping
     (registered, pure, golden-tested): k==m 1:1 · m>k fold tail into the last note ·
     k>m surplus type-3 continuations DROPPED (logged). Inter-word gaps from GOLD —
     natural P-center placement is the mechanism under test. The line anchors at the
     baseline line START (phrase-level "take is a spec" is preserved); the following rest
     absorbs the length delta so every other line keeps its baseline position.
  3. Render BOTH the unmodified baseline chunk and the oracle chunk through the identical
     local MLX score-mode arm, then NSF `perform` each with the F0 of the human
     performance that defined its timing (baseline ← the take, oracle ← the gold) — the
     arm-symmetric reading of "the identical SoulX→NSF-perform arm" (perform requires
     timing-locked F0, and the oracle's timing IS gold's).
  4. Emit a BLIND 3-way listen page (labels randomized; unblinding map in a side JSON not
     linked from the page) + V0-style vowel metrics on both rendered arms (JSON only).

Usage (base python3, from scripts/fms-killshot/):
  python3 oracle_duration.py --gold .../mechanism/v1/gold.wav \
      --chunk .../scores/u2full-c03.json --line 37.9:41.3 \
      [--out .../mechanism/v2] [--marks marks.json] [--skip-render] [--skip-nsf]
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import random
import subprocess
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import vowel_landmark as vl  # noqa: E402
from v1_kit import slice_wav  # noqa: E402

ROOT = os.path.expanduser("~/mosh-fms-ksb/used2")
TAKE = os.path.join(ROOT, "asserted-proof", "fresh", "u2-full-mumble.wav")
NSF_PY = os.path.expanduser(os.environ.get("NSF_PY", "~/Library/Mosh/venvs/nsf/bin/python3"))
NSF_CLI = os.path.join(REPO, "service", "nsf", "nsf_cli.py")
NSF_MODEL = os.path.expanduser(os.environ.get(
    "NSF_MODEL", "~/AI/pc-nsf-hifigan/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02/model.ckpt"))
MIN_REST = 0.05
GAP_REST = 0.01

# ── pure core ──────────────────────────────────────────────────────────────────────────


def parse_notes(clip):
    """Clip -> [{dur, text, phon, pitch, type}] preserving token order."""
    durs = [float(d) for d in clip["duration"].split()]
    texts = clip["text"].split()
    phons = clip["phoneme"].split()
    types = [int(x) for x in clip["note_type"].split()]
    pitches = clip["note_pitch"].split()
    if not (len(texts) == len(phons) == len(types) == len(pitches) == len(durs)):
        raise ValueError("token streams disagree")
    return [{"dur": d, "text": tx, "phon": ph, "pitch": p, "type": nt}
            for d, tx, ph, p, nt in zip(durs, texts, phons, pitches, types)]


def quantize_4dp(durs, target_sum):
    """author_score's error-diffusion: 4dp tokens whose SUM is exactly target_sum (4dp)."""
    out, carry = [], 0.0
    for d in durs[:-1]:
        q = round(d + carry, 4)
        carry = (d + carry) - q
        out.append(q)
    out.append(round(target_sum - sum(out), 4))
    if out and out[-1] < 0:
        raise ValueError(f"quantize underflow: {out[-1]}")
    return out


def emit_clip(notes, time_ms, index, language="English"):
    total = (time_ms[1] - time_ms[0]) / 1000.0
    durs = quantize_4dp([n["dur"] for n in notes], round(total, 4))
    return {
        "index": index, "language": language, "time": list(time_ms),
        "duration": " ".join(f"{d:.4f}" for d in durs),
        "text": " ".join(n["text"] for n in notes),
        "phoneme": " ".join(n["phon"] for n in notes),
        "note_pitch": " ".join(str(n["pitch"]) for n in notes),
        "note_type": " ".join(str(n["type"]) for n in notes),
    }


def word_units(notes, i0, i1):
    """Group notes[i0:i1] into word units [{idx: [note indices], word}]; rests excluded.
    A unit = a type-2 note + its following type-3 run."""
    units, cur = [], None
    for i in range(i0, i1):
        n = notes[i]
        if n["type"] == 2:
            if cur:
                units.append(cur)
            cur = {"word": n["text"], "idx": [i]}
        elif n["type"] == 3 and cur:
            cur["idx"].append(i)
        elif n["type"] == 1 and cur:
            units.append(cur)
            cur = None
    if cur:
        units.append(cur)
    return units


def find_line(notes, a, b):
    """(i0, i1) — the note range whose WORD units lie fully inside chunk-local [a, b],
    bounded by rests (or the chunk edges). Raises if the window cuts a word."""
    t, spans = 0.0, []
    for n in notes:
        spans.append((t, t + n["dur"]))
        t += n["dur"]
    idx = [i for i, n in enumerate(notes)
           if n["type"] != 1 and spans[i][0] >= a - 1e-6 and spans[i][1] <= b + 1e-6]
    if not idx:
        raise ValueError("no sung notes inside the line window")
    i0, i1 = min(idx), max(idx) + 1
    if notes[i0]["type"] == 3:
        raise ValueError("line window cuts a word (starts on a continuation)")
    if i0 > 0 and notes[i0 - 1]["type"] != 1:
        raise ValueError("line not rest-bounded on the left")
    if i1 < len(notes) and notes[i1]["type"] == 3:
        raise ValueError("line window cuts a word (ends before a continuation)")
    return i0, i1


def even_slots(a, b, m):
    step = (b - a) / m
    return [(a + i * step, a + (i + 1) * step) for i in range(m)]


def map_word_durations(note_durs, gold_slot_durs):
    """Registered mapping -> (mapped_durs, n_dropped). k==m 1:1; m>k fold the tail into
    the last note; k>m drop the surplus continuation notes."""
    k, m = len(note_durs), len(gold_slot_durs)
    if k == m:
        return list(gold_slot_durs), 0
    if m > k:
        return list(gold_slot_durs[:k - 1]) + [sum(gold_slot_durs[k - 1:])], 0
    return list(gold_slot_durs), k - m


def build_oracle_line(notes, i0, i1, gold_words):
    """The line's replacement notes: durations/gaps from gold (gold-relative offsets),
    pitches/phonemes/types from the baseline (surplus continuations dropped).
    gold_words = [{start, end, slots: [dur, ...]}] aligned 1:1 with the line's word units.
    -> (new_notes, log)"""
    units = word_units(notes, i0, i1)
    if len(units) != len(gold_words):
        raise ValueError(f"word-count mismatch: line {len(units)} vs gold {len(gold_words)}")
    out, log = [], {"dropped_notes": 0, "gap_rests": 0, "folds": 0}
    g0 = gold_words[0]["start"]
    prev_end = None
    for u, g in zip(units, gold_words):
        if prev_end is not None:
            gap = g["start"] - prev_end
            if gap >= GAP_REST:
                out.append({"dur": gap, "text": "<SP>", "phon": "<SP>", "pitch": "0", "type": 1})
                log["gap_rests"] += 1
            elif gap > 0 and out:
                out[-1] = dict(out[-1], dur=out[-1]["dur"] + gap)
        note_durs = [notes[i]["dur"] for i in u["idx"]]
        mapped, dropped = map_word_durations(note_durs, g["slots"])
        log["dropped_notes"] += dropped
        if len(g["slots"]) > len(note_durs):
            log["folds"] += 1
        for j, d in enumerate(mapped):
            src = notes[u["idx"][j]]
            out.append(dict(src, dur=d))
        prev_end = g["end"]
    log["gold_line_dur"] = round(gold_words[-1]["end"] - g0, 4)
    return out, log


def splice_line(notes, i0, i1, new_line, min_rest=MIN_REST):
    """Replace notes[i0:i1] with new_line; the FOLLOWING rest absorbs the length delta so
    the chunk total (and every later line's position) is unchanged. Raises on overhang."""
    old_dur = sum(n["dur"] for n in notes[i0:i1])
    new_dur = sum(n["dur"] for n in new_line)
    out = notes[:i0] + [dict(n) for n in new_line] + [dict(n) for n in notes[i1:]]
    j = i0 + len(new_line)
    delta = old_dur - new_dur
    if j < len(out) and out[j]["type"] == 1:
        absorbed = out[j]["dur"] + delta
        if absorbed < min_rest:
            raise ValueError(f"oracle line overhang: following rest would be {absorbed:.3f}s")
        out[j] = dict(out[j], dur=absorbed)
    elif abs(delta) > 0.02 and j < len(out):
        raise ValueError("line not followed by a rest — cannot absorb the length delta")
    return out


# ── driver helpers ─────────────────────────────────────────────────────────────────────


def ffmpeg_norm(src, dst, sr=44100):
    subprocess.run(["ffmpeg", "-y", "-i", src, "-ac", "1", "-ar", str(sr),
                    "-c:a", "pcm_s16le", dst], capture_output=True, check=True)
    return dst


def nsf_available():
    return os.path.isfile(NSF_MODEL) and os.path.isfile(NSF_CLI) and os.path.isfile(NSF_PY)


def nsf_perform(in_wav, out_wav, f0_wav):
    r = subprocess.run([NSF_PY, NSF_CLI, in_wav, out_wav, "perform", f0_wav],
                       capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError(f"nsf perform failed: {(r.stderr or '')[-400:]}")


def gold_word_slots(cache, gold_wav, words, syllables, marks=None):
    """Forced-align gold; split each word span into syllable slots (even split, or by
    annotator --marks times falling inside the span)."""
    aligned = vl.align_words_probe(cache, gold_wav, words)
    bad = [(w["word"], w["score"]) for w in aligned if float(w.get("score", 0)) < 0.2]
    if bad:
        raise RuntimeError(f"gold alignment weak on {bad} — re-record or check the words")
    out = []
    for al, m in zip(aligned, syllables):
        a, b = float(al["start"]), float(al["end"])
        cuts = sorted(t for t in (marks or []) if a < t < b)
        if len(cuts) == m - 1:
            bounds = [a] + cuts + [b]
            slots = [bounds[i + 1] - bounds[i] for i in range(m)]
        else:
            slots = [d1 - d0 for d0, d1 in even_slots(a, b, m)]
        out.append({"word": al["word"], "start": a, "end": b, "slots": slots,
                    "score": round(float(al.get("score", 0)), 3)})
    return out


def line_span(notes, i0, i1, t0):
    t = 0.0
    starts = []
    for i, n in enumerate(notes):
        starts.append(t)
        t += n["dur"]
    a = starts[i0] + t0
    b = starts[i1 - 1] + notes[i1 - 1]["dur"] + t0
    return a, b


def compact_metrics(cache, render_wav, clip, i0_i1, t0, ref_frames_wav):
    """V0-style medians for the line's words on one rendered arm: onset delta vs the arm's
    own spec (score span) and vs the human reference recording's voicing onsets."""
    notes = parse_notes(clip)
    i0, i1 = i0_i1
    units = word_units(notes, i0, i1)
    starts, t = [], 0.0
    for n in notes:
        starts.append(t)
        t += n["dur"]
    words = [u["word"] for u in units]
    aligned = vl.align_words_probe(cache, render_wav, words)
    rp = vl.frames_pyin(cache, render_wav)
    ref = vl.frames_pyin(cache, ref_frames_wav)
    d_score, d_ref = [], []
    for u, al in zip(units, aligned):
        s = starts[u["idx"][0]] + t0
        e = starts[u["idx"][-1]] + notes[u["idx"][-1]]["dur"] + t0
        r_on, _ = vl.landmarks(rp, float(al["start"]), float(al["end"]), None)
        if r_on is None:
            continue
        d_score.append((r_on - s) * 1000)
        t_on, _ = vl.landmarks(ref, s, e, None)
        if t_on is not None:
            d_ref.append((r_on - t_on) * 1000)
    return {"n": len(d_score),
            "median_onset_delta_score_ms": round(vl.median(d_score), 1) if d_score else None,
            "median_onset_delta_ref_ms": round(vl.median(d_ref), 1) if d_ref else None}


# ── main ───────────────────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", required=True)
    ap.add_argument("--chunk", required=True, help="baseline chunk score json")
    ap.add_argument("--line", required=True, help="SECTION-clock window a:b (seconds)")
    ap.add_argument("--out", default=os.path.join(ROOT, "asserted-proof", "mechanism", "v2"))
    ap.add_argument("--marks", default=None, help="json with {'marks': [t,...]} on the gold clock")
    ap.add_argument("--skip-render", action="store_true")
    ap.add_argument("--skip-nsf", action="store_true")
    args = ap.parse_args()
    out_dir = os.path.abspath(os.path.expanduser(args.out))
    cache = os.path.join(out_dir, "cache")
    os.makedirs(cache, exist_ok=True)

    gold_raw = os.path.abspath(os.path.expanduser(args.gold))
    if not os.path.isfile(gold_raw):
        raise SystemExit(f"V1 gate: gold wav missing at {gold_raw} — record it first "
                         "(mechanism/v1/record.html)")
    gold = ffmpeg_norm(gold_raw, os.path.join(out_dir, "gold-norm.wav"))

    with open(os.path.expanduser(args.chunk)) as f:
        clip = json.load(f)[0]
    t0 = float(clip["time"][0]) / 1000.0
    a, b = (float(x) for x in args.line.split(":"))
    notes = parse_notes(clip)
    i0, i1 = find_line(notes, a - t0, b - t0)
    units = word_units(notes, i0, i1)
    words = [u["word"] for u in units]
    print(f"line words: {words}")

    from phonology.core import Pronouncer
    pr = Pronouncer()
    syls = [max(1, pr.syllables(w)) for w in words]
    marks = None
    if args.marks:
        with open(os.path.expanduser(args.marks)) as f:
            marks = json.load(f).get("marks", [])
    gold_words = gold_word_slots(cache, gold, words, syls, marks)

    oracle_line, log = build_oracle_line(notes, i0, i1, gold_words)
    oracle_notes = splice_line(notes, i0, i1, oracle_line)
    oracle_clip = emit_clip(oracle_notes, clip["time"], f"oracle_{clip['index']}")
    base_clip = emit_clip([dict(n) for n in notes], clip["time"], f"base_{clip['index']}")
    for name, c in (("oracle", oracle_clip), ("baseline", base_clip)):
        total = sum(float(d) for d in c["duration"].split())
        span = (c["time"][1] - c["time"][0]) / 1000.0
        if abs(total - span) > 0.005:
            raise RuntimeError(f"{name}: chain {total:.4f}s != span {span:.4f}s")
        with open(os.path.join(out_dir, f"{name}-score.json"), "w") as f:
            json.dump([c], f, indent=1)
    print(f"authored oracle (mapping log: {log})")

    base_line_span = line_span(notes, i0, i1, t0)
    ora_i1 = i0 + len(oracle_line)
    ora_line_span = line_span(oracle_notes, i0, ora_i1, t0)

    arms = {}
    if not args.skip_render:
        from melisma_probe import render as mlx_render
        for name in ("baseline", "oracle"):
            wav = os.path.join(out_dir, f"{name}-soulx.wav")
            if not os.path.isfile(wav):
                print(f"== render {name}", flush=True)
                mlx_render(f"v2-{name}", os.path.join(out_dir, f"{name}-score.json"), wav)
            arms[name] = wav
        if not args.skip_nsf and nsf_available():
            take_slice = os.path.join(out_dir, "take-line.wav")
            slice_wav(TAKE, take_slice, base_line_span[0] - 0.5, base_line_span[1] + 0.5)
            for name, f0src, span in (("baseline", take_slice, base_line_span),
                                      ("oracle", gold, ora_line_span)):
                # perform needs time-locked F0: slice the render to the line first, then
                # re-vocode at the F0 of the human performance that defined its timing
                sl = os.path.join(out_dir, f"{name}-line.wav")
                slice_wav(arms[name], sl, span[0] - 0.5, span[1] + 0.5)
                out = os.path.join(out_dir, f"{name}-nsf-perform.wav")
                print(f"== nsf perform {name}", flush=True)
                nsf_perform(sl, out, f0src if name == "oracle" else take_slice)
                arms[name] = out
        elif not args.skip_nsf:
            print("NSF model/venv not present — SoulX arms only", flush=True)

    # blind page: slice each arm to its line window (+/-0.5s); gold third arm
    entries = []
    if arms:
        for name, span in (("baseline", base_line_span), ("oracle", ora_line_span)):
            src = arms[name]
            dst = os.path.join(out_dir, f"arm-{name}.wav")
            if src.endswith("nsf-perform.wav"):  # already line-sliced before NSF
                subprocess.run(["cp", src, dst], check=True)
            else:
                slice_wav(src, dst, span[0] - 0.5, span[1] + 0.5)
            entries.append((name, dst))
        g_dst = os.path.join(out_dir, "arm-gold.wav")
        g0, g1 = gold_words[0]["start"], gold_words[-1]["end"]
        slice_wav(gold, g_dst, max(0.0, g0 - 0.5), g1 + 0.5)
        entries.append(("gold", g_dst))

        seed = hashlib.sha256("".join(sorted(
            f"{p}:{os.path.getsize(p)}" for _n, p in entries)).encode()).hexdigest()
        rng = random.Random(seed)
        rng.shuffle(entries)
        labels = {}
        players = ""
        for lab, (name, path) in zip("ABC", entries):
            blind = os.path.join(out_dir, f"clip-{lab}.wav")
            subprocess.run(["cp", path, blind], check=True)
            labels[lab] = name
            players += (f"<div class='card'><h2>Clip {lab}</h2>"
                        f"<audio controls preload='none' src='clip-{lab}.wav'></audio></div>")
        with open(os.path.join(out_dir, "oracle-labels.json"), "w") as f:
            json.dump({"labels": labels, "seed": seed}, f, indent=1)

        page = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>V2 blind listen</title>
<style>
 :root{{color-scheme:dark}}
 body{{margin:0;background:#0f1116;color:#e8ebf3;font:15px/1.45 -apple-system,system-ui,sans-serif}}
 .wrap{{max-width:840px;margin:0 auto;padding:34px 18px 64px}}
 .card{{background:#16181f;border:1px solid #252934;border-radius:16px;padding:16px 18px;margin:0 0 16px}}
 h1{{margin:0 0 4px;font-size:24px}} h2{{margin:0 0 8px;font-size:16px}}
 .sub{{margin:0 0 16px;color:#9097a7;font-size:13px}}
 audio{{width:100%;margin:4px 0 10px}}
</style></head><body><div class="wrap">
  <h1>V2 — blind 3-way listen</h1>
  <p class="sub">Same line, three performances in random order. For each: does it sound like a
  HUMAN performance? Rank the three. Do not open oracle-labels.json until you have ranked.</p>
  {players}
</div></body></html>"""
        with open(os.path.join(out_dir, "oracle-listen.html"), "w") as f:
            f.write(page)

        metrics = {"mapping_log": log,
                   "line_words": words,
                   "base_line_span": [round(x, 3) for x in base_line_span],
                   "oracle_line_span": [round(x, 3) for x in ora_line_span]}
        for name, c, span_clip, ref in (("baseline", base_clip, (i0, i1), TAKE),
                                        ("oracle", oracle_clip, (i0, ora_i1), gold)):
            src = os.path.join(out_dir, f"{name}-soulx.wav")
            if os.path.isfile(src):
                metrics[name] = compact_metrics(cache, src, c, span_clip, t0, ref)
        with open(os.path.join(out_dir, "oracle-metrics.json"), "w") as f:
            json.dump(metrics, f, indent=1)

    print(json.dumps({"ok": True, "out": out_dir, "mapping_log": log,
                      "listen": os.path.join(out_dir, "oracle-listen.html") if arms else None},
                     indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
