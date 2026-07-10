#!/usr/bin/env python3
"""Golden tests for rhyme-scheme inference (FMS hybrid rewrite-and-sing, stage 3).

`infer_scheme` assigns a rhyme-group label per line so the rewriter can rhyme a mumbled
line to its CLEAR neighbours. It reads the take's clear end-words as evidence: within a
4-line stanza it picks AABB (couplets, the default) or ABAB by which fits the clear rhymes,
and mumble lines (no end-word) inherit their position's group. Deterministic: 3x identical.

Run:  python3 scripts/fms-killshot/rhyme_scheme_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import rhyme_scheme as rs  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def L(end, origin="sung"):
    return {"endWord": end, "origin": origin}


def M():
    return {"endWord": None, "origin": "mumble"}


# ── 1. No evidence (all mumble) → default AABB couplets ─────────────────────────────────
g = rs.infer_scheme([M(), M(), M(), M()])
check("all-mumble 4 lines default to AABB couplets", g == ["A", "A", "B", "B"], str(g))

# ── 2. Clear AABB evidence stays AABB (adjacent lines rhyme) ────────────────────────────
g = rs.infer_scheme([L("night"), L("light"), L("gold"), L("cold")])
check("clear adjacent rhymes → AABB", g == ["A", "A", "B", "B"], str(g))

# ── 3. Clear ABAB evidence flips to ABAB (alternate lines rhyme) ────────────────────────
g = rs.infer_scheme([L("night"), L("gold"), L("light"), L("cold")])
check("clear alternating rhymes → ABAB", g == ["A", "B", "A", "B"], str(g))

# ── 4. A mumble line shares its partner's group (so it rhymes to a real neighbour) ──────
g = rs.infer_scheme([L("night"), M(), L("gold"), L("cold")])
check("mumble line inherits its couplet partner's group",
      g[0] == g[1] and g == ["A", "A", "B", "B"], str(g))

# ── 5. Fresh letters per stanza — no cross-stanza rhyme leakage ─────────────────────────
g = rs.infer_scheme([M()] * 8)
check("second stanza gets fresh groups", g == ["A", "A", "B", "B", "C", "C", "D", "D"], str(g))

# ── 6. Short tail stanzas (<4 lines) still pair by couplet ──────────────────────────────
check("1 line → single group", rs.infer_scheme([M()]) == ["A"])
check("2 lines → one couplet", rs.infer_scheme([M(), M()]) == ["A", "A"])
check("3 lines → couplet + singleton", rs.infer_scheme([M(), M(), M()]) == ["A", "A", "B"])

# ── 7. Partial lines contribute their end-word as evidence like sung lines ──────────────
g = rs.infer_scheme([L("flame", "partial"), L("name", "partial"), M(), M()])
check("partial end-words are evidence too (they rhyme → AABB)", g == ["A", "A", "B", "B"], str(g))

# ── 8. Non-rhyming adjacent clear pair does NOT falsely confirm — falls back to default ─
# ends: only positions 0 and 2 are clear and they rhyme; 1,3 mumble. The single cross
# evidence (0~2 rhyme) is what "infer from clear neighbours" should catch → ABAB.
g = rs.infer_scheme([L("mind"), M(), L("find"), M()])
check("only-alternate clear rhyme evidence → ABAB", g == ["A", "B", "A", "B"], str(g))

# ── 9. Determinism: 3x identical ───────────────────────────────────────────────────────
sample = [L("night"), L("gold"), L("light"), L("cold"), M(), M(), L("flame"), L("name")]
outs = {tuple(rs.infer_scheme(sample)) for _ in range(3)}
check("3x deterministic", len(outs) == 1, str(outs))

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
