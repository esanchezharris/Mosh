"""Golden test for service/loras/registry.py — listing, cards, resolve gates.

Run:  python3 service/scripts/loras_registry_test.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)


def main():
    tmp = tempfile.mkdtemp(prefix="lora-registry-test-")
    os.environ["MOSH_LORA_DIR"] = tmp
    from loras import registry as R

    # empty / absent dir degrades to []
    check(R.list_loras() == [], "absent dir should list []")
    os.makedirs(os.path.join(tmp, "sa3"))
    check(R.list_loras() == [], "empty dir should list []")

    # two loras, one with a card, one bare, plus a non-safetensors ignored
    open(os.path.join(tmp, "sa3", "alpha.safetensors"), "wb").write(b"x")
    open(os.path.join(tmp, "sa3", "beta.safetensors"), "wb").write(b"x")
    open(os.path.join(tmp, "sa3", "notes.txt"), "w").write("ignore me")
    json.dump({"displayName": "Alpha One", "trigger": "aaa", "hint": "dark"},
              open(os.path.join(tmp, "sa3", "alpha.json"), "w"))
    open(os.path.join(tmp, "sa3", "beta.json"), "w").write("{broken json")
    ls = R.list_loras()
    check([e["name"] for e in ls] == ["alpha", "beta"], f"names wrong: {ls}")
    check(ls[0]["displayName"] == "Alpha One" and ls[0]["trigger"] == "aaa", "card not read")
    check(ls[1]["displayName"] == "beta" and ls[1]["trigger"] == "",
          "broken card should degrade to defaults")

    # resolve: strengths, zero-skip, caps, unknowns, dupes, lab ceiling
    sel = R.resolve([{"name": "alpha", "value": 100}, {"name": "beta", "value": 40}])
    check([(n, s) for n, _f, s in sel] == [("alpha", 1.0), ("beta", 0.4)], f"resolve wrong: {sel}")
    check(R.resolve([{"name": "alpha", "value": 0}]) == [], "zero value should be inert")
    lab = R.resolve([{"name": "alpha", "value": 100}], lab=True)
    check(lab[0][2] == 1.5, f"lab ceiling wrong: {lab}")
    for bad, why in ([[{"name": "nope", "value": 50}], "unknown"],
                     [[{"name": "alpha", "value": 200}], "range"],
                     [[{"name": "alpha", "value": 50}] * 3, "cap/dupe"],
                     [[{"name": "alpha", "value": 50}, {"name": "alpha", "value": 60}], "dupe"]):
        try:
            R.resolve(bad)
            check(False, f"resolve should reject: {why}")
        except ValueError:
            check(True, "")

    print(f"loras_registry_test OK ({CHECKS} checks)")


if __name__ == "__main__":
    main()
