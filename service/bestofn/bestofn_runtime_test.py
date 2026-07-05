#!/usr/bin/env python3
"""Golden tests for the best-of-n escalation runtime (WP-11) — HERMETIC: the brain
is a mocked `chat` callable (the llm_backend_test.py pattern), the archive goes to
a tmpdir, and the fake backend is pinned via MOSH_ENABLE_BESTOFN=0. 3× deterministic.

Run:  python3 service/bestofn/bestofn_runtime_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from bestofn import runtime  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


CATALOG = [
    {"command": "add_note", "args": [{"name": "clipId", "type": "string", "required": True},
                                      {"name": "pitch", "type": "number", "required": True},
                                      {"name": "start", "type": "number", "required": True},
                                      {"name": "length", "type": "number", "required": True}]},
    {"command": "set_tempo", "args": [{"name": "bpm", "type": "number", "required": True}]},
]
MANIFEST = {"trackIds": ["track_1"], "clipIds": ["clip_1"], "sectionIds": [], "annotationIds": []}


def note(pitch, clip="clip_1"):
    return {"command": "add_note", "args": {"clipId": clip, "pitch": pitch, "start": 0, "length": 1}}


def payload(first_cmds, n=4):
    return {"utterance": "put a melody on it",
            "messages": [{"role": "system", "content": "SYS"}, {"role": "user", "content": "put a melody on it"}],
            "catalog": CATALOG, "manifest": MANIFEST,
            "first": {"say": "on it", "intent": "ACK_GOT_IT", "commands": first_cmds}, "n": n}


def reply(cmds, say="variant"):
    return {"ok": True, "content": json.dumps({"intent": "ACK_GOT_IT", "say": say, "commands": cmds})}


NOW = 1751600000.0

# ── parse_reply leniency ─────────────────────────────────────────────────────

p = runtime.parse_reply('```json\n{"intent":"ACK_GOT_IT","commands":[{"command":"set_tempo","args":{"bpm":90}}]}\n```')
check("parse: fenced JSON", p is not None and p["commands"][0]["command"] == "set_tempo")
p = runtime.parse_reply('noise before {"say":"hi","intent":"GREET","commands":[]} noise after')
check("parse: brace extraction", p is not None and p["intent"] == "GREET")
check("parse: garbage → None", runtime.parse_reply("not json at all") is None)

# ── escalate: happy path ─────────────────────────────────────────────────────

with tempfile.TemporaryDirectory() as td:
    draws = [reply([note(64)]), reply([note(67)]), reply([note(60), note(64)])]
    chat = lambda messages, temperature=None: draws.pop(0)  # noqa: E731
    r = runtime.escalate(payload([note(60)]), chat=chat, now=NOW, pairs_dir=td)
    check("happy: ok + not degraded", r["ok"] and r["degraded"] is False, json.dumps(r)[:200])
    check("happy: 4 ranked candidates", len(r["candidates"]) == 4)
    check("happy: candidates carry say/score/sampling",
          all("say" in c and "score" in c and "sampling" in c for c in r["candidates"]))
    check("happy: ranked order — chosen is index 0 with top score",
          r["candidates"][0]["score"] == max(c["score"] for c in r["candidates"]))
    check("happy: firstIndex locates the single-shot in ranked order",
          isinstance(r["firstIndex"], int) and r["candidates"][r["firstIndex"]]["commands"] == [note(60)])
    files = [f for f in os.listdir(td) if f.endswith(".jsonl")]
    check("happy: archived one row", r["archived"] is True and len(files) == 1)
    row = json.loads(open(os.path.join(td, files[0])).read().strip())
    check("archive row shape", all(k in row for k in
          ("ts", "utterance", "policy", "candidates", "chosenIndex", "scoreMargin", "tieBreak", "latencyMs", "source"))
          and row["source"] == "escalate" and len(row["candidates"]) == 4, json.dumps(row)[:200])
    check("archive stores the RAW utterance (DPO prompt, not a hash)",
          row["utterance"] == "put a melody on it", row.get("utterance"))

# ── escalate: draw failures tolerated, all-fail → degraded, no archive ──────

with tempfile.TemporaryDirectory() as td:
    seq = [{"ok": False, "error": "boom"}, {"ok": True, "content": "garbage{{{"}, reply([note(67)])]
    chat = lambda messages, temperature=None: seq.pop(0)  # noqa: E731
    r = runtime.escalate(payload([note(60)]), chat=chat, now=NOW, pairs_dir=td)
    check("partial failures: still ranks 2 usable", r["degraded"] is False and len(r["candidates"]) == 2
          and r["drawsFailed"] == 2, json.dumps({k: r[k] for k in ("degraded", "drawsFailed")}))

with tempfile.TemporaryDirectory() as td:
    chat = lambda messages, temperature=None: {"ok": False, "error": "down"}  # noqa: E731
    r = runtime.escalate(payload([note(60)]), chat=chat, now=NOW, pairs_dir=td)
    check("all draws fail: degraded, k=1, NOT archived",
          r["degraded"] is True and len(r["candidates"]) == 1 and r["archived"] is False
          and not os.listdir(td))

# ── escalate: duplicate draws dedupe → degraded ─────────────────────────────

with tempfile.TemporaryDirectory() as td:
    chat = lambda messages, temperature=None: reply([note(60)], say="same")  # identical commands  # noqa: E731
    r = runtime.escalate(payload([note(60)]), chat=chat, now=NOW, pairs_dir=td)
    check("identical draws dedupe to k=1 → degraded", r["degraded"] is True and len(r["candidates"]) == 1)

# ── escalate: a better-grounded draw outranks a stale-id single-shot ────────

with tempfile.TemporaryDirectory() as td:
    seq = [reply([note(64)])] + [{"ok": False, "error": "x"}] * 2
    chat = lambda messages, temperature=None: seq.pop(0)  # noqa: E731
    r = runtime.escalate(payload([note(60, clip="clip_STALE")]), chat=chat, now=NOW, pairs_dir=td)
    check("grounded draw beats stale single-shot", r["candidates"][0]["commands"] == [note(64)]
          and r["firstIndex"] == 1, json.dumps(r["candidates"][0]))

# ── fake backend: pinned + deterministic ────────────────────────────────────

os.environ["MOSH_ENABLE_BESTOFN"] = "0"
try:
    with tempfile.TemporaryDirectory() as td:
        r1 = runtime.escalate(payload([note(60), note(64)]), chat=None, now=NOW, pairs_dir=td)
        r2 = runtime.escalate(payload([note(60), note(64)]), chat=None, now=NOW, pairs_dir=td)
        check("fake backend pinned", r1["backend"] == "fake")
        check("fake: drop-last variant ranks alongside first", len(r1["candidates"]) == 2)
        # Smoke-caught product bug: the fake variant must NEVER replace real content
        # (it won the fewer-commands tie-break) — fake is ALWAYS degraded + unarchived.
        check("fake is always degraded (single-shot stands)", r1["degraded"] is True and r1["archived"] is False
              and not os.listdir(td))
        check("fake deterministic 2x", json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True))
finally:
    del os.environ["MOSH_ENABLE_BESTOFN"]

# ── archive: unwritable dir is best-effort, never fatal ─────────────────────

with tempfile.TemporaryDirectory() as td:
    ro = os.path.join(td, "ro")
    os.mkdir(ro)
    os.chmod(ro, 0o500)
    draws = [reply([note(64)]), reply([note(67)]), reply([note(72)])]
    chat = lambda messages, temperature=None: draws.pop(0)  # noqa: E731
    r = runtime.escalate(payload([note(60)]), chat=chat, now=NOW, pairs_dir=ro)
    check("unwritable archive dir: ok, archived:false", r["ok"] is True and r["archived"] is False)
    os.chmod(ro, 0o700)

# ── corrective-retry pair appender (the /archive_pair body) ─────────────────

with tempfile.TemporaryDirectory() as td:
    ok = runtime.archive_append({"source": "corrective-retry", "utteranceSha": "x",
                                 "failed": [note(60, clip="nope")], "corrected": [note(60)],
                                 "reason": "grounding"}, pairs_dir=td, now=NOW)
    row = json.loads(open(os.path.join(td, os.listdir(td)[0])).read().strip())
    check("corrective pair appended with ts", ok is True and row["ts"] == NOW and row["source"] == "corrective-retry")

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
