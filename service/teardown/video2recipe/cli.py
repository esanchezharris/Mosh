#!/usr/bin/env python3
"""CLI: a tutorial URL/id → a §0 Recipe skeleton + assets (the real §4 pipeline).

  python3 cli.py --url <url|id> --out <dir> [--section START END] [--no-transcribe]
                 [--max-frames N] [--every S]

Writes <out>/<video_id>/recipe.json (+ assets/transcript.json). Needs yt-dlp + cv2 +
tesseract (+ faster-whisper unless --no-transcribe). Emits a JSON summary on stdout.
"""
import json
import os
import sys

_real_stdout = sys.stdout
sys.stdout = sys.stderr  # keep yt-dlp/whisper/cv2 chatter off the JSON channel

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.recipe import to_json  # noqa: E402
from teardown.video2recipe import acquire, assemble_skeleton  # noqa: E402
from teardown.video2recipe import ocr as ocrmod  # noqa: E402
from teardown.video2recipe import segment  # noqa: E402
from teardown.video2recipe import transcribe as tx  # noqa: E402


def _emit(obj, code=0):
    sys.stdout = _real_stdout
    print(json.dumps(obj, indent=2))
    raise SystemExit(code)


def main(argv=None):
    import argparse
    from pathlib import Path

    ap = argparse.ArgumentParser(description="§4 video → recipe skeleton")
    ap.add_argument("--url", required=True, help="YouTube URL or video id")
    ap.add_argument("--out", required=True, help="output root (recipe lands under <out>/<video_id>/)")
    ap.add_argument("--section", nargs=2, type=float, metavar=("START", "END"), default=None)
    ap.add_argument("--no-transcribe", action="store_true")
    ap.add_argument("--max-frames", type=int, default=30)
    ap.add_argument("--every", type=float, default=3.0)
    ns = ap.parse_args(argv)

    if not acquire.available():
        _emit({"ok": False, "error": "yt-dlp unavailable (pip install yt-dlp / setup-teardown.sh --with-sourcing)"}, 1)

    try:
        cache = Path(ns.out) / ".media-cache"
        dl = acquire.download(ns.url, cache, section=tuple(ns.section) if ns.section else None)
        frames = segment.keyframes(dl["video_path"], every_s=ns.every, max_frames=ns.max_frames)
        meta = ocrmod.scan_meta(frames)
        cuts = segment.scene_cuts(dl["video_path"])
        sections = segment.sections_from_cuts(cuts, dl["duration_s"])
        transcript = tx.transcribe(dl["video_path"]) if (not ns.no_transcribe and tx.available()) else None
        rec = assemble_skeleton(source=dl, meta_signals=meta, sections=sections)

        rdir = Path(ns.out) / dl["video_id"]
        (rdir / "assets").mkdir(parents=True, exist_ok=True)
        (rdir / "recipe.json").write_text(to_json(rec))
        if transcript:
            (rdir / "assets" / "transcript.json").write_text(json.dumps(transcript, indent=2))

        _emit({
            "ok": True, "recipe": str(rdir / "recipe.json"),
            "video_id": dl["video_id"], "title": dl["title"],
            "frames_scanned": len(frames), "scene_cuts": len(cuts), "sections": len(sections),
            "detected": {"daw": meta["daw"], "tempo": meta["tempo"], "key": meta["key"],
                         "plugins": meta["plugins"], "pianoroll": meta["pianoroll"]},
            "elements": len(rec.elements), "unresolved": len(rec.unresolved),
            "transcript_segments": len(transcript["segments"]) if transcript else 0,
        })
    except SystemExit:
        raise
    except Exception as e:
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
