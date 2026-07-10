#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SERVICE = REPO / "service"
SOULX_ROOT = Path(os.path.expanduser(os.environ.get("SOULX_MAC_DIR", "~/AI/soulx-mac")))
BRIDGE = SOULX_ROOT / "SoulX-Singer-MLX"


@dataclass(frozen=True, slots=True)
class WorkerError(Exception):
    message: str

    def __str__(self) -> str:
        return self.message


def _load(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _dump(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)


def align_words(audio: Path, tokens_path: Path, output: Path) -> None:
    sys.path.insert(0, str(SERVICE))
    from skeleton import align

    tokens = _load(tokens_path)
    words = [str(token["text"]) for token in tokens]
    aligned = align.align_words(str(audio), words)
    if aligned is None:
        raise WorkerError("MMS forced alignment returned no result")
    if len(aligned) != len(words):
        raise WorkerError(f"MMS forced alignment lost words: {len(aligned)}/{len(words)}")
    _dump(output, aligned)


def pronounce(tokens_path: Path, output: Path) -> None:
    sys.path.insert(0, str(SERVICE))
    from phonology import core

    pronouncer = core.Pronouncer()
    tokens = _load(tokens_path)
    pronunciations: dict[str, list[str]] = {}
    for token in tokens:
        normalized = str(token["normalized"])
        phones = pronouncer.phones(normalized)
        if not phones:
            raise WorkerError(f"phonology produced no phones for {normalized}")
        pronunciations[normalized] = [str(phone) for phone in phones]
    _dump(output, pronunciations)


def extract_f0(audio: Path, output: Path) -> None:
    sys.path.insert(0, str(BRIDGE))
    import numpy as np
    from preprocess.tools.f0_extraction import F0Extractor

    model = BRIDGE / "pretrained_models/SoulX-Singer-Preprocess/rmvpe/rmvpe.pt"
    with tempfile.TemporaryDirectory() as temporary:
        contour_path = Path(temporary) / "f0.npy"
        extractor = F0Extractor(model_path=str(model), is_half=False, device="mps", target_sr=24000, hop_size=480)
        contour = extractor.process(str(audio), f0_path=str(contour_path))
        values = np.asarray(contour, dtype=np.float32).reshape(-1).tolist()
    _dump(output, [{"t": round(index * 0.02, 4), "hz": round(float(hz), 4)} for index, hz in enumerate(values)])


def main() -> int:
    parser = argparse.ArgumentParser(description="Environment-specific workers for the Used2 asserted re-sing proof")
    subparsers = parser.add_subparsers(dest="command", required=True)
    align_parser = subparsers.add_parser("align", help="run MMS forced alignment")
    align_parser.add_argument("audio", type=Path)
    align_parser.add_argument("tokens", type=Path)
    align_parser.add_argument("output", type=Path)
    phones_parser = subparsers.add_parser("phones", help="resolve exact ARPAbet pronunciations")
    phones_parser.add_argument("tokens", type=Path)
    phones_parser.add_argument("output", type=Path)
    f0_parser = subparsers.add_parser("f0", help="extract raw RMVPE F0")
    f0_parser.add_argument("audio", type=Path)
    f0_parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        match args.command:
            case "align":
                align_words(args.audio, args.tokens, args.output)
            case "phones":
                pronounce(args.tokens, args.output)
            case "f0":
                extract_f0(args.audio, args.output)
            case unreachable:
                raise WorkerError(f"unknown command: {unreachable}")
    except WorkerError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
