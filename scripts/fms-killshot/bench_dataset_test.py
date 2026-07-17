#!/usr/bin/env python3
"""Golden tests for the dataset normalizer (pure parse + reverse-map; no corpus/venv).

Run:  python3 scripts/fms-killshot/bench_dataset_test.py   (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_dataset as bd  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# a tiny NUS-48E annotation: sil, "every" (eh v r iy), sp, "morning" (m ao r n ih ng), sil
TXT = """0.000000 3.740216 sil
3.740216 4.000000 eh
4.000000 4.200000 v
4.200000 4.400000 r
4.400000 4.900000 iy
4.900000 4.900000 sp
4.900000 5.100000 m
5.100000 5.400000 ao
5.400000 5.500000 r
5.500000 5.600000 n
5.600000 5.700000 ih
5.700000 6.000000 ng
6.000000 6.500000 sil"""

groups = bd.parse_nus_txt(TXT)
check("splits into 2 words on sp/sil", len(groups) == 2, str([g["phones"] for g in groups]))
check("word 1 spans first→last phone", abs(groups[0]["start"] - 3.740216) < 1e-6 and abs(groups[0]["end"] - 4.9) < 1e-6)
check("word 1 phones", groups[0]["phones"] == ["eh", "v", "r", "iy"])
check("word 2 phones", groups[1]["phones"] == ["m", "ao", "r", "n", "ih", "ng"])
check("silence excluded from words", all("sil" not in g["phones"] and "sp" not in g["phones"] for g in groups))

# reverse map (injected → no cmudict needed)
REV = {("eh", "v", "r", "iy"): "every", ("m", "ao", "r", "n", "ih", "ng"): "morning"}
check("word_text maps known phones", bd.word_text(["eh", "v", "r", "iy"], REV) == "every")
check("word_text is stress-insensitive", bd.word_text(["EH", "V", "R", "IY"], REV) == "every")
check("word_text falls back to phone-join on miss", bd.word_text(["z", "z"], REV) == "zz")

# item assembly
import tempfile
with tempfile.TemporaryDirectory() as td:
    tp = os.path.join(td, "01.txt"); open(tp, "w").write(TXT)
    wp = os.path.join(td, "01.wav"); open(wp, "w").write("")   # existence only
    item = bd.nus_item(tp, wp, REV, singer="ADIZ", song="01")
check("item id", item["id"] == "nus-ADIZ-01")
check("item is eval-only tier", item["license_tier"] == "eval-only")
check("item words carry text+timing+phones",
      item["words"][0] == {"word": "every", "start": 3.740216, "end": 4.9, "phones": ["eh", "v", "r", "iy"]},
      str(item["words"][0]))
check("registry: nus-48e is NOT train_ok", bd.REGISTRY["nus-48e"]["train_ok"] is False)
check("license_tier helper", bd.license_tier("nus-48e") == "eval-only")

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
