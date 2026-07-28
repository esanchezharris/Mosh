#!/usr/bin/env python3
"""Guards for the owner-sitting surface (sit.py).

The two properties that make the sitting worth the owner's time, each with a
fixture that can actually carry the failure:

  * **Blindness end-to-end**: the withheld answer never appears in ANY HTTP
    payload. The fixture's truth is a nonsense token that occurs nowhere else,
    so its absence from the wire is meaningful — and a sabotage that embeds the
    answers file into /api/state turns this red at the HTTP layer, not in a
    unit's imagination.
  * **Sequencing**: an item in both the accept queue and the norming packet is
    withheld from the accept panel until its norming answer is written — seeing
    the machine's word first would contaminate the ceiling.

Hermetic: MOSH_LYRICS_BENCH_DIR points at a temp dir; invented lyrics only.
Run:  python3 service/lyrics/bench/sit_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile
import threading
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

_TMP = tempfile.mkdtemp(prefix="sit-test-")
os.environ["MOSH_LYRICS_BENCH_DIR"] = _TMP        # before any bench import

from lyrics.bench import accept_set, sit  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── fixtures (invented text; the truth token is deliberately nonsense) ───────────
TRUTH = "zorbulate"          # appears ONLY in the withheld answers + eval items
PACKET_DIR = os.path.join(_TMP, "norming", "packet")
os.makedirs(PACKET_DIR)
PACKET = [
    {"no": 1, "itemId": "t:overlap:1", "syllables": 1, "rhymeWith": "glow",
     "sectionKind": "verse", "before": ["invented bar one"],
     "maskedLine": "invented bar two ends with ____", "after": [],
     "scope": "full-section"},
    {"no": 2, "itemId": "t:packet-only:2", "syllables": 2, "rhymeWith": None,
     "sectionKind": "verse", "before": [], "maskedLine": "another bar ____",
     "after": ["closing invented bar"], "scope": "full-section"},
]
with open(os.path.join(PACKET_DIR, "packet.json"), "w", encoding="utf-8") as f:
    json.dump({"version": "v1", "slice": "dev", "n": 2,
               "stratification": {}, "items": PACKET}, f)
# Withheld key OUTSIDE the packet dir, as the exporter guarantees.
ANSWERS = os.path.join(_TMP, "norming", "answers-dev.json")
with open(ANSWERS, "w", encoding="utf-8") as f:
    json.dump({"answers": [{"no": 1, "itemId": "t:overlap:1", "answer": TRUTH,
                            "giveaway": False}]}, f)

RUN_DIR = os.path.join(_TMP, "runs", "9999-prompt-rhyme-menu-fp-dev")
os.makedirs(RUN_DIR)
ROWS = [
    # wrong + unjudged + ALSO in the packet → must be excluded until answered
    {"itemId": "t:overlap:1", "exact": 0, "topk": 0, "candidates": ["flow"]},
    # wrong + unjudged, not in the packet → in the queue
    {"itemId": "t:queue:3", "exact": 0, "topk": 0, "candidates": ["grow"]},
    # exact → never queued
    {"itemId": "t:exact:4", "exact": 1, "topk": 1, "candidates": [TRUTH]},
]
with open(os.path.join(RUN_DIR, "results-prompt-rhyme-menu-fp.jsonl"), "w",
          encoding="utf-8") as f:
    f.write("\n".join(json.dumps(r) for r in ROWS) + "\n")

os.makedirs(os.path.join(_TMP, "eval"))
ITEMS = [
    {"itemId": "t:overlap:1", "granularity": "rhyme", "split": "dev",
     "context": {"before": ["invented bar one"],
                 "maskedLine": "invented bar two ends with ____", "after": []},
     "target": {"text": TRUTH}, "constraints": {"rhymeWith": "glow"}},
    {"itemId": "t:queue:3", "granularity": "rhyme", "split": "dev",
     "context": {"before": ["setup bar"], "maskedLine": "the third bar ____",
                 "after": ["outro bar"]},
     "target": {"text": "slow"}, "constraints": {"rhymeWith": "glow"}},
    {"itemId": "t:exact:4", "granularity": "rhyme", "split": "dev",
     "context": {"before": [], "maskedLine": "the fourth bar ____", "after": []},
     "target": {"text": TRUTH}, "constraints": {"rhymeWith": "glow"}},
]
with open(os.path.join(_TMP, "eval", "items-dev.jsonl"), "w",
          encoding="utf-8") as f:
    f.write("\n".join(json.dumps(i) for i in ITEMS) + "\n")


# ── sheet round-trips ────────────────────────────────────────────────────────────
SHEET = sit.sheet_path(os.path.join(_TMP, "norming"))
sit.write_sheet_entry(SHEET, 7, ["money", "honey"])
sit.write_sheet_entry(SHEET, 9, ["gold"])
s = sit.read_sheet(SHEET)
check("sheet: entries accumulate across writes (merge, not overwrite)",
      s.get(7) == ["money", "honey"] and s.get(9) == ["gold"], str(s))
sit.write_sheet_entry(SHEET, 7, ["cash"])
s = sit.read_sheet(SHEET)
check("sheet: re-answer overwrites its own number only",
      s.get(7) == ["cash"] and s.get(9) == ["gold"], str(s))
sit.write_sheet_entry(SHEET, 9, [])
check("sheet: an emptied answer un-answers the item",
      9 not in sit.read_sheet(SHEET))
os.remove(SHEET)

# ── assert_blind ─────────────────────────────────────────────────────────────────
try:
    sit.assert_blind(PACKET_DIR)
    check("assert_blind: clean packet dir passes", True)
except RuntimeError:
    check("assert_blind: clean packet dir passes", False)
_leaky = os.path.join(PACKET_DIR, "answers-dev.json")
with open(_leaky, "w", encoding="utf-8") as f:
    f.write("{}")
try:
    sit.assert_blind(PACKET_DIR)
    check("assert_blind: answers INSIDE the packet dir refuse to serve", False,
          "no exception")
except RuntimeError:
    check("assert_blind: answers INSIDE the packet dir refuse to serve", True)
os.remove(_leaky)

# ── the live HTTP path ───────────────────────────────────────────────────────────
srv, info = sit.make_server(PACKET_DIR, RUN_DIR, slice_="dev", port=0)
port = srv.server_address[1]
t = threading.Thread(target=srv.serve_forever, daemon=True)
t.start()


def get(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}") as r:
        return r.read().decode("utf-8")


def post(path, payload):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                 data=json.dumps(payload).encode("utf-8"),
                                 method="POST")
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:  # noqa: PERF203
        return json.loads(e.read().decode("utf-8"))


page = get("/")
state = json.loads(get("/api/state"))
check("BLINDNESS: the withheld answer appears in NO payload",
      TRUTH not in page and TRUTH not in json.dumps(state),
      "the truth token leaked onto the wire")
check("state: packet served in full, answers counted from the sheet",
      state["norming"]["total"] == 2 and state["norming"]["answered"] == 0)
qids = [q["itemId"] for q in state["accept"]["queue"]]
check("SEQUENCING: overlap item withheld from the accept queue until normed",
      "t:overlap:1" not in qids and state["accept"]["excludedUntilNormed"] == 1,
      str(qids))
check("accept queue: wrong+unjudged item present, exact item absent",
      qids == ["t:queue:3"], str(qids))
check("accept queue: the filled bar carries the machine's word in context",
      "grow" in state["accept"]["queue"][0]["filled"])

r = post("/api/norming", {"no": 1, "guesses": ["glow", "flow"]})
check("POST /api/norming: writes the sheet and reports progress",
      r.get("ok") and r.get("answered") == 1, str(r))
state2 = json.loads(get("/api/state"))
qids2 = [q["itemId"] for q in state2["accept"]["queue"]]
check("SEQUENCING: answering the norming item RELEASES it to the accept queue",
      "t:overlap:1" in qids2 and state2["accept"]["excludedUntilNormed"] == 0,
      str(qids2))
check("BLINDNESS holds after writes too",
      TRUTH not in json.dumps(state2))

r = post("/api/accept", {"itemId": "t:queue:3", "word": "Grow", "verdict": "accept"})
check("POST /api/accept: records and reports the judged count",
      r.get("ok") and r.get("judged") == 1, str(r))
sets = accept_set.load("dev")
check("accept judgement lands NORMALIZED in the append-only log",
      "grow" in sets.get("t:queue:3", {}).get("accept", set()), str(sets))
state3 = json.loads(get("/api/state"))
check("a judged fill leaves the accept queue",
      "t:queue:3" not in [q["itemId"] for q in state3["accept"]["queue"]])
r = post("/api/accept", {"itemId": "t:queue:3", "word": "grow", "verdict": "maybe"})
check("POST /api/accept: an invalid verdict is refused, never recorded",
      not r.get("ok"))

# ── the CLOSED marker lifts the sequencing lock (and ONLY the marker does) ──────
# Un-answer item 1 so the overlap item goes back behind the lock…
post("/api/norming", {"no": 1, "guesses": []})
state4 = json.loads(get("/api/state"))
check("lock re-engages when an answer is withdrawn (marker absent)",
      state4["accept"]["excludedUntilNormed"] == 1
      and not state4["norming"]["closed"],
      str(state4["accept"]["excludedUntilNormed"]))
# …then declare the sitting closed.
_marker = os.path.join(_TMP, "norming", "CLOSED")
with open(_marker, "w", encoding="utf-8") as f:
    f.write("declared complete in test\n")
state5 = json.loads(get("/api/state"))
check("CLOSED marker: lock lifts, blind item enters the accept queue",
      state5["norming"]["closed"]
      and state5["accept"]["excludedUntilNormed"] == 0
      and "t:overlap:1" in [q["itemId"] for q in state5["accept"]["queue"]],
      str(state5["accept"]))
check("BLINDNESS survives the closed state (answers still never on the wire)",
      TRUTH not in json.dumps(state5))
os.remove(_marker)

srv.shutdown()
srv.server_close()

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
