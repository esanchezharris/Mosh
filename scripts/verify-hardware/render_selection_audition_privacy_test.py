#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path

MODULE = Path(__file__).with_name("render_selection_audition.py")
SPEC = importlib.util.spec_from_file_location("render_selection_audition", MODULE)
assert SPEC and SPEC.loader
AUDITION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDITION)

fails: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"PASS {name}")
    else:
        print(f"FAIL {name} {detail}")
        fails.append(name)


private = "/private/tmp/mosh-sample"
payload = {
    "safe": "source_id",
    "sample": private,
    "nested": {"sample": private},
}
redacted = AUDITION._redact_private_paths(payload)
text = str(redacted)
prov = type("P", (), {
    "backbone": "b",
    "sources": {},
    "transpose": {},
    "samples": {"808": private},
    "key": "F minor",
    "tempo": 140,
})()

check("safe values preserved", redacted["safe"] == "source_id", str(redacted))
check("absolute paths redacted", private not in text, text)
check("redaction is stable locator", str(redacted["sample"]).startswith("redacted:path:"), str(redacted))
check("private-path opt-in preserves provenance", AUDITION._jsonable_provenance(prov, include_private_paths=True)["samples"]["808"] == private)
check("default provenance redacts samples", private not in str(AUDITION._jsonable_provenance(prov)))

if fails:
    raise SystemExit(f"{len(fails)} failed: {', '.join(fails)}")
print("ALL PASS")
