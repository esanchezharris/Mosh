from __future__ import annotations


def chunk_score(score: list[dict], max_chunk_s: float = 12.0, min_chunk_s: float = 4.0) -> list[dict]:
    chunks: list[dict] = []
    for clip in score:
        durations = [float(value) for value in str(clip["duration"]).split()]
        texts = str(clip["text"]).split()
        phonemes = str(clip["phoneme"]).split()
        pitches = str(clip["note_pitch"]).split()
        types = [int(value) for value in str(clip["note_type"]).split()]
        if not len(durations) == len(texts) == len(phonemes) == len(pitches) == len(types):
            raise RuntimeError("SoulX score columns have different lengths")
        cursor_ms, start = int(clip["time"][0]), 0
        while start < len(durations):
            elapsed, end, best = 0.0, start, None
            while end < len(durations):
                elapsed += durations[end]
                safe_break = types[end] != 3 and (end + 1 == len(types) or types[end + 1] != 3)
                if elapsed >= min_chunk_s and safe_break:
                    best = end + 1
                if elapsed >= max_chunk_s and best is not None:
                    break
                end += 1
            stop = best if best is not None else min(len(durations), max(start + 1, end + 1))
            segment = durations[start:stop]
            duration_ms = round(sum(segment) * 1000)
            chunks.append(
                {
                    "index": f"{clip['index']}_chunk_{len(chunks)}",
                    "language": clip.get("language", "English"),
                    "time": [cursor_ms, cursor_ms + duration_ms],
                    "duration": " ".join(f"{value:.4f}" for value in segment),
                    "text": " ".join(texts[start:stop]),
                    "phoneme": " ".join(phonemes[start:stop]),
                    "note_pitch": " ".join(pitches[start:stop]),
                    "note_type": " ".join(str(value) for value in types[start:stop]),
                }
            )
            cursor_ms += duration_ms
            start = stop
    return chunks
