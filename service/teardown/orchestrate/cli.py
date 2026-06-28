#!/usr/bin/env python3
"""CLI: run the §10 conductor on one video, wiring the REAL stages (§4 skeleton → §7 extract
→ §1 match → §9 compile) → a checkpointed Recipe + compiled command list.

  python3 cli.py --url <url|id> --out <dir> [--index <§1 index>] [--section S E] [--no-extract]

Emits a JSON summary. Needs yt-dlp + cv2 + tesseract (§4); demucs for --extract (§7); a built
§1 index for matching. Each stage degrades gracefully; missing ones just leave `unresolved`.
"""
import json
import os
import sys

_real_stdout = sys.stdout
sys.stdout = sys.stderr

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.orchestrate import Orchestrator, Policy  # noqa: E402
from teardown.recipe import to_json  # noqa: E402
from teardown.render.compile import compile_recipe  # noqa: E402

DRUM_ROLES = {"kick", "snare", "hat", "clap", "perc", "808"}


def _emit(obj, code=0):
    sys.stdout = _real_stdout
    print(json.dumps(obj, indent=2))
    raise SystemExit(code)


def main(argv=None):
    import argparse
    from pathlib import Path

    ap = argparse.ArgumentParser(description="§10 conductor — one video → Recipe")
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--index", default="", help="§1 sample index dir (for drum matching)")
    ap.add_argument("--section", nargs=2, type=float, metavar=("START", "END"), default=None)
    ap.add_argument("--no-extract", action="store_true")
    ap.add_argument("--render", action="store_true",
                    help="§9 EXECUTE the compiled recipe → render a WAV (needs the built binary)")
    ap.add_argument("--max-frames", type=int, default=24)
    ns = ap.parse_args(argv)

    from teardown.video2recipe import acquire, assemble_skeleton
    from teardown.video2recipe import ocr as ocrmod
    from teardown.video2recipe import segment

    if not acquire.available():
        _emit({"ok": False, "error": "yt-dlp unavailable (setup-teardown.sh --with-sourcing)"}, 1)

    out = Path(ns.out)
    ctx: dict = {}

    def skeleton(video_ref):
        dl = acquire.download(video_ref, out / ".media-cache", section=tuple(ns.section) if ns.section else None)
        ctx["dl"] = dl
        frames = segment.keyframes(dl["video_path"], every_s=3.0, max_frames=ns.max_frames)
        meta = ocrmod.scan_meta(frames)
        sections = segment.sections_from_cuts(segment.scene_cuts(dl["video_path"]), dl["duration_s"])
        rec = assemble_skeleton(source=dl, meta_signals=meta, sections=sections)
        # §4→§5b: read the synth GUI off the keyframes so a named synth element gets real params
        # (not just status 'unknown') and actually loads + plays at §9 render. Best-effort.
        try:
            from teardown.render.from_screen import enrich_synths_from_frames
            n = enrich_synths_from_frames(rec, frames)
            if n:
                print(f"[skeleton] §5b read {n} synth GUI(s) from keyframes", file=sys.stderr)
        except Exception as e:
            print(f"[skeleton] synth-GUI enrich skipped: {type(e).__name__}: {e}", file=sys.stderr)
        return rec

    def extract(rec, video_ref):
        import librosa
        from teardown.extract import DemucsSeparator, slice_oneshots
        from teardown.recipe import Element
        sep = DemucsSeparator()
        if not sep.available:
            return
        y, sr = librosa.load(ctx["dl"]["video_path"], sr=44100, mono=True)
        stems = sep.split(y, sr)
        stem_dir = out / ctx["dl"]["video_id"] / "assets" / "stems"
        slices = slice_oneshots(stems["drums"], 44100, out_dir=stem_dir)
        for i, sl in enumerate(slices[:16]):
            role = sl.role_guess if sl.role_guess in DRUM_ROLES else "perc"
            rec.elements.append(Element(element_id=f"drum_{i}", role=role, audio_ref=sl.path))

    matcher = None
    if ns.index:
        from teardown.drummatch import DrumMatcher
        matcher = DrumMatcher().load(ns.index)

    def match(rec, element_id):
        if matcher is not None:
            matcher.match_into(rec, element_id)

    render_fn = None
    if ns.render:
        from teardown.render.execute import execute_recipe

        def render_fn(rec):                      # §9 execute → real Edit + render; writes yield.actual
            r = execute_recipe(rec, out_wav=str(out / f"{rec.source.video_id or 'recon'}.wav"),
                               session_dir=str(out / ".render-sess"), timeout_s=600)
            return {"nonsilent": r.nonsilent, "rms": round(r.audio_rms, 4), "yield": r.yield_actual,
                    "out_wav": r.out_wav, "synths_loaded": r.synths_loaded,
                    "synth_params_set": r.synth_params_set, "ran": r.ran, "error": r.error}

    orc = Orchestrator(policy=Policy(), checkpoint_dir=out / ".checkpoints",
                       skeleton_fn=skeleton, extract_fn=(None if ns.no_extract else extract),
                       match_fn=match, compile_fn=compile_recipe, render_fn=render_fn)
    try:
        res = orc.teardown(ns.url)
        if res.status == "failed":
            _emit({"ok": False, "error": res.error}, 1)
        rdir = out / res.recipe.source.video_id
        rdir.mkdir(parents=True, exist_ok=True)
        (rdir / "recipe.json").write_text(to_json(res.recipe))
        (rdir / "commands.json").write_text(json.dumps({"commands": res.commands, "unresolved": res.unresolved}, indent=2))
        _emit({
            "ok": True, "status": res.status, "completeness": res.completeness,
            "stages": res.stages_done, "recipe": str(rdir / "recipe.json"),
            "elements": len(res.recipe.elements), "commands": len(res.commands),
            "unresolved": len(res.unresolved),
            "render": res.render or None, "reward": res.reward or None,
        })
    except SystemExit:
        raise
    except Exception as e:
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
