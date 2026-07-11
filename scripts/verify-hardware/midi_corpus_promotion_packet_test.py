#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("midi_corpus_promotion_packet", HERE / "midi_corpus_promotion_packet.py")
assert SPEC and SPEC.loader
PACKET = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKET)

fails: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"PASS {name}")
    else:
        print(f"FAIL {name} {detail}")
        fails.append(name)


decision = PACKET._owner_decision_status(PACKET.DEFAULT_OWNER_DECISION)
missing = PACKET._owner_decision_status(PACKET.REPO / "docs" / "research-policy" / "missing-r7-decision.md")

check("default owner decision artifact exists", decision["durable"], str(decision))
check("missing owner decision is not durable", not missing["durable"], str(missing))
check(
    "research-tracked still blocks without owner decision",
    PACKET._owner_source_policy_required("research-tracked", True, missing),
)
check(
    "research-tracked clears with tracked research and owner decision",
    not PACKET._owner_source_policy_required("research-tracked", True, decision),
)
check(
    "owner-required policy keeps owner blocker",
    PACKET._owner_source_policy_required("owner-required", True, decision),
)

if fails:
    raise SystemExit(f"{len(fails)} failed: {', '.join(fails)}")
print("ALL PASS")
