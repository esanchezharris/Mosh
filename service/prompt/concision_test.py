#!/usr/bin/env python3
"""Unit test for the deterministic prompt-concision rewriter (05 §6).

Stdlib only — no third-party deps, no SA3/MLX, no network. Proves the rewriter
shortens (or never lengthens) a verbose generative prompt, that it is fully
deterministic (same input -> identical bytes), and that it never touches the
command surface (it's a standalone pure-Python helper).

Run:  python3 service/prompt/concision_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from prompt import concision  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── 1. Concision: a verbose prompt gets meaningfully shorter ──────────────────
verbose = (
    "Please can you make me a really very dark, gritty, moody, dark, and "
    "atmospheric kind of techno loop, I want it to be like a deep, hypnotic, "
    "deep techno groove, thanks so much!!!"
)
r = concision.rewrite(verbose)

check("returns the original verbatim", r.original == verbose, r.original)
check("after is not longer than before (chars)",
      r.chars_after <= r.chars_before, f"{r.chars_before} -> {r.chars_after}")
check("after is not longer than before (words)",
      r.words_after <= r.words_before, f"{r.words_before} -> {r.words_after}")
check("verbose prompt is meaningfully shortened (>=20% fewer chars)",
      r.chars_after <= 0.80 * r.chars_before,
      f"{r.chars_before} -> {r.chars_after}")
check("reduction ratio is reported and in [0,1]",
      0.0 <= r.reduction <= 1.0, str(r.reduction))

# ── 2. Filler / politeness scrubbing ─────────────────────────────────────────
rw = r.rewritten.lower()
check("drops 'please'", "please" not in rw, r.rewritten)
check("drops 'thanks'", "thank" not in rw, r.rewritten)
check("drops 'can you make me'", "can you make" not in rw, r.rewritten)
check("drops 'i want'", "i want" not in rw, r.rewritten)
check("drops the 'kind of' hedge", "kind of" not in rw, r.rewritten)
check("collapses 'really very' intensifier stack",
      "really very" not in rw, r.rewritten)

# ── 3. Case-insensitive descriptor de-duplication, first occurrence kept ──────
dup = "Dark, gritty, dark, GRITTY, dark techno"
rd = concision.rewrite(dup)
toks = [t.strip().lower() for t in rd.rewritten.split(",")]
check("de-dupes repeated 'dark' descriptor",
      toks.count("dark") <= 1, rd.rewritten)
check("de-dupes repeated 'gritty' descriptor",
      toks.count("gritty") <= 1, rd.rewritten)
check("keeps first-seen casing of a kept descriptor",
      "Dark" in rd.rewritten, rd.rewritten)

# ── 4. Determinism: same input -> byte-identical output, repeatedly ───────────
a = concision.rewrite(verbose)
b = concision.rewrite(verbose)
check("deterministic across two calls (rewritten)",
      a.rewritten == b.rewritten, f"{a.rewritten!r} vs {b.rewritten!r}")
check("deterministic metrics", (a.chars_after, a.words_after) == (b.chars_after, b.words_after))

# ── 5. Whitespace + punctuation normalization ────────────────────────────────
messy = "  warm   pad,,  lush ,  ambient   "
rm = concision.rewrite(messy)
check("collapses runs of whitespace", "  " not in rm.rewritten, repr(rm.rewritten))
check("no leading/trailing whitespace", rm.rewritten == rm.rewritten.strip(), repr(rm.rewritten))
check("collapses doubled commas", ",," not in rm.rewritten, repr(rm.rewritten))
check("no empty descriptor segments",
      all(seg.strip() for seg in rm.rewritten.split(",")), repr(rm.rewritten))

# ── 6. Edge cases: empty / whitespace / already-concise prompts ───────────────
re_ = concision.rewrite("")
check("empty prompt -> empty rewrite", re_.rewritten == "", repr(re_.rewritten))
check("empty prompt -> reduction 0.0", re_.reduction == 0.0, str(re_.reduction))

rws = concision.rewrite("   \t  \n ")
check("whitespace-only -> empty rewrite", rws.rewritten == "", repr(rws.rewritten))

terse = "dark techno loop"
rt = concision.rewrite(terse)
check("already-concise prompt is preserved (no over-trim)",
      rt.rewritten == terse, repr(rt.rewritten))
check("already-concise prompt -> reduction 0.0", rt.reduction == 0.0, str(rt.reduction))

# ── 7. Idempotence: rewriting a rewrite is a no-op ────────────────────────────
once = concision.rewrite(verbose).rewritten
twice = concision.rewrite(once).rewritten
check("rewrite is idempotent (fixed point)", once == twice, f"{once!r} -> {twice!r}")

# ── 8. Non-string input is rejected cleanly (no command-surface coupling) ─────
try:
    concision.rewrite(None)  # type: ignore[arg-type]
    check("rejects non-string input", False, "no error raised")
except (TypeError, ValueError):
    check("rejects non-string input", True)

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
