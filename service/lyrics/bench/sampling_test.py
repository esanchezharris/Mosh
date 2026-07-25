#!/usr/bin/env python3
"""Golden tests for balanced subsampling + run identity (FMS lyrics-bench I2).

Why this module exists: `--limit N` over an itemId-sorted list silently returns
one granularity (itemIds start with the granularity, so "line" wins the
alphabet). That bug was fixed once inline in `run`, then recurred verbatim in
`judge` — so the logic now lives in ONE tested place.

Run:  python3 service/lyrics/bench/sampling_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import sampling  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


ROWS = ([{"itemId": f"v1:line:{i:03}", "granularity": "line"} for i in range(50)]
        + [{"itemId": f"v1:span:{i:03}", "granularity": "span"} for i in range(50)]
        + [{"itemId": f"v1:word:{i:03}", "granularity": "word"} for i in range(3)])

got = sampling.balanced(ROWS, limit=12, key=lambda r: r["granularity"])
counts = {}
for r in got:
    counts[r["granularity"]] = counts.get(r["granularity"], 0) + 1
check("balanced: limit honored", len(got) == 12, str(len(got)))
check("balanced: every group represented", set(counts) == {"line", "span", "word"},
      str(counts))
# The real invariant: a group may fall behind ONLY because it ran out of rows.
avail = {"line": 50, "span": 50, "word": 3}
top = max(counts.values())
check("balanced: a group is behind only when exhausted",
      all(c >= top - 1 or c == avail[g] for g, c in counts.items()), str(counts))
check("balanced: a thin group is not padded past its size",
      counts["word"] <= 3, str(counts))

thin = sampling.balanced(ROWS, limit=99, key=lambda r: r["granularity"])
check("balanced: exhausts groups without duplicating rows",
      len(thin) == len({r["itemId"] for r in thin}), str(len(thin)))
check("balanced: limit above the pool returns the whole pool",
      len(sampling.balanced(ROWS, limit=1000, key=lambda r: r["granularity"]))
      == len(ROWS))
check("balanced: limit 0 means no cap",
      len(sampling.balanced(ROWS, limit=0, key=lambda r: r["granularity"]))
      == len(ROWS))
check("balanced: deterministic",
      sampling.balanced(ROWS, limit=12, key=lambda r: r["granularity"]) == got)

# ---- song diversity: the bug that invalidated calibration sitting 1 ----------
# itemIds embed the songId, so sorting by itemId and taking a prefix drew every
# pair from ONE song (and, because Genius ids run roughly chronological, the
# OLDEST one). Sampling must deal across songs, not slice one.
MANY = [{"itemId": f"v1:line:gd:{song:04}:s0:l{i}", "granularity": "line",
         "songId": f"gd:{song:04}"}
        for song in range(30) for i in range(20)]
spread = sampling.balanced(MANY, limit=20, key=lambda r: r["granularity"],
                           spread=lambda r: r["songId"])
songs = {r["songId"] for r in spread}
check("balanced: 20 picks come from 20 distinct songs, not one",
      len(songs) == 20, f"{len(songs)} distinct songs")
check("balanced: no song contributes twice before every song contributed once",
      max(sum(1 for r in spread if r["songId"] == s) for s in songs) == 1)
wide = sampling.balanced(MANY, limit=60, key=lambda r: r["granularity"],
                         spread=lambda r: r["songId"])
per = [sum(1 for r in wide if r["songId"] == s) for s in {r["songId"] for r in wide}]
check("balanced: past one round it stays even across songs",
      max(per) - min(per) <= 1, str(sorted(per)[-4:]))
check("balanced: song spreading is deterministic",
      sampling.balanced(MANY, limit=20, key=lambda r: r["granularity"],
                        spread=lambda r: r["songId"]) == spread)
check("balanced: spread also avoids the oldest-id prefix (ids are chronological)",
      len({r["songId"] for r in spread} & {f"gd:{s:04}" for s in range(20, 30)}) >= 4,
      "recent-id songs represented: "
      f"{sorted({r['songId'] for r in spread} & {f'gd:{s:04}' for s in range(20, 30)})}")
check("balanced: output stays itemId-sorted for stable run manifests",
      [r["itemId"] for r in got] == sorted(r["itemId"] for r in got))

# ---- run identity comes from the summary, never from parsing the dir name ----
with tempfile.TemporaryDirectory() as td:
    run = os.path.join(td, "2026-07-25T03-31-54-llm-constrained-dev")
    os.makedirs(run)
    with open(os.path.join(run, "summary-llm-constrained.json"), "w") as f:
        json.dump({"arm": {"name": "llm-constrained", "version": "v1"}}, f)
    check("arm name read from the run summary",
          sampling.arm_of(run) == "llm-constrained", sampling.arm_of(run))

with tempfile.TemporaryDirectory() as td:
    run = os.path.join(td, "2026-07-25T03-31-54-product-llm-dev")
    os.makedirs(run)
    check("no summary → falls back to a NAMED unknown, not a mangled slice",
          sampling.arm_of(run).startswith("unknown"), sampling.arm_of(run))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
