#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.4.6"]
# ///
# ─── How to run ───
# uv run service/sft/derive_r8_4b_tail.py SOURCE OUTPUT COMPLETED_STEPS [SEED]

"""Derive a fresh-iterator MLX JSONL tail without replaying consumed rows."""

from __future__ import annotations

import hashlib
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Final

import numpy as np


UTF8: Final = "utf-8"


@dataclass(frozen=True, slots=True)
class TailResult:
    """Evidence returned after deriving and replay-verifying a tail."""

    source_rows: int
    remaining_rows: int
    remaining_source_indices_sha256: str
    train_sha256: str
    exact_tail_order_verified: bool


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _iterator_indices(records: list[dict[str, list[dict[str, str]]]], seed: int) -> list[int]:
    sort_keys = {len(record) for record in records}
    if len(sort_keys) != 1:
        raise ValueError(
            "mixed MLX raw-record sort keys cannot be inverse-permuted safely"
        )
    sorted_indices = sorted(range(len(records)), key=lambda index: len(records[index]))
    rng = np.random.RandomState(seed)
    permutation = rng.permutation(len(sorted_indices))
    return [sorted_indices[index] for index in permutation]


def derive_tail(
    source_path: Path,
    output_path: Path,
    completed_steps: int,
    seed: int = 0,
) -> TailResult:
    """Write the unconsumed iterator tail in a fresh seed-equivalent file order."""
    source_lines = source_path.read_text(encoding=UTF8).splitlines()
    records = [json.loads(line) for line in source_lines]
    if not 0 <= completed_steps < len(records):
        raise ValueError("completed_steps must leave at least one source row")

    source_order = _iterator_indices(records, seed)
    desired_tail = [source_lines[index] for index in source_order[completed_steps:]]

    fresh_rng = np.random.RandomState(seed)
    fresh_permutation = fresh_rng.permutation(len(desired_tail))
    file_order = [""] * len(desired_tail)
    for iterator_position, file_index in enumerate(fresh_permutation):
        file_order[file_index] = desired_tail[iterator_position]

    output_bytes = ("\n".join(file_order) + "\n").encode(UTF8)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(output_bytes)

    replay_records = [json.loads(line) for line in file_order]
    replay_order = _iterator_indices(replay_records, seed)
    replayed_tail = [file_order[index] for index in replay_order]
    exact = replayed_tail == desired_tail
    if not exact:
        raise RuntimeError("fresh MLX iterator replay did not reproduce the exact tail")

    remaining_indices = source_order[completed_steps:]
    index_bytes = ("\n".join(str(index) for index in remaining_indices) + "\n").encode(
        UTF8
    )
    return TailResult(
        source_rows=len(source_lines),
        remaining_rows=len(desired_tail),
        remaining_source_indices_sha256=_sha256(index_bytes),
        train_sha256=_sha256(output_bytes),
        exact_tail_order_verified=exact,
    )


def main() -> int:
    """Run the derivation CLI and print its evidence as JSON."""
    if len(sys.argv) not in {4, 5}:
        print(__doc__, file=sys.stderr)
        return 2
    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    completed_steps = int(sys.argv[3])
    seed = int(sys.argv[4]) if len(sys.argv) == 5 else 0
    result = derive_tail(source, output, completed_steps, seed)
    print(json.dumps(asdict(result), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
