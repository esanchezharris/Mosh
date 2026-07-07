#!/usr/bin/env python3
"""Golden tests for the best-of-n scorer core (WP-11, spec
docs/superpowers/specs/2026-07-04-bestofn-serving-skeleton.md).

PURE functions only — no network, no brain, no filesystem beyond a tmpdir for the
path checks. The scorer is the "verifiable checks" half of the program's shared
scorer seam; the ranker seam is exercised with a stub callable. 3× deterministic.

Run:  python3 service/bestofn/bestofn_core_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from bestofn import core  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


CATALOG = [
    {"command": "create_track", "args": [{"name": "name", "type": "string", "required": False},
                                          {"name": "type", "type": "string", "required": False}]},
    {"command": "add_midi_clip", "args": [{"name": "trackId", "type": "string", "required": True},
                                           {"name": "start", "type": "number", "required": False},
                                           {"name": "length", "type": "number", "required": False}]},
    {"command": "add_note", "args": [{"name": "clipId", "type": "string", "required": True},
                                      {"name": "pitch", "type": "number", "required": True},
                                      {"name": "start", "type": "number", "required": True},
                                      {"name": "length", "type": "number", "required": True},
                                      {"name": "velocity", "type": "number", "required": False}]},
    {"command": "import_clip", "args": [{"name": "file", "type": "string", "required": True},
                                         {"name": "trackId", "type": "string", "required": False}]},
    {"command": "set_tempo", "args": [{"name": "bpm", "type": "number", "required": True}]},
]
MANIFEST = {"trackIds": ["track_1", "track_2"], "clipIds": ["clip_1"],
            "sectionIds": ["sec_1"], "annotationIds": []}


def note(clip, pitch=60):
    return {"command": "add_note", "args": {"clipId": clip, "pitch": pitch, "start": 0, "length": 1}}


# ── score_candidate ──────────────────────────────────────────────────────────

# 1. Fully grounded candidate scores 1.0.
r = core.score_candidate(MANIFEST, CATALOG, [note("clip_1"), {"command": "set_tempo", "args": {"bpm": 140}}])
check("grounded candidate scores 1.0", r["score"] == 1.0, json.dumps(r))

# 2. Stale/hallucinated id → hard zero with a grounding reason (the measured failure class).
r = core.score_candidate(MANIFEST, CATALOG, [note("clip_99")])
check("stale id hard-zeros", r["score"] == 0.0 and any("grounding" in x for x in r["reasons"]), json.dumps(r))

# 3. Id created earlier IN the candidate → neutral, NOT zero (no anti-create bias).
batch = [{"command": "add_midi_clip", "args": {"trackId": "track_1"}}, note("clip_new")]
r = core.score_candidate(MANIFEST, CATALOG, batch)
check("created-id is neutral not zero", 0.0 < r["score"] < 1.0,
      f"score={r['score']} reasons={r['reasons']}")

# 4. Create must PRECEDE the use — a use BEFORE any create is still hard zero.
r = core.score_candidate(MANIFEST, CATALOG, [note("clip_new"), {"command": "add_midi_clip", "args": {"trackId": "track_1"}}])
check("use-before-create hard-zeros", r["score"] == 0.0, json.dumps(r["reasons"]))

# 5. Input file path must exist: invented path → hard zero; real path passes.
with tempfile.TemporaryDirectory() as td:
    wav = os.path.join(td, "loop.wav")
    open(wav, "w").write("x")
    r_ok = core.score_candidate(MANIFEST, CATALOG, [{"command": "import_clip", "args": {"file": wav, "trackId": "track_1"}}])
    r_bad = core.score_candidate(MANIFEST, CATALOG, [{"command": "import_clip", "args": {"file": os.path.join(td, "nope.wav")}}])
check("real input path passes", r_ok["score"] == 1.0, json.dumps(r_ok))
check("invented input path hard-zeros", r_bad["score"] == 0.0 and any("file" in x for x in r_bad["reasons"]), json.dumps(r_bad))

# 6. Unknown command → failed catalog check (not hard zero — one bad command in a
#    batch shouldn't erase the signal of the rest), missing required arg + wrong type fail too.
r = core.score_candidate(MANIFEST, CATALOG, [{"command": "warp_time", "args": {}}, note("clip_1")])
check("unknown command fails check, not hard-zero", 0.0 < r["score"] < 1.0 and any("catalog" in x for x in r["reasons"]), json.dumps(r))
r = core.score_candidate(MANIFEST, CATALOG, [{"command": "set_tempo", "args": {}}])
check("missing required arg fails", r["score"] < 1.0 and any("required" in x for x in r["reasons"]), json.dumps(r))
r = core.score_candidate(MANIFEST, CATALOG, [{"command": "set_tempo", "args": {"bpm": "fast"}}])
check("wrong arg type fails", r["score"] < 1.0 and any("type" in x for x in r["reasons"]), json.dumps(r))

# 7. Shape: empty command list → hard zero.
r = core.score_candidate(MANIFEST, CATALOG, [])
check("empty candidate hard-zeros", r["score"] == 0.0 and any("shape" in x for x in r["reasons"]), json.dumps(r))

# ── dedupe ───────────────────────────────────────────────────────────────────

cands = [{"commands": [note("clip_1")]}, {"commands": [note("clip_1")]}, {"commands": [note("clip_1", 64)]}]
uniq, dups = core.dedupe_candidates(cands)
check("dedupe by canonical commands", len(uniq) == 2 and dups == 1, f"uniq={len(uniq)} dups={dups}")

# ── rank_candidates ──────────────────────────────────────────────────────────

scored = [
    {"commands": [note("clip_1"), note("clip_1", 64)], "score": 1.0},
    {"commands": [note("clip_1")], "score": 1.0},
    {"commands": [note("clip_99")], "score": 0.0},
]
r = core.rank_candidates(scored)
check("rank: score desc, tie → fewer commands", r["order"][0] == 1 and r["order"][-1] == 2, json.dumps(r))
check("tie is flagged with zero margin", r["tieBreak"] is True and r["scoreMargin"] == 0.0, json.dumps(r))

r2 = core.rank_candidates([{"commands": [note("clip_1")], "score": 0.8}, {"commands": [note("clip_99")], "score": 0.2}])
check("clear win: no tie flag, real margin", r2["tieBreak"] is False and abs(r2["scoreMargin"] - 0.6) < 1e-9, json.dumps(r2))

# Ranker seam: an injected ranker callable re-orders within verifiable-valid candidates.
flip = core.rank_candidates(scored, ranker=lambda c: len(c["commands"]))  # prefers MORE commands
check("ranker seam overrides tie-break", flip["order"][0] == 0, json.dumps(flip))

# Ranker HARD guarantee (docstring): the taste seam re-orders WITHIN valid candidates
# but must NEVER promote an invalid (hard-zero) candidate above a verifiable-valid one,
# no matter what magnitude/sign it returns. A ranker that tries to lift the invalid
# candidate (and/or bury the valid one) must not change which candidate is chosen.
malicious = core.rank_candidates(
    [{"commands": [note("clip_1")], "score": 0.3}, {"commands": [note("clip_99")], "score": 0.0}],
    ranker=lambda c: 1e9 if c["score"] == 0.0 else -1e9)
check("ranker cannot promote an invalid candidate over a valid one",
      malicious["chosenIndex"] == 0 and malicious["order"][-1] == 1, json.dumps(malicious))

# Determinism: 3× identical.
runs = [core.rank_candidates(scored) for _ in range(3)]
check("rank 3x deterministic", runs[0] == runs[1] == runs[2])

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
