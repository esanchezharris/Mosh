from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .corpus_bundle import build_corpus_bundle
from .rights import load_registry, save_registry, write_json


def cmd_validate(args: argparse.Namespace) -> int:
    registry = load_registry(args.registry)
    write_json(args.output, registry)
    print(json.dumps({"ok": True, "sources": len(registry.get("sources", []))}))
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    result = build_corpus_bundle(args.registry, args.output_root, args.bundle_name)
    print(json.dumps({"ok": True, **result}, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Build a rights-cleared training corpus bundle.")
    sub = p.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("validate", help="Normalize and validate a rights registry.")
    v.add_argument("--registry", required=True)
    v.add_argument("--output", required=True)
    v.set_defaults(func=cmd_validate)

    b = sub.add_parser("build", help="Build a deterministic corpus bundle.")
    b.add_argument("--registry", required=True)
    b.add_argument("--output-root", required=True)
    b.add_argument("--bundle-name", default="")
    b.set_defaults(func=cmd_build)
    return p


def main(argv: list[str] | None = None) -> int:
    ns = build_parser().parse_args(argv)
    return int(ns.func(ns))


if __name__ == "__main__":
    raise SystemExit(main())

