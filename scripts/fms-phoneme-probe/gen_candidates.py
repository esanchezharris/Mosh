#!/usr/bin/env python3
"""Stage C: LLM candidate lines per mumble-take template line (cached, blind).

BLINDNESS RULE (bench discipline): the prompt carries ONLY the syllable target, the
stress contour, and the caller's theme — never the template's phonemes and never any
Whisper text from the take. The phonetic template is used exclusively by rescore.py
AFTER generation. gen_candidates_test.py pins this with a spy chat.

Candidates are cached via lyrics.bench.llm_cache (payload-keyed), so re-runs are free
and MOSH_INFILL_CACHE_ONLY=1 replays bit-for-bit.

Usage:
  MOSH_BRAIN_ENV=~/Library/Mosh/brain.env gen_candidates.py <template-dir> \
      --topic "..." [--mood "..."] [--n 100] [--min-syl 4] [--max-syl 24]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "service"))

CACHE_ROOT = os.path.expanduser("~/Library/Mosh/lyrics-bench/probe-cache")
CALLS = 5           # seeded prompt variants per line
PER_CALL = 20       # lines requested per call

_WORD_RE = re.compile(r"[A-Za-z']+")


def build_prompt(syllables: int, stress: str, topic: str, mood: str, seed_tag: int) -> list:
    """The generation prompt. MUST NOT contain template phonemes or take words."""
    hint = f" The stress pattern is {stress} (X=stressed syllable, x=unstressed)." if stress else ""
    style = f" Mood: {mood}." if mood else ""
    return [
        {"role": "system",
         "content": "You write single song-lyric lines under strict syllable "
                    "constraints. Reply with JSON: {\"lines\": [\"...\", ...]}. "
                    "No commentary."},
        {"role": "user",
         "content": f"Write {PER_CALL} different song lyric lines about: {topic}.{style} "
                    f"Each line must have exactly {syllables} syllables.{hint} "
                    f"Vary vocabulary and imagery widely across lines "
                    f"(variation set {seed_tag + 1} of {CALLS})."},
    ]


def parse_lines(content: str) -> list:
    try:
        data = json.loads(content)
    except Exception:  # noqa: BLE001 — a provider ignoring json_object mode
        return []
    lines = data.get("lines") if isinstance(data, dict) else data
    if not isinstance(lines, list):
        return []
    return [str(l).strip() for l in lines if str(l).strip()]


def generate_for_line(line: dict, topic: str, mood: str, chat, cache) -> list:
    from lyrics.bench.llm_cache import cache_key
    out, seen = [], set()
    for seed_tag in range(CALLS):
        messages = build_prompt(line["syllables"], line.get("stress", ""),
                                topic, mood, seed_tag)
        payload = {"messages": messages, "seed_tag": seed_tag, "kind": "probe-gen-v1"}
        if cache is not None:
            resp = cache.cached_call(payload, lambda: chat(messages))
        else:
            resp = chat(messages)
        if not resp.get("ok"):
            print(f"  line {line['index']} call {seed_tag}: {resp.get('error')}",
                  file=sys.stderr)
            continue
        for text in parse_lines(resp.get("content", "")):
            key = " ".join(w.lower() for w in _WORD_RE.findall(text))
            if key and key not in seen:
                seen.add(key)
                out.append(text)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("template_dir")
    ap.add_argument("--topic", required=True)
    ap.add_argument("--mood", default="")
    ap.add_argument("--min-syl", type=int, default=4)
    ap.add_argument("--max-syl", type=int, default=24)
    ns = ap.parse_args()

    import brain_client
    from lyrics.bench.llm_cache import Cache

    if not brain_client.available():
        print("no brain provider configured (set MOSH_BRAIN_ENV)", file=sys.stderr)
        return 1
    cache = Cache(CACHE_ROOT)

    with open(os.path.join(ns.template_dir, "template.json"), encoding="utf-8") as f:
        template = json.load(f)

    def chat(messages):
        return brain_client.chat_json(messages, max_tokens=1400, timeout=120)

    result = {"take": template["take"], "topic": ns.topic, "mood": ns.mood,
              "prompt_kind": "probe-gen-v1", "lines": []}
    for line in template["lines"]:
        if not (ns.min_syl <= line["syllables"] <= ns.max_syl):
            continue
        cands = generate_for_line(line, ns.topic, ns.mood, chat, cache)
        print(f"line {line['index']} (syl={line['syllables']}): {len(cands)} candidates "
              f"(cache {cache.stats})")
        result["lines"].append({"index": line["index"], "syllables": line["syllables"],
                                "stress": line.get("stress", ""), "span": line["span"],
                                "candidates": cands})

    out_path = os.path.join(ns.template_dir, "candidates.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"wrote {out_path}: {sum(len(l['candidates']) for l in result['lines'])} "
          f"candidates over {len(result['lines'])} lines")
    return 0


if __name__ == "__main__":
    sys.exit(main())
