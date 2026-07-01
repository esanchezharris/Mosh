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
        try:
            from teardown.synth_from_screen.llm_identify import identify_synths
            llm = identify_synths(frames)
            if llm:
                meta = dict(meta)
                meta["plugins"] = [s["name"] for s in llm]
                meta["llm_synths"] = llm              # profile_key/known/components — recorded for a
                #                                       future §8 substitute (unknown synths); not yet consumed
                print(f"[skeleton] §5b LLM identified synth(s): "
                      f"{[(s['name'], s['profile_key'], s['votes']) for s in llm]}", file=sys.stderr)
            elif llm == []:
                print("[skeleton] §5b LLM returned no synths; keeping OCR/visual detections",
                      file=sys.stderr)
        except Exception as e:
            print(f"[skeleton] LLM synth-id skipped: {type(e).__name__}: {e}", file=sys.stderr)
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
        # §4→§5: read the piano-roll off the keyframes and attach its MIDI to the lead synth so it
        # plays a part (conservative — no-ops rather than emit garbage). Best-effort.
        try:
            from teardown.render.from_screen import midi_from_frames
            m = midi_from_frames(rec, frames, out_dir=str(out / "assets" / "midi"))
            if m.get("attached"):
                print(f"[skeleton] §5 attached {m['notes']} screen-read notes to {m['element_id']}",
                      file=sys.stderr)
        except Exception as e:
            print(f"[skeleton] piano-roll MIDI skipped: {type(e).__name__}: {e}", file=sys.stderr)
        # §3: a metadata-only yield.predicted from the signals we have, so §9's yield.actual can be
        # validated against it (over-prediction flagged, not hidden). Best-effort.
        try:
            from teardown.recipe import YieldScores
            from teardown.sourcing.score import predicted_from_skeleton
            rec.yield_.predicted = YieldScores(**predicted_from_skeleton(dl, meta))
        except Exception as e:
            print(f"[skeleton] yield.predicted skipped: {type(e).__name__}: {e}", file=sys.stderr)
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
            rdir = out / (rec.source.video_id or "recon")
            rdir.mkdir(parents=True, exist_ok=True)
            content_commands = [c for c in r.commands if c.get("command") != "export_audio"]
            content_path = rdir / "content_commands.json"
            content_path.write_text(json.dumps({
                "phase": "execute_content",
                "commands": content_commands,
                "unresolved": r.unresolved,
                "notes_resolved": r.notes_resolved,
                "synths_loaded": r.synths_loaded,
                "synth_params_set": r.synth_params_set,
                "omitted_terminal_commands": ["export_audio"] if len(content_commands) != len(r.commands) else [],
            }, indent=2))
            executed_path = rdir / "execute_commands.json"
            executed_path.write_text(json.dumps({
                "phase": "execute",
                "commands": r.commands,
                "unresolved": r.unresolved,
                "notes_resolved": r.notes_resolved,
                "synths_loaded": r.synths_loaded,
                "synth_params_set": r.synth_params_set,
            }, indent=2))
            return {"nonsilent": r.nonsilent, "rms": round(r.audio_rms, 4), "yield": r.yield_actual,
                    "out_wav": r.out_wav, "synths_loaded": r.synths_loaded,
                    "synth_params_set": r.synth_params_set, "notes_resolved": r.notes_resolved,
                    "command_count": len(content_commands), "execute_command_count": len(r.commands),
                    "unresolved_count": len(r.unresolved), "commands_path": str(content_path),
                    "execute_commands_path": str(executed_path), "ran": r.ran, "error": r.error}

    reward_fn = None

    orc = Orchestrator(policy=Policy(), checkpoint_dir=out / ".checkpoints",
                       skeleton_fn=skeleton, extract_fn=(None if ns.no_extract else extract),
                       match_fn=match, compile_fn=compile_recipe, render_fn=render_fn, reward_fn=reward_fn)
    try:
        res = orc.teardown(ns.url)
        if res.status == "failed":
            _emit({"ok": False, "error": res.error}, 1)

        # §3 validation: did the metadata prediction match what we actually recovered? Surface the
        # delta honestly — an overconfident prediction (rosy source, weak reconstruction) becomes an
        # Unresolved note on the recipe, never a silent pass.
        yval = {}
        try:
            from teardown.recipe import Unresolved
            from teardown.sourcing.score import validate_yield
            yval = validate_yield(res.recipe.yield_.predicted, res.recipe.yield_.actual,
                                  rendered=bool((res.render or {}).get("ran")))
            if yval.get("overconfident"):
                p, a = yval["predicted"]["overall"], yval["actual"]["overall"]
                res.recipe.unresolved.append(Unresolved(
                    issue=f"yield overconfident — predicted overall {p} but reconstruction delivered "
                          f"{a} (Δ{yval['overall_delta']}); weakest axis '{yval['worst_field']}'",
                    suggested_action="manual review: the source looked richer than the teardown recovered"))
        except Exception as e:
            print(f"[validate] yield check skipped: {type(e).__name__}: {e}", file=sys.stderr)

        rdir = out / res.recipe.source.video_id
        rdir.mkdir(parents=True, exist_ok=True)
        (rdir / "recipe.json").write_text(to_json(res.recipe))
        compiled_commands = {"phase": "compile", "commands": res.commands, "unresolved": res.unresolved}
        commands_payload = compiled_commands
        if ns.render and isinstance(res.render, dict):
            executed_path = res.render.get("commands_path")
            if executed_path:
                try:
                    commands_payload = json.loads(Path(executed_path).read_text())
                    (rdir / "compiled_commands.json").write_text(json.dumps(compiled_commands, indent=2))
                except Exception as e:
                    print(f"[render] executed command artifact unavailable: {type(e).__name__}: {e}",
                          file=sys.stderr)
                    commands_payload = compiled_commands
        (rdir / "commands.json").write_text(json.dumps(commands_payload, indent=2))
        command_count = (res.render or {}).get("command_count", len(res.commands)) if ns.render else len(res.commands)
        unresolved_count = ((res.render or {}).get("unresolved_count", len(res.unresolved))
                            if ns.render else len(res.unresolved))
        _emit({
            "ok": True, "status": res.status, "completeness": res.completeness,
            "stages": res.stages_done, "recipe": str(rdir / "recipe.json"),
            "elements": len(res.recipe.elements), "commands": command_count,
            "unresolved": unresolved_count,
            "render": res.render or None, "reward": res.reward or None,
            "yield_validation": yval or None,
        })
    except SystemExit:
        raise
    except Exception as e:
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
