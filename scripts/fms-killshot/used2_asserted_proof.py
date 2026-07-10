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
    probe_parser = subparsers.add_parser("ace-cover-probe", help="ear probes: seed-4099 under candidate key/bpm configs; the owner names the key")
    probe_parser.add_argument("--key", action="append", required=True, help="candidate keyscale, repeatable (e.g. --key 'D major' --key 'B major')")
    probe_parser.add_argument("--bpm", type=int, default=None)
    probe_parser.add_argument("--bpm-note", default="")
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
            case "ace-cover-probe":
                from asserted_proof_ace_probe import run_key_probes

                probes_dir = run_key_probes(paths, keys=args.key, bpm=args.bpm, bpm_note=args.bpm_note)
                import json as _json

                for entry in _json.loads((probes_dir / "probes.json").read_text())["probes"]:
                    print(f"probe {entry['keyscale']} @ {entry['bpm']} -> http://127.0.0.1:8189/used2/asserted-proof/{entry['audio']}")
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
