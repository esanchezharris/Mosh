#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_page import build_page  # noqa: E402
from asserted_proof_runtime import Paths, build_lexical_pivot, build_local_repair, build_opening, expand_first_half, render_guide, render_svc  # noqa: E402
from asserted_proof_voicebox import build_voicebox_cloned_guide  # noqa: E402

DEFAULT_ROOT = Path("~/mosh-fms-ksb/used2").expanduser()


def _build_alt_padded_source(ace_dir: Path, full_take: str, tag: str) -> tuple[str, str]:
    """Slice the opening window from an alternate full take and pad it to match
    the lane's source spec (e.g. an FX/auto-tuned vocal). Returns (root-relative
    padded path, tag). ffmpeg -y makes it deterministic/idempotent."""
    import json as _json

    from asserted_proof_runtime import run as _run

    request = _json.loads((ace_dir / "request.json").read_text())
    window, pad = request["sourceWindow"], request["pad"]
    tag = tag or "alt"
    padded = ace_dir / f"source-{tag}-padded-10s.wav"
    _run([
        "ffmpeg", "-y", "-ss", str(window["absoluteStartS"]), "-to", str(window["absoluteEndS"]),
        "-i", str(Path(full_take).expanduser().resolve()),
        "-af", str(pad["filter"]), "-ar", str(pad["sampleRate"]), "-ac", str(pad["channels"]),
        "-c:a", str(pad["codec"]), str(padded),
    ])
    return f"asserted-proof/opening/ace-step-cover/{padded.name}", tag


def main() -> int:
    parser = argparse.ArgumentParser(description="Build and review provenance-safe Used2 asserted-word re-sing proofs")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="Used2 artifact root")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("build", help="rerun first-half alignment and build the opening render plan")
    render_parser = subparsers.add_parser("render", help="render one bounded opening attempt")
    render_parser.add_argument("--attempt", type=int, choices=(1, 2, 3), default=1)
    render_parser.add_argument("--svc", action="store_true", help="also voice-convert the generated lexical guide")
    subparsers.add_parser("localize-repair", help="splice only the corrected phrase into the immutable opening baseline")
    subparsers.add_parser("lexical-pivot", help="build a deterministic asserted-word guide and voice-convert it after lexical validation")
    voicebox_parser = subparsers.add_parser("voicebox-pivot", help="clone short asserted phrases, then transfer them onto the measured word slots")
    voicebox_parser.add_argument("--base-url", default="http://127.0.0.1:17494")
    voicebox_parser.add_argument("--profile-id", required=True)
    subparsers.add_parser("review", help="refresh the static review page")
    ace_parser = subparsers.add_parser("ace-cover-spike", help="generate + evaluate the eight pinned ACE-Step cover seeds for the opening")
    ace_parser.add_argument("--dry-run", action="store_true", help="print guards and the seed plan without generating")
    stop_parser = subparsers.add_parser("ace-cover-stop", help="declare the ACE cover lane blocked (validated against owner verdicts)")
    stop_parser.add_argument("--reason", choices=("lexical", "prosody"), required=True)
    stop_parser.add_argument("--rationale", required=True)
    subparsers.add_parser("ace-cover-ab", help="A/B the current round's rank-1 candidate against seed-4099 regenerated under the round-1 config")
    probe_parser = subparsers.add_parser("ace-cover-probe", help="ear probes: seed-4099 under candidate key/bpm/strength configs")
    probe_parser.add_argument("--key", action="append", required=True, help="candidate keyscale, repeatable (e.g. --key 'D major' --key 'B major')")
    probe_parser.add_argument("--bpm", type=int, default=None)
    probe_parser.add_argument("--bpm-note", default="")
    probe_parser.add_argument("--cover-noise", action="append", type=float, default=None, help="cover_noise_strength value, repeatable (0=pure noise, 1=closest to source)")
    probe_parser.add_argument("--torch-dit", action="store_true", help="run the torch DiT instead of MLX (required for cover-noise: the MLX sampler ignores it)")
    probe_parser.add_argument("--src-audio", default=None, help="full-take WAV to slice+pad as an alternate source (e.g. an FX/auto-tuned vocal)")
    probe_parser.add_argument("--src-tag", default="", help="short slug tag for the alternate source, e.g. 'fx'")
    subparsers.add_parser("ace-cover-hybrid", help="melody-correct the A/B arm-B render onto the take's measured per-syllable MIDI")
    flowedit_parser = subparsers.add_parser("ace-cover-flowedit", help="flow-edit probes: keep the take's audio, morph only the lyric direction over [n_min,n_max]")
    flowedit_parser.add_argument("--key", default="B major", help="keyscale (default: B major, the evidence front-runner)")
    flowedit_parser.add_argument("--bpm", type=int, default=138)
    flowedit_parser.add_argument("--window", action="append", required=True, help="edit sub-window 'n_min:n_max', repeatable (e.g. --window 0.0:0.7 --window 0.3:0.7)")
    flowedit_parser.add_argument("--n-avg", type=int, default=1)
    flowedit_parser.add_argument("--source-lyrics", default=None, help="V_src lyrics; defaults to the raw take's ASR transcript")
    flowedit_parser.add_argument("--src-audio", default=None, help="full-take WAV to slice+pad as an alternate source (e.g. an FX/auto-tuned vocal)")
    flowedit_parser.add_argument("--src-tag", default="", help="short slug tag for the alternate source, e.g. 'fx'")
    expand_parser = subparsers.add_parser("expand-first-half", help="render middle, Truman lead, and continuous first half after owner pass")
    expand_parser.add_argument("--verdict", type=Path, help="opening pass verdict JSON; defaults to the verdict saved by the review page")
    expand_parser.add_argument("--allow-close-diagnostic", action="store_true", help="diagnostically expand a current close-but-revise verdict without treating it as a pass")
    args = parser.parse_args()
    paths = Paths.from_root(args.root.expanduser().resolve())
    try:
        match args.command:
            case "build":
                plan = build_opening(paths)
                build_page(paths.output)
                print(f"built {plan['summary']['lexicalTokens']} opening words -> {paths.opening}")
            case "render":
                guide = render_guide(paths, args.attempt)
                if args.attempt == 3:
                    guide = build_local_repair(paths)
                if args.svc:
                    render_svc(paths, guide)
                build_page(paths.output)
                print(f"rendered -> {guide}")
            case "localize-repair":
                print(f"localized -> {build_local_repair(paths)}")
                build_page(paths.output)
            case "lexical-pivot":
                guide, svc = build_lexical_pivot(paths)
                build_page(paths.output)
                print(f"lexical pivot -> {guide}, {svc}")
            case "voicebox-pivot":
                guide = build_voicebox_cloned_guide(paths, base_url=args.base_url, profile_id=args.profile_id)
                build_page(paths.output)
                print(f"Voicebox lexical pivot -> {guide}")
            case "review":
                print(f"review -> {build_page(paths.output)}")
            case "ace-cover-spike":
                from asserted_proof_ace_cover import run_ace_cover_spike

                ace_dir = run_ace_cover_spike(paths, dry_run=args.dry_run)
                if not args.dry_run:
                    build_page(paths.output)
                print(f"ace cover spike -> {ace_dir}")
            case "ace-cover-stop":
                from asserted_proof_ace_cover import ace_dir_for, declare_stop

                status_path = declare_stop(ace_dir_for(paths), args.reason, args.rationale)
                build_page(paths.output)
                print(f"ace cover lane stopped -> {status_path}")
            case "ace-cover-ab":
                from asserted_proof_ace_ab import run_ace_cover_ab

                ab_dir = run_ace_cover_ab(paths)
                build_page(paths.output)
                print(f"ace cover A/B -> {ab_dir}")
            case "ace-cover-hybrid":
                import json as _json

                from asserted_proof_ace_cover import ace_dir_for
                from asserted_proof_melody_correct import melody_correct_wav
                from asserted_proof_provenance import write_receipt

                ace_dir = ace_dir_for(paths)
                source = ace_dir / "ab/round1-4099-opening.wav"
                source_f0 = ace_dir / "ab/round1-4099-f0.json"
                if not source.is_file() or not source_f0.is_file():
                    raise RuntimeError("run ace-cover-ab first — the hybrid corrects arm B")
                plan = _json.loads((paths.opening / "asserted-render-plan.json").read_text())
                hybrid_dir = ace_dir / "hybrid"
                output = hybrid_dir / "round1-4099-melody-corrected.wav"
                metadata = melody_correct_wav(source, plan, _json.loads(source_f0.read_text()), output)
                metadata_path = hybrid_dir / "round1-4099-melody-corrected.json"
                metadata["sourceRel"] = "opening/ace-step-cover/ab/round1-4099-opening.wav"
                (metadata_path).write_text(_json.dumps(metadata, indent=2), encoding="utf-8")
                write_receipt(hybrid_dir / "receipt.json", {"source": source, "sourceF0": source_f0, "output": output, "metadata": metadata_path})
                print(f"hybrid ({metadata['correctedSegments']} segments corrected, {metadata['skippedUnvoiced']} unvoiced, {metadata['skippedSmallShift']} small) -> http://127.0.0.1:8189/used2/asserted-proof/opening/ace-step-cover/hybrid/round1-4099-melody-corrected.wav")
            case "ace-cover-flowedit":
                import json as _json

                from asserted_proof_ace_cover import ace_dir_for
                from asserted_proof_ace_flowedit import run_flow_edit_probes

                ace_dir = ace_dir_for(paths)
                if not (ace_dir / "request.json").is_file():
                    raise RuntimeError("run ace-cover-spike first")
                target_lyrics = _json.loads((ace_dir / "request.json").read_text())["params"]["lyrics"]
                source_lyrics = args.source_lyrics
                if source_lyrics is None:
                    raw_asr_path = ace_dir / "ab/round1-4099-raw-asr.json"
                    if not raw_asr_path.is_file():
                        raise RuntimeError("no raw-take ASR at ab/round1-4099-raw-asr.json — run ace-cover-ab first, or pass --source-lyrics")
                    raw_asr = _json.loads(raw_asr_path.read_text())
                    source_lyrics = " ".join(str(word.get("word", "")).strip() for word in raw_asr.get("words", [])).strip()
                windows = []
                for spec in args.window:
                    lo, hi = spec.split(":")
                    windows.append((float(lo), float(hi)))
                src_audio_rel, src_tag = None, args.src_tag
                if args.src_audio:
                    src_audio_rel, src_tag = _build_alt_padded_source(ace_dir, args.src_audio, args.src_tag)
                probes_dir = run_flow_edit_probes(paths, source_lyrics=source_lyrics, target_lyrics=target_lyrics, keyscale=args.key, bpm=args.bpm, windows=windows, n_avg=args.n_avg, src_audio_rel=src_audio_rel, src_tag=src_tag)
                listing = "flowedit-probes.json" if not src_tag else f"flowedit-probes-{src_tag}.json"
                for entry in _json.loads((probes_dir / listing).read_text())["probes"]:
                    line = f"flow-edit {entry['slug']} -> http://127.0.0.1:8189/used2/asserted-proof/{entry['audio']}"
                    evaluation = entry.get("eval")
                    if evaluation and evaluation.get("lexical"):
                        lex, con = evaluation["lexical"], evaluation["contour"]
                        line += f"\n    words {lex['hits']}/16 hits {lex['misses']} miss | contour corr {con['contourCorrelation']} | pitch {con['medianAbsPitchErrorSemitones']}st | register {con['registerOffsetSemitones']}st"
                    print(line)
            case "ace-cover-probe":
                import json as _json

                from asserted_proof_ace_cover import ace_dir_for
                from asserted_proof_ace_probe import run_key_probes

                src_audio_rel, src_tag = None, args.src_tag
                if args.src_audio:
                    src_audio_rel, src_tag = _build_alt_padded_source(ace_dir_for(paths), args.src_audio, args.src_tag)
                probes_dir = run_key_probes(paths, keys=args.key, bpm=args.bpm, bpm_note=args.bpm_note, cover_noise=args.cover_noise, use_mlx_dit=not args.torch_dit, src_audio_rel=src_audio_rel, src_tag=src_tag)
                listing = "probes.json" if not src_tag else f"probes-{src_tag}.json"
                for entry in _json.loads((probes_dir / listing).read_text())["probes"]:
                    line = f"probe {entry['slug']} -> http://127.0.0.1:8189/used2/asserted-proof/{entry['audio']}"
                    evaluation = entry.get("eval")
                    if evaluation and evaluation.get("lexical"):
                        lex, con = evaluation["lexical"], evaluation["contour"]
                        line += f"\n    words {lex['hits']}/16 hits {lex['misses']} miss | contour corr {con['contourCorrelation']} | pitch {con['medianAbsPitchErrorSemitones']}st | register {con['registerOffsetSemitones']}st"
                    print(line)
            case "expand-first-half":
                verdict_path = args.verdict.expanduser().resolve() if args.verdict else paths.opening / "owner-verdict.json"
                outputs = expand_first_half(paths, verdict_path, allow_close_diagnostic=args.allow_close_diagnostic)
                build_page(paths.output)
                print("expanded -> " + ", ".join(str(path) for path in outputs))
            case unreachable:
                raise RuntimeError(f"unknown command: {unreachable}")
    except (OSError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
