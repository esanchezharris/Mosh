#!/usr/bin/env python3
"""Reality-model lint + freshness cross-checks (DAW-parity program, P1).

Static validity for the parity artifacts, so drift between them fails the CHEAP gate lane
(no binary, no build, <1s). Everything is parsed from text — conformance.py is read by
regex, never imported, so this runs on a box with no numpy.

Checks:
  eval CSV       required columns, unique non-empty ids, non-empty area/user_action
  families       every in-scope (area, user_action) scenario has a FAMILIES entry in
                 conformance.py OR a live backlog_ref (an eval row authored ahead of its
                 implementation); a backlog_ref pointing at a done/missing item fails
  verdicts.json  entry set == CSV scenario set (+ EXTRA_FAMILIES as Post-pack), statuses
                 valid, sorted; every `gap` entry carries a backlog_ref resolving to a
                 backlog item that is NOT done (a done item with a still-gap verdict is
                 exactly the staleness class this program exists to kill)
  backlog        when the private auto-loop ledger is present, its lines are valid
                 JSON with id+status and every reference resolves; public source
                 snapshots may omit it, in which case references remain syntax-checked
  matrix         docs/reality-pack/daw_capability_matrix.csv (once it exists, P2):
                 required columns, unique cap_ids, valid tier/disposition values,
                 backlog_ref + eval_rows references resolve

Exit 0 = model artifacts are internally consistent and fresh.
"""
import csv
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SELF = Path(__file__).resolve().parent
EVAL_CSV = REPO / "docs" / "reality-pack" / "mosh_daw_eval_suite.csv"
MATRIX_CSV = REPO / "docs" / "reality-pack" / "daw_capability_matrix.csv"
CONFORMANCE = SELF / "conformance.py"
VERDICTS = SELF / "verdicts.json"
BACKLOG = REPO / "docs" / "auto-loop" / "backlog.jsonl"

REQUIRED_EVAL_COLS = ["id", "area", "user_action", "initial_state", "expected_state",
                      "expected_audio", "expected_ui", "expected_log_event",
                      "undo_expectation", "pass_fail", "priority"]
VALID_STATUSES = {"pass", "fail", "gap", "hardware", "out-of-scope"}
MATRIX_REQUIRED_COLS = ["cap_id", "name", "area", "tier", "live", "fl", "protools",
                        "reaper", "mosh_engine", "mosh_ui", "disposition", "invariants",
                        "eval_rows", "backlog_ref", "notes"]
VALID_TIERS = {"T0", "T1", "T2", "X"}
VALID_AXIS = {"shipped", "partial", "missing", "n/a"}
VALID_DISPOSITIONS = {"SHIPPED", "PARTIAL", "MISSING", "REJECTED"}
BACKLOG_REF_RE = re.compile(r"^G[0-9]+[A-Za-z0-9-]*$")


def parse_conformance_source():
    """(oos_areas, families_keys, extra_family_names) parsed from conformance.py text."""
    text = CONFORMANCE.read_text()
    m = re.search(r"OUT_OF_SCOPE_AREAS\s*=\s*\{([^}]*)\}", text)
    oos = set(re.findall(r'"([^"]+)"', m.group(1))) if m else set()

    m = re.search(r"\nFAMILIES\s*=\s*\{(.*?)\n\}", text, re.S)
    fams = set()
    if m:
        fams = set(re.findall(r'\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)\s*:', m.group(1)))

    m = re.search(r"\nEXTRA_FAMILIES\s*=\s*\{(.*?)\}", text, re.S)
    extras = set(re.findall(r'"([^"]+)"\s*:', m.group(1))) if m else set()
    return oos, fams, extras


def load_backlog(problems):
    items = {}
    if not BACKLOG.exists():
        return None
    for i, line in enumerate(BACKLOG.read_text().splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError as e:
            problems.append(f"backlog line {i}: invalid JSON ({e})")
            continue
        if not d.get("id") or not d.get("status"):
            problems.append(f"backlog line {i}: missing id/status")
            continue
        if d["id"] in items:
            problems.append(f"backlog: duplicate id {d['id']}")
        items[d["id"]] = d
    return items


def main():
    problems = []
    oos_areas, families, extras = parse_conformance_source()
    if not oos_areas or not families:
        problems.append("could not parse OUT_OF_SCOPE_AREAS / FAMILIES from conformance.py "
                        "— the regex contract broke; fix the parser, don't ship blind")
    loaded_backlog = load_backlog(problems)
    backlog_available = loaded_backlog is not None
    backlog = loaded_backlog or {}

    # ── eval CSV ──────────────────────────────────────────────────────────────────
    rows = list(csv.DictReader(EVAL_CSV.open()))
    cols = rows[0].keys() if rows else []
    for c in REQUIRED_EVAL_COLS:
        if c not in cols:
            problems.append(f"eval CSV: missing required column '{c}'")
    seen_ids = set()
    scenarios = {}
    for r in rows:
        rid = (r.get("id") or "").strip()
        if not rid:
            problems.append("eval CSV: row with empty id")
        elif rid in seen_ids:
            problems.append(f"eval CSV: duplicate id {rid}")
        seen_ids.add(rid)
        if not (r.get("area") or "").strip() or not (r.get("user_action") or "").strip():
            problems.append(f"eval CSV: {rid}: empty area/user_action")
            continue
        scenarios.setdefault((r["area"], r["user_action"]), []).append(r)

    # ── families totality over in-scope scenarios ─────────────────────────────────
    for (area, action), srows in sorted(scenarios.items()):
        if area in oos_areas or (area, action) in families:
            continue
        refs = {(r.get("backlog_ref") or "").strip() for r in srows}
        refs.discard("")
        if not refs:
            problems.append(f"unmapped in-scope scenario with no backlog_ref: {area} / {action} "
                            f"— add a conformance family or author it against a live backlog item")
            continue
        for ref in sorted(refs):
            if not backlog_available:
                if not BACKLOG_REF_RE.fullmatch(ref):
                    problems.append(f"{area} / {action}: malformed backlog_ref '{ref}'")
                continue
            item = backlog.get(ref)
            if item is None:
                problems.append(f"{area} / {action}: backlog_ref '{ref}' does not exist in backlog.jsonl")
            elif item.get("status") == "done":
                problems.append(f"{area} / {action}: backlog_ref '{ref}' is DONE — the capability "
                                f"shipped, so this scenario must gain a conformance family")

    # ── verdicts.json ─────────────────────────────────────────────────────────────
    if not VERDICTS.exists():
        problems.append(f"verdicts.json missing — run conformance.py --write-verdicts and commit it")
    else:
        verdicts = json.loads(VERDICTS.read_text())
        keys = [(v.get("area"), v.get("action")) for v in verdicts]
        if keys != sorted(keys):
            problems.append("verdicts.json: entries are not sorted (regenerate with --write-verdicts)")
        if len(set(keys)) != len(keys):
            problems.append("verdicts.json: duplicate entries")
        vset = set(keys)
        expected = set(scenarios) | {("Post-pack", name) for name in extras}
        for k in sorted(expected - vset):
            problems.append(f"verdicts.json: missing entry for {k[0]} / {k[1]} (stale — regenerate)")
        for k in sorted(vset - expected):
            problems.append(f"verdicts.json: entry for unknown scenario {k[0]} / {k[1]} (stale — regenerate)")
        for v in verdicts:
            st = v.get("status")
            if st not in VALID_STATUSES:
                problems.append(f"verdicts.json: {v.get('area')} / {v.get('action')}: bad status '{st}'")
            ref = v.get("backlog_ref", "")
            if st == "gap":
                if not ref:
                    problems.append(f"verdicts.json: gap without backlog_ref: {v.get('area')} / "
                                    f"{v.get('action')} — every tracked gap must be attributed")
                elif not backlog_available and not BACKLOG_REF_RE.fullmatch(ref):
                    problems.append(f"verdicts.json: malformed gap backlog_ref '{ref}'")
                elif not backlog_available:
                    pass  # Public source snapshots intentionally omit the private status ledger.
                elif ref not in backlog:
                    problems.append(f"verdicts.json: gap backlog_ref '{ref}' not in backlog.jsonl")
                elif backlog[ref].get("status") == "done":
                    problems.append(f"verdicts.json: {v.get('area')} / {v.get('action')} is still 'gap' "
                                    f"but backlog item {ref} is DONE — reconcile (re-run conformance + "
                                    f"scoreboard, or fix the backlog)")

    # ── capability matrix (P2 artifact; linted once present) ──────────────────────
    if MATRIX_CSV.exists():
        mrows = list(csv.DictReader(MATRIX_CSV.open()))
        mcols = mrows[0].keys() if mrows else []
        for c in MATRIX_REQUIRED_COLS:
            if c not in mcols:
                problems.append(f"capability matrix: missing required column '{c}'")
        seen_caps = set()
        for r in mrows:
            cid = (r.get("cap_id") or "").strip()
            if not cid or cid in seen_caps:
                problems.append(f"capability matrix: empty/duplicate cap_id '{cid}'")
            seen_caps.add(cid)
            if (r.get("tier") or "") not in VALID_TIERS:
                problems.append(f"capability matrix: {cid}: bad tier '{r.get('tier')}'")
            for axis in ("mosh_engine", "mosh_ui"):
                if (r.get(axis) or "") not in VALID_AXIS:
                    problems.append(f"capability matrix: {cid}: bad {axis} '{r.get(axis)}'")
            if (r.get("disposition") or "") not in VALID_DISPOSITIONS:
                problems.append(f"capability matrix: {cid}: bad disposition '{r.get('disposition')}'")
            ref = (r.get("backlog_ref") or "").strip()
            if ref and not BACKLOG_REF_RE.fullmatch(ref):
                problems.append(f"capability matrix: {cid}: malformed backlog_ref '{ref}'")
            elif ref and backlog_available and ref not in backlog:
                problems.append(f"capability matrix: {cid}: backlog_ref '{ref}' not in backlog.jsonl")
            for er in filter(None, (x.strip() for x in (r.get("eval_rows") or "").split(";"))):
                if er not in seen_ids:
                    problems.append(f"capability matrix: {cid}: eval_rows ref '{er}' not in the eval CSV")

    for m in problems:
        print(f"  PROBLEM: {m}")
    n_extra = len(extras)
    backlog_label = (f"{len(backlog)} backlog items" if backlog_available
                     else "private backlog omitted")
    print(f"model_lint: {len(rows)} eval rows | {len(scenarios)} scenarios | "
          f"{len(families)} CSV families + {n_extra} post-pack | "
          f"{backlog_label} | {'FAIL' if problems else 'PASS'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
