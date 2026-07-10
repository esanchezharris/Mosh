#!/usr/bin/env python3
"""Golden tests for building a rewrite spec from a gated take (FMS hybrid, stage 3b).

`build_spec` turns per-line gate records (sung / partial / mumble) into the spec that
service/lyrics/core.py consumes: sung lines become LOCKED anchors, mumble lines become
fillable with the detected syllable target, partial lines keep his words as a seed, and
rhyme groups come from rhyme_scheme.infer_scheme. The decisive test round-trips the spec
through the REAL core.complete (fake backend, deterministic) and proves a rewritten line
rhymes to its sung neighbour.

Run:  python3 scripts/fms-killshot/spec_from_take_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import spec_from_take as sft  # noqa: E402
from lyrics import core as lyr  # noqa: E402
from phonology import core as ph  # noqa: E402

fails = []
_P = ph.Pronouncer()


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def SUNG(i, text):
    return {"index": i, "origin": "sung", "text": text,
            "syllables": lyr.syllables(text), "endWord": text.split()[-1]}


def MUMBLE(i, syl):
    return {"index": i, "origin": "mumble", "text": "", "syllables": syl, "endWord": None}


def PARTIAL(i, seed, syl, end=None):
    return {"index": i, "origin": "partial", "seedText": seed, "syllables": syl, "endWord": end}


# ── 1. Sung line → a LOCKED anchor core.complete will skip ─────────────────────────────
spec = sft.build_spec([SUNG(0, "still I hold the flame"), MUMBLE(1, 8)])
l0 = spec["lines"][0]
check("sung line is locked with its verbatim text",
      l0.get("locked") is True and l0.get("text") == "still I hold the flame", str(l0))
check("sung line carries a rhymeGroup + syllableTarget",
      bool(l0.get("rhymeGroup")) and l0.get("syllableTarget") == lyr.syllables("still I hold the flame"), str(l0))

# ── 2. Mumble line → fillable, empty seed, detected syllable target ─────────────────────
l1 = spec["lines"][1]
check("mumble line is fillable (no locked text, empty seed)",
      not l1.get("locked") and not (l1.get("text") or "").strip() and l1.get("seedText", "") == "", str(l1))
check("mumble line target = its detected syllable count", l1.get("syllableTarget") == 8, str(l1))

# ── 3. A couplet shares a rhyme group (mumble rhymes to the sung anchor) ────────────────
check("sung + mumble couplet share a rhyme group",
      spec["lines"][0]["rhymeGroup"] == spec["lines"][1]["rhymeGroup"], str([l["rhymeGroup"] for l in spec["lines"]]))

# ── 4. THE ROUND-TRIP: core.complete rewrites ONLY the mumble line and it rhymes ────────
gen = lyr.complete(spec, backend="fake")
by_idx = {l["index"]: l for l in gen["lines"]}
check("core.complete ran on the spec (fake backend)", gen.get("ok") and gen.get("backend") == "fake", str(gen.get("backend")))
check("the sung anchor line is NOT proposed (locked/skipped)", 0 not in by_idx, str(list(by_idx)))
props = by_idx.get(1, {}).get("proposals") or []
check("the mumble line got proposals", len(props) > 0, str(by_idx.get(1)))
if props:
    end = props[0]["endWord"]
    check("rewritten line hits the syllable target", props[0]["syllables"] == 8, str(props[0]))
    check("rewritten line's end rhymes with the sung anchor 'flame'",
          _P.rhyme(end, "flame", "slant"), f"end={end!r}")

# ── 5. Partial line keeps his words as a seed (fillable, not locked) ────────────────────
spec2 = sft.build_spec([PARTIAL(0, "they counted me ___", 8, end=None), MUMBLE(1, 8)])
p0 = spec2["lines"][0]
check("partial line keeps his kept words in the seed",
      "counted" in p0.get("seedText", "") and not p0.get("locked"), str(p0))
gen2 = lyr.complete(spec2, backend="fake")
pr = {l["index"]: l for l in gen2["lines"]}.get(0, {}).get("proposals") or []
check("partial line is filled and preserves the kept words",
      bool(pr) and "counted" in pr[0]["text"].lower(), str(pr[:1]))

# ── 6. spec carries grid + strictness so core's targets/rhyme match ─────────────────────
check("spec has grid + rhymeStrictness", spec.get("grid") and spec.get("rhymeStrictness"), str({k: spec.get(k) for k in ("grid", "rhymeStrictness")}))

# ── 7. Determinism: 3x identical spec + generation ─────────────────────────────────────
import hashlib
import json
recs = [SUNG(0, "still I hold the flame"), MUMBLE(1, 8), SUNG(2, "through the coldest nights"), MUMBLE(3, 7)]
specs = {hashlib.sha256(json.dumps(sft.build_spec(recs), sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("3x deterministic spec", len(specs) == 1, str(specs))
gens = {hashlib.sha256(json.dumps(lyr.complete(sft.build_spec(recs), backend="fake"), sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("3x deterministic generation over the spec", len(gens) == 1, str(gens))

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
