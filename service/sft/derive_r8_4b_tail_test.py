import hashlib
import json
from pathlib import Path

import numpy as np

from derive_r8_4b_tail import derive_tail


def _write_rows(path: Path, count: int) -> list[str]:
    lines = [
        json.dumps({"messages": [{"role": "user", "content": f"row-{i}"}]})
        for i in range(count)
    ]
    path.write_text("\n".join(lines) + "\n")
    return lines


def _mlx_order(lines: list[str], seed: int = 0) -> list[str]:
    records = [json.loads(line) for line in lines]
    sorted_indices = sorted(range(len(records)), key=lambda index: len(records[index]))
    rng = np.random.RandomState(seed)
    permutation = rng.permutation(len(sorted_indices))
    return [lines[sorted_indices[index]] for index in permutation]


def test_derives_exact_unconsumed_mlx_order(tmp_path: Path) -> None:
    source = tmp_path / "source.jsonl"
    output = tmp_path / "tail.jsonl"
    source_lines = _write_rows(source, 23)

    result = derive_tail(source, output, completed_steps=17, seed=0)

    expected_tail = _mlx_order(source_lines)[17:]
    output_lines = output.read_text().splitlines()
    assert _mlx_order(output_lines) == expected_tail
    assert result.source_rows == 23
    assert result.remaining_rows == 6
    assert result.exact_tail_order_verified
    assert result.train_sha256 == hashlib.sha256(output.read_bytes()).hexdigest()


def test_rejects_rows_with_different_mlx_sort_keys(tmp_path: Path) -> None:
    source = tmp_path / "source.jsonl"
    output = tmp_path / "tail.jsonl"
    source.write_text(
        json.dumps({"messages": []})
        + "\n"
        + json.dumps({"messages": [], "tools": []})
        + "\n"
    )

    try:
        derive_tail(source, output, completed_steps=1, seed=0)
    except ValueError as error:
        assert "sort key" in str(error)
    else:
        raise AssertionError("mixed MLX sort keys must fail closed")
