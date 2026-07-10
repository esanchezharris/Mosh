from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path


def _dump(path: Path, value) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)


def _run(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout)[-3000:])


def _local_alignment(audio: Path, start: float, end: float, tokens: list[dict], worker: Path, skeleton_python: Path) -> list[dict]:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        excerpt, token_path, output = root / "excerpt.wav", root / "tokens.json", root / "alignment.json"
        _run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", str(start), "-i", str(audio), "-t", str(end - start), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(excerpt)])
        _dump(token_path, tokens)
        _run([str(skeleton_python), str(worker), "align", str(excerpt), str(token_path), str(output)])
        return json.loads(output.read_text(encoding="utf-8"))


def expand_alignment(*, raw_audio: Path, corrected: dict, split_word_idx: int, baseline: list[dict], tokens: list[dict], worker: Path, skeleton_python: Path) -> list[dict]:
    entries = [row for row in corrected.get("words", []) if not row.get("deleted") and int(row.get("sourceIndex", -1)) <= split_word_idx and str(row.get("word", "")).strip()]
    if len(entries) != len(baseline):
        raise RuntimeError(f"corrected/baseline alignment mismatch: {len(entries)} != {len(baseline)}")
    by_source: dict[int, list[dict]] = {}
    for token in tokens:
        by_source.setdefault(int(token["sourceIndex"]), []).append(token)
    expanded: list[dict] = []
    for entry, span in zip(entries, baseline):
        source_index = int(entry["sourceIndex"])
        owned = by_source.get(source_index, [])
        if len(owned) == 1:
            expanded.append({"word": owned[0]["text"], "start": float(span["start"]), "end": float(span["end"]), "score": float(span.get("score", 0.0)), "alignmentOrigin": "corrected_baseline"})
            continue
        if not owned:
            raise RuntimeError(f"no lexical token owned by source index {source_index}")
        outer_start, outer_end = float(span["start"]), float(span["end"])
        local = _local_alignment(raw_audio, outer_start, outer_end, owned, worker, skeleton_python)
        if len(local) != len(owned):
            raise RuntimeError(f"local MMS alignment lost tokens for source index {source_index}")
        local_start, local_end = float(local[0]["start"]), float(local[-1]["end"])
        local_span = max(0.001, local_end - local_start)
        for index, (token, aligned) in enumerate(zip(owned, local)):
            start_ratio = (float(aligned["start"]) - local_start) / local_span
            end_ratio = (float(aligned["end"]) - local_start) / local_span
            start = outer_start if index == 0 else outer_start + start_ratio * (outer_end - outer_start)
            end = outer_end if index == len(owned) - 1 else outer_start + end_ratio * (outer_end - outer_start)
            expanded.append({"word": token["text"], "start": start, "end": end, "score": float(aligned.get("score", 0.0)), "alignmentOrigin": "local_mms_within_corrected_span"})
    if len(expanded) != len(tokens):
        raise RuntimeError(f"expanded alignment lost tokens: {len(expanded)}/{len(tokens)}")
    return expanded
