#!/usr/bin/env python3
"""distance golden tests (run 3x — must be byte-identical).

RED-proofs required by the repo's vacuous-verification discipline:
  - a shuffled candidate must score strictly WORSE than the true candidate
  - mismatched inputs must score > 0 (a DP stub returning 0 would pass a lazy test)
  - vowel substitutions must cost more than consonant substitutions at vowel_mult=2

Run:  "$PROBE_PY" scripts/fms-phoneme-probe/distance_test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import panphon  # noqa: E402

import distance as D  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


FS = D.FeatureSpace(panphon.FeatureTable())

# ── 1. Identity and symmetry ────────────────────────────────────────────────────────
segs = ["d", "a", "ʊ", "n"]
check("identical → 0", D.weighted_seg_distance(segs, segs, FS) == 0.0)
d_ab = D.weighted_seg_distance(["s", "a"], ["m", "a"], FS)
d_ba = D.weighted_seg_distance(["m", "a"], ["s", "a"], FS)
check("symmetric", abs(d_ab - d_ba) < 1e-12, f"{d_ab} vs {d_ba}")

# ── 2. Feature-weighted substitution: near phones cheap, far phones dear ────────────
d_near = FS.sub_cost("s", "ʃ")
d_far = FS.sub_cost("s", "m")
check("s↔ʃ cheaper than s↔m", 0 < d_near < d_far, f"{d_near:.3f} vs {d_far:.3f}")

# ── 3. Vowel emphasis: a vowel substitution outweighs a consonant one ───────────────
base = ["d", "a", "n"]
d_vowel = D.weighted_seg_distance(base, ["d", "i", "n"], FS)     # a→i (both vowels)
d_cons = D.weighted_seg_distance(base, ["b", "a", "n"], FS)      # d→b (both consonants)
check("vowel sub costs more than consonant sub (vowel_mult=2)", d_vowel > d_cons,
      f"{d_vowel:.3f} vs {d_cons:.3f}")

# ── 3b. Nucleus vs glide: dropping a diphthong glide is cheaper than a nucleus ──────
d_glide = D.weighted_seg_distance(["d", "a", "ʊ", "n"], ["d", "a", "n"], FS)   # sung "down"
d_nucl = D.weighted_seg_distance(["d", "a", "ʊ", "n"], ["d", "ʊ", "n"], FS)    # nucleus gone
check("glide drop cheaper than nucleus drop", d_glide < d_nucl,
      f"{d_glide:.3f} vs {d_nucl:.3f}")
check("nucleus flags: vowel-after-vowel is a glide",
      D.nucleus_flags(["d", "a", "ʊ", "n", "i"]) == [False, True, False, False, True])

# ── 4. RED: mismatched inputs are strictly > 0 (kills a cost=0 DP stub) ─────────────
check("RED: mismatch > 0", D.weighted_seg_distance(segs, ["z", "i"], FS) > 0.5)
check("RED: empty-vs-nonempty > 0", D.weighted_seg_distance([], segs, FS) > 0)

# ── 5. RED: shuffled candidate scores worse than the true candidate ─────────────────
tpl = {"segs": ["a", "ɪ", "m", "ɡ", "o", "ʊ", "ɪ", "ŋ", "d", "a", "ʊ", "n"],
       "vowels": ["a", "o", "ɪ", "a"], "syllables": 4, "stress": "XxXx"}
true_cand = {"segs": list(tpl["segs"]), "vowels": list(tpl["vowels"]),
             "syllables": 4, "stress": "XxXx"}
shuf = {"segs": ["n", "ʊ", "a", "d", "ŋ", "ɪ", "ʊ", "o", "ɡ", "m", "ɪ", "a"],
        "vowels": ["ʊ", "ɪ", "o", "ɪ"], "syllables": 4, "stress": "XxXx"}
s_true = D.score_line(tpl, true_cand, FS)
s_shuf = D.score_line(tpl, shuf, FS)
check("RED: shuffled worse than true", s_shuf["total"] > s_true["total"] + 0.1,
      f"true={s_true['total']:.3f} shuf={s_shuf['total']:.3f}")
check("true candidate scores 0", s_true["total"] == 0.0, str(s_true))

# ── 6. Component wiring: syllable and stress terms actually move the total ──────────
off_syl = dict(true_cand, syllables=7, vowels=true_cand["vowels"] + ["i", "i", "i"])
check("syllable mismatch raises total",
      D.score_line(tpl, off_syl, FS)["total"] > s_true["total"])
off_stress = dict(true_cand, stress="xXxX")
check("stress mismatch raises total",
      D.score_line(tpl, off_stress, FS)["total"] > s_true["total"])

# ── 7. Unknown segment can only HURT (cost 1.0), never help ─────────────────────────
check("unknown seg = max sub cost", FS.sub_cost("a", "✗") == 1.0)

# ── 8. Determinism of a composite score ─────────────────────────────────────────────
r1 = D.score_line(tpl, shuf, FS)
r2 = D.score_line(tpl, shuf, D.FeatureSpace(panphon.FeatureTable()))
check("fresh FeatureSpace reproduces exactly", r1 == r2, f"{r1} vs {r2}")

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failing")
sys.exit(1 if fails else 0)
