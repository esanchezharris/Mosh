#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import os
import subprocess
import struct
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import diagnose  # noqa: E402
import template  # noqa: E402
from skeleton import align as skalign  # noqa: E402
from skeleton import core as skcore  # noqa: E402

DEFAULT_ROOT = os.path.expanduser("~/mosh-fms-ksb/used2")
DEFAULT_RAW = "nofx-whisper.json"
DEFAULT_CORRECTED = "nofx-whisper-corrected.json"
DEFAULT_AUDIO = "nofx.wav"
DEFAULT_TRANSIENTS = "nofx-librosa.json"
DEFAULT_OUT = "nofx-aligned-corrected.json"
DEFAULT_SPLIT = "used2-split.json"
DEFAULT_REVIEW = "nofx-placement-review.json"
DEFAULT_REVIEW_PAGE = os.path.join("listen", "corrected-alignment-review.html")
DEFAULT_SPLIT_IDX = 124
DEFAULT_SPLIT_TIME = 55.06
DEFAULT_BPM = 138.0
DEFAULT_SKELETON_PY = os.path.expanduser("~/Library/Mosh/venvs/skeleton/bin/python3")


def _load_json(path: str):
    with open(path) as f:
        return json.load(f)


def _normalize_words(data: dict) -> list[dict]:
    out = []
    for i, item in enumerate(data.get("words") or []):
        out.append({
            "word": str(item.get("word", "")),
            "start": float(item.get("start", 0.0)),
            "end": float(item.get("end", 0.0)),
            "confidence": float(item.get("confidence", 0.0) or 0.0),
            "deleted": bool(item.get("deleted", False)),
            "sourceIndex": int(item.get("sourceIndex", i)),
        })
    return out


def _word_texts(words: list[dict]) -> list[str]:
    return [w["word"] for w in words if w["word"].strip()]


def _nearest_transient(t: float, transients: list[float], window: float) -> float | None:
    near = [x for x in transients if abs(x - t) <= window]
    if not near:
        return None
    return min(near, key=lambda x: abs(x - t))


def _snap_word_starts(aligned: list[dict], transients: list[float], window: float = 0.06,
                      min_span: float = 0.03) -> tuple[list[dict], list[dict]]:
    if not transients:
        return [dict(w) for w in aligned], []
    out = [dict(w) for w in aligned]
    changes = []
    for i, word in enumerate(out):
        raw_start = float(word["start"])
        raw_end = float(word["end"])
        prev_end = float(out[i - 1]["end"]) if i > 0 else -1e9
        nxt_start = float(out[i + 1]["start"]) if i + 1 < len(out) else 1e9
        cand = _nearest_transient(raw_start, transients, window)
        if cand is None:
            continue
        if cand <= prev_end + 0.005:
            continue
        if cand >= min(raw_end - min_span, nxt_start - 0.005):
            continue
        word["start"] = round(cand, 4)
        if word["end"] <= word["start"]:
            word["end"] = round(max(raw_end, word["start"] + min_span), 4)
        changes.append({
            "word": word["word"],
            "index": i,
            "raw_start": round(raw_start, 4),
            "snapped_start": round(word["start"], 4),
            "delta_ms": round((word["start"] - raw_start) * 1000, 1),
        })
    return out, changes


def _load_f0(audio_path: str):
    sk_py = diagnose._venv_python("skeleton/.skeleton.env", "SKELETON_PY")
    if not sk_py and os.path.isfile(DEFAULT_SKELETON_PY):
        sk_py = DEFAULT_SKELETON_PY
    cli = os.path.join(REPO, "service", "skeleton", "skeleton_cli.py")
    if not sk_py or not os.path.isfile(cli):
        return None
    try:
        res = diagnose._run_json(sk_py, cli, audio_path)
    except Exception:
        return None
    return res.get("f0") if res.get("ok") else None


def _slice_excerpt(src: str, end_s: float, dst: str) -> str:
    mono_sr = skcore.read_pcm_mono(src)
    if not mono_sr:
        raise RuntimeError(f"audio not stdlib-readable: {src}")
    mono, sr = mono_sr
    seg = mono[:int(end_s * sr)]
    with wave.open(dst, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(
            b"".join(
                struct.pack("<h", max(-32767, min(32767, int(v * 32767))))
                for v in seg
            )
        )
    return dst


def _align_words_via_skeleton(audio_path: str, words: list[str]) -> list[dict] | None:
    sk_py = diagnose._venv_python("skeleton/.skeleton.env", "SKELETON_PY")
    if not sk_py and os.path.isfile(DEFAULT_SKELETON_PY):
        sk_py = DEFAULT_SKELETON_PY
    if not sk_py or not words:
        return None
    code = (
        "import json, os, sys; "
        f"sys.path.insert(0, {REPO!r}); "
        f"sys.path.insert(0, {os.path.join(REPO, 'service')!r}); "
        "from skeleton import align as a; "
        "audio = sys.argv[1]; "
        "words = json.loads(sys.argv[2]); "
        "res = a.align_words(audio, words); "
        "print(json.dumps(res))"
    )
    run = subprocess.run(
        [sk_py, "-c", code, audio_path, json.dumps(words)],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if run.returncode != 0:
        raise RuntimeError(run.stderr.strip() or "skeleton venv aligner failed")
    out = (run.stdout or "").strip()
    return json.loads(out) if out else None


def _review_html(audio_name: str, split: dict, rows: list[dict], changes: list[dict], review: dict) -> str:
    body_rows = "".join(
        "<tr>"
        f"<td>{i}</td>"
        f"<td>{html.escape(r['word'])}</td>"
        f"<td>{r['sourceIndex']}</td>"
        f"<td>{r['rawStart']:.2f}</td>"
        f"<td>{r['alignedStart']:.2f}</td>"
        f"<td>{r['alignedEnd']:.2f}</td>"
        f"<td>{r['deltaMs']:+.1f}</td>"
        f"<td>{r['score']:.3f}</td>"
        "</tr>"
        for i, r in enumerate(rows)
    )
    change_items = "".join(
        f"<li>{html.escape(c['word'])}: {c['raw_start']:.2f}s → {c['snapped_start']:.2f}s ({c['delta_ms']:+.1f}ms)</li>"
        for c in changes[:18]
    ) or "<li>No onset snapping changes landed.</li>"
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Used2 corrected alignment review</title>
<style>
 :root{{color-scheme:dark}}
 body{{margin:0;background:#0f1116;color:#e8ebf3;font:15px/1.45 -apple-system,system-ui,sans-serif}}
 .wrap{{max-width:1040px;margin:0 auto;padding:34px 18px 64px}}
 .card{{background:#16181f;border:1px solid #252934;border-radius:16px;padding:16px 18px;margin:0 0 16px}}
 h1{{margin:0 0 4px;font-size:24px}} .sub{{margin:0 0 16px;color:#9097a7;font-size:13px}}
 .meta{{display:flex;gap:14px;flex-wrap:wrap;color:#9097a7;font-size:12px;margin-top:10px}}
 audio{{width:100%;margin-top:10px}}
 table{{width:100%;border-collapse:collapse;font-size:12px}}
 td,th{{border:1px solid #2a2f3c;padding:6px 8px;text-align:right}}
 td:nth-child(2),th:nth-child(2){{text-align:left}}
 ul{{margin:0;padding-left:18px}} li{{margin:4px 0}}
</style></head><body><div class="wrap">
  <h1>Used2 corrected alignment review</h1>
  <p class="sub">Corrected words through the owner-confirmed split only. This page is for quick sanity checks before the next calibration/template pass.</p>
  <div class="card">
    <audio controls preload="auto" src="{html.escape(audio_name)}"></audio>
    <div class="meta">
      <span>split source index {split['split_word_idx']}</span>
      <span>split time {split['split_time_s']:.2f}s</span>
      <span>real words {split['real_word_count']}</span>
      <span>mumble words {split['mumble_word_count']}</span>
      <span>transients {review['transientCount']}</span>
      <span>f0 {'yes' if review['f0Available'] else 'no'}</span>
    </div>
  </div>
  <div class="card">
    <h2>Onset snapping changes</h2>
    <ul>{change_items}</ul>
  </div>
  <div class="card">
    <h2>Aligned real-word spans</h2>
    <table>
      <tr><th>#</th><th>word</th><th>src</th><th>raw</th><th>aligned</th><th>end</th><th>delta ms</th><th>score</th></tr>
      {body_rows}
    </table>
  </div>
</div></body></html>"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--raw", default=DEFAULT_RAW)
    ap.add_argument("--corrected", default=DEFAULT_CORRECTED)
    ap.add_argument("--audio", default=DEFAULT_AUDIO)
    ap.add_argument("--transients", default=DEFAULT_TRANSIENTS)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--split-out", default=DEFAULT_SPLIT)
    ap.add_argument("--review-out", default=DEFAULT_REVIEW)
    ap.add_argument("--review-page", default=DEFAULT_REVIEW_PAGE)
    ap.add_argument("--split-word-idx", type=int, default=DEFAULT_SPLIT_IDX)
    ap.add_argument("--split-time-s", type=float, default=DEFAULT_SPLIT_TIME)
    ap.add_argument("--bpm", type=float, default=DEFAULT_BPM)
    args = ap.parse_args()

    root = os.path.abspath(os.path.expanduser(args.root))
    raw_words = _normalize_words(_load_json(os.path.join(root, args.raw)))
    corrected_path = os.path.join(root, args.corrected)
    corrected_words = _normalize_words(_load_json(corrected_path)) if os.path.isfile(corrected_path) else raw_words
    transients_path = os.path.join(root, args.transients)
    transients = list(_load_json(transients_path)) if os.path.isfile(transients_path) else []

    active = [w for w in corrected_words if not w["deleted"]]
    real_words = [w for w in active if w["sourceIndex"] <= args.split_word_idx and w["word"].strip()]
    mumble_words = [w for w in active if w["sourceIndex"] > args.split_word_idx and w["word"].strip()]
    deleted_words = [w for w in corrected_words if w["deleted"]]

    split_payload = {
        "split_word_idx": args.split_word_idx,
        "split_time_s": args.split_time_s,
        "real_word_count": len(real_words),
        "mumble_word_count": len(mumble_words),
        "real_words": real_words,
        "mumble_words": mumble_words,
        "deleted_words": deleted_words,
    }
    with open(os.path.join(root, args.split_out), "w") as f:
        json.dump(split_payload, f, indent=2)

    audio_path = os.path.join(root, args.audio)
    excerpt_end = max(args.split_time_s, float(real_words[-1]["end"]) if real_words else args.split_time_s)
    with tempfile.TemporaryDirectory() as td:
        excerpt_path = _slice_excerpt(audio_path, excerpt_end, os.path.join(td, "used2-real.wav"))
        aligned = _align_words_via_skeleton(excerpt_path, _word_texts(real_words))
    if aligned is None:
        raise SystemExit("forced alignment unavailable in the skeleton venv")

    snapped, changes = _snap_word_starts(aligned, transients)
    with open(os.path.join(root, args.out), "w") as f:
        json.dump(snapped, f, indent=2)

    f0 = _load_f0(audio_path)
    units = [{"word": w["word"]} for w in real_words]
    template_words = template.build_template_wordsfirst(
        units,
        snapped,
        transients=transients,
        f0=f0,
        bpm=args.bpm,
    )

    compare_rows = []
    raw_by_source = {w["sourceIndex"]: w for w in raw_words}
    for src_word, aligned_word in zip(real_words, snapped):
        raw = raw_by_source.get(src_word["sourceIndex"], src_word)
        compare_rows.append({
            "word": aligned_word["word"],
            "sourceIndex": src_word["sourceIndex"],
            "rawStart": float(raw["start"]),
            "alignedStart": float(aligned_word["start"]),
            "alignedEnd": float(aligned_word["end"]),
            "deltaMs": round((float(aligned_word["start"]) - float(raw["start"])) * 1000, 1),
            "score": float(aligned_word.get("score", 0.0) or 0.0),
        })

    review = {
        "root": root,
        "audio": audio_path,
        "correctedSource": corrected_path if os.path.isfile(corrected_path) else None,
        "f0Available": bool(f0),
        "transientCount": len(transients),
        "alignedRealWords": len(snapped),
        "onsetSnapChanges": changes,
        "compareRows": compare_rows,
        "templateWordsFirst": template_words,
    }
    with open(os.path.join(root, args.review_out), "w") as f:
        json.dump(review, f, indent=2)

    page_path = os.path.join(root, args.review_page)
    os.makedirs(os.path.dirname(page_path), exist_ok=True)
    with open(page_path, "w") as f:
        f.write(_review_html(os.path.basename(args.audio), split_payload, compare_rows, changes, review))

    print(json.dumps({
        "ok": True,
        "aligned_out": os.path.join(root, args.out),
        "split_out": os.path.join(root, args.split_out),
        "review_out": os.path.join(root, args.review_out),
        "review_page": page_path,
        "real_words": len(real_words),
        "snap_changes": len(changes),
        "f0_available": bool(f0),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
