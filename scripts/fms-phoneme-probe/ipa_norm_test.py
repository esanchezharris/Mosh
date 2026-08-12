#!/usr/bin/env python3
"""ipa_norm golden tests (run 3x — must be byte-identical).

Covers: mapping totality, both-sides inventory equality after folding, normalization
idempotence, and the RED-proof that an unknown segment is FLAGGED by inventory_report
rather than silently dropped (the failure mode that would make every distance wrong).

Run:  "$PROBE_PY" scripts/fms-phoneme-probe/ipa_norm_test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ipa_norm  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


try:
    import panphon
    FT = panphon.FeatureTable()
except Exception:  # noqa: BLE001
    FT = None
    print("[SKIP] panphon not importable — running table-only checks")

# ── 1. Mapping totality ─────────────────────────────────────────────────────────────
check("all 39 ARPAbet classes map", ipa_norm.mapping_totality_check() == [],
      str(ipa_norm.mapping_totality_check()))

# ── 2. Every mapped segment is panphon-known (both sides share one inventory) ───────
if FT is not None:
    all_segs = []
    for phone in list(ipa_norm.ARPA_TO_IPA) + ["AH0", "AY1", "ER2"]:
        all_segs.extend(ipa_norm.arpa_phone_to_segs(phone))
    rep = ipa_norm.inventory_report(all_segs, FT)
    check("ARPA→IPA output fully panphon-scorable", rep["unknown"] == [],
          f"unknown={rep['unknown']}")

    fold_out = []
    for v in ipa_norm.SEG_FOLD.values():
        if v:
            fold_out.extend(v)
    rep2 = ipa_norm.inventory_report(fold_out, FT)
    check("SEG_FOLD values fully panphon-scorable", rep2["unknown"] == [],
          f"unknown={rep2['unknown']}")

# ── 3. Diphthong equality across both sides ─────────────────────────────────────────
ay = ipa_norm.arpa_phone_to_segs("AY1")
esp = ipa_norm.normalize_ipa("aɪ", FT)
check("AY1 and espeak 'aɪ' land on identical segs", ay == esp, f"{ay} vs {esp}")
er = ipa_norm.arpa_phone_to_segs("ER0")
esp_er = ipa_norm.normalize_ipa("ɚ", FT)
check("ER0 and espeak 'ɚ' land on identical segs", er == esp_er, f"{er} vs {esp_er}")

# ── 4. Normalization strips marks + is idempotent ───────────────────────────────────
n1 = ipa_norm.normalize_ipa("ˈdaʊn ˌdaʊnː", FT)
check("stress/length marks stripped", "ˈ" not in n1 and "ː" not in n1, str(n1))
n2 = ipa_norm.normalize_ipa("".join(n1), FT)
check("normalization idempotent", n1 == n2, f"{n1} vs {n2}")

# ── 5. AH stress split ──────────────────────────────────────────────────────────────
check("AH0 → schwa, AH1 → wedge",
      ipa_norm.arpa_phone_to_segs("AH0") == ["ə"]
      and ipa_norm.arpa_phone_to_segs("AH1") == ["ʌ"])

# ── 6. RED-proof: unknown segment must be FLAGGED, never silently accepted ──────────
if FT is not None:
    rep3 = ipa_norm.inventory_report(["✗", "a"], FT)
    check("RED: bogus segment flagged by inventory_report", rep3["unknown"] == ["✗"],
          str(rep3))
    check("RED: coverage reflects the hole", rep3["coverage"] == 0.5, str(rep3))

# ── 7. arpa_line_to_ipa over a stub pronouncer ──────────────────────────────────────
class StubPron:
    LEX = {"down": ["D", "AW1", "N"], "going": ["G", "OW1", "IH0", "NG"]}

    def phones(self, w):
        return self.LEX.get(w.lower())

    def stress(self, w):
        ph = self.phones(w) or []
        return "".join("X" if p[-1] in "12" else "x" for p in ph if p[-1].isdigit())


line = ipa_norm.arpa_line_to_ipa(["going", "down"], StubPron())
check("line: segs concatenate", line["segs"] == ["ɡ", "o", "ʊ", "ɪ", "ŋ", "d", "a", "ʊ", "n"],
      str(line["segs"]))
check("line: syllables/vowels/stress", line["syllables"] == 3
      and line["vowels"] == ["o", "ɪ", "a"] and line["stress"] == "XxX", str(line))
check("line: unpronounceable word → None (excluded, not guessed)",
      ipa_norm.arpa_line_to_ipa(["zzqx"], StubPron()) is None)

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failing")
sys.exit(1 if fails else 0)
