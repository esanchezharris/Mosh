#!/usr/bin/env python3
"""Golden tests for the B1-lite pure duration-derivation core (service/soulx/duration.py).

Pins: zero-sum (global + per-phrase-with-its-pre-rest), anchor pinning (onset consonants
carved BEFORE the vowel lands on the take's nucleus), function-word compression, final-word
lengthening, short-rest-inside-phrase / big-rest-outside-phrase fixed durations, rest-steal
(full + partial-capped + no-preceding-rest), floor clamp + redistribution, segment-infeasible
verbatim revert, melisma within-unit ratio preservation, strength=0 identity, onset_cluster
agreement with scripts/fms-killshot/vowel_landmark.py, and determinism (3x).

Run:  python3 service/soulx/duration_test.py     (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
REPO = os.path.dirname(SERVICE)
sys.path.insert(0, SERVICE)
sys.path.insert(0, os.path.join(REPO, "scripts", "fms-killshot"))

from soulx import duration as du  # noqa: E402
import vowel_landmark as vl  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def close(a, b, tol=1e-6):
    return abs(a - b) <= tol


def base_params(**overrides):
    p = dict(du.DEFAULT_PARAMS)
    p.update(overrides)
    return p


def note(text, phon, dur, ntype, pitch=60):
    return {"text": text, "phon": phon, "dur": dur, "type": ntype, "pitch": pitch}


def rest(dur):
    return note("<SP>", "<SP>", dur, 1, pitch=0)


# ── load_params ──────────────────────────────────────────────────────────────────────────

check("DEFAULT_PARAMS has all frozen keys",
      set(du.DEFAULT_PARAMS) == {"version", "consonant_ms", "stress_ratio", "function_compress",
                                  "final_lengthen", "floor_ms", "floor_per_consonant_ms",
                                  "rest_steal_max_ms", "strength"})

_tmp_params_path = os.path.join(HERE, "__duration_test_params_tmp.json")
try:
    with open(_tmp_params_path, "w") as f:
        json.dump({"consonant_ms": 42.0, "unknown_future_key": 999, "provenance": {"x": 1}}, f)
    merged = du.load_params(_tmp_params_path)
    check("load_params merges a known key from file", merged["consonant_ms"] == 42.0)
    check("load_params keeps unmerged defaults", merged["stress_ratio"] == du.DEFAULT_PARAMS["stress_ratio"])
    check("load_params ignores unknown keys", "unknown_future_key" not in merged)
    check("load_params ignores provenance", "provenance" not in merged)
finally:
    if os.path.isfile(_tmp_params_path):
        os.remove(_tmp_params_path)

check("load_params(missing path) -> pure defaults",
      du.load_params("/nonexistent/path/duration_params.json") == dict(du.DEFAULT_PARAMS))

# next-to-module duration_params.json is being fitted concurrently (service/soulx/) — only
# check shape (keys present, no provenance leak), never exact values (they may change).
auto = du.load_params(None)
check("load_params(None) picks up a well-shaped dict",
      set(du.DEFAULT_PARAMS) <= set(auto) and "provenance" not in auto, str(sorted(auto)))


# ── onset_cluster cross-check vs vowel_landmark.onset_cluster ───────────────────────────

TOKENS = ["en_T-AY1-M", "en_S-T-R-EY1-N-JH", "en_F-L-IH1-P-S", "en_AH0", "en_HH-AA1-R-T", "<SP>"]
for tok in TOKENS:
    mine = du.onset_cluster(tok)
    theirs, _voiceless = vl.onset_cluster(tok)
    check(f"onset_cluster agrees with vowel_landmark: {tok}", mine == theirs, f"{mine} vs {theirs}")


# ── fixture 1: anchor pinning + function-word compression ──────────────────────────────
# "the"(function) "and"(function) "light"(anchor, cluster=['L'], budget=0.05) — one phrase,
# no rests, generous floors (empty/short clusters) so nothing clamps.
F1 = [
    note("the", "en_DH-AH0", 0.30, 2),
    note("and", "en_AH0-N-D", 0.30, 2),
    note("light", "en_L-AY1-T", 0.30, 2),
]
p1 = base_params()
new1, log1 = du.derive_note_durations(F1, p1, rest_split_s=0.35)

A_light = 0.60  # verbatim start of "light"
budget_light = p1["consonant_ms"] / 1000.0 * 1  # cluster ['L']
target_light = A_light - budget_light
cum_before_light = new1[0]["dur"] + new1[1]["dur"]
check("anchor pinning: cumulative new-duration before the anchor == A - budget",
      close(cum_before_light, target_light, 1e-9),
      f"{cum_before_light} vs {target_light}")
check("function word 'the' compresses vs verbatim", new1[0]["dur"] < F1[0]["dur"],
      f"{new1[0]['dur']} vs {F1[0]['dur']}")
check("function word 'and' compresses vs verbatim", new1[1]["dur"] < F1[1]["dur"],
      f"{new1[1]['dur']} vs {F1[1]['dur']}")
check("fixture1 zero-sum", close(sum(n["dur"] for n in new1), sum(n["dur"] for n in F1), 1e-6))


# ── fixture 2: final-word lengthening (isolated from stress_ratio/function_compress) ────
# two unstressed, non-function units, equal verbatim dur; only the LAST gets final_lengthen.
F2 = [
    note("bosh", "en_AH0-M", 0.30, 2),   # vowel-initial onset -> floor stays low
    note("dobe", "en_AH0-P", 0.30, 2),   # phrase-final
]
new2, log2 = du.derive_note_durations(F2, base_params(), rest_split_s=0.35)
check("final unit lengthens vs its non-final, equal-verbatim peer",
      new2[1]["dur"] > new2[0]["dur"], f"{new2[1]['dur']} vs {new2[0]['dur']}")
check("fixture2 zero-sum", close(sum(n["dur"] for n in new2), sum(n["dur"] for n in F2), 1e-6))


# ── fixture 3: floor clamp + proportional redistribution among the segment's other notes ─
# "an" (function, floor 0.125) would be squeezed below floor by weight alone; "zap" (final,
# non-function/non-stressed, floor 0.125) absorbs the deficit and stays above its own floor.
F3 = [
    note("an", "en_T-AH0-N", 0.20, 2),
    note("zap", "en_Z-AE0-P", 0.08, 2),
]
new3, log3 = du.derive_note_durations(F3, base_params(), rest_split_s=0.35)
floor_an = (100.0 + 25.0 * 1) / 1000.0
floor_zap = (100.0 + 25.0 * 1) / 1000.0
check("floor: 'an' clamped exactly to its floor", close(new3[0]["dur"], floor_an, 1e-6),
      str(new3[0]["dur"]))
check("floor: 'zap' absorbed the deficit and stayed above its own floor",
      new3[1]["dur"] > floor_zap - 1e-9, str(new3[1]["dur"]))
check("floor: 'zap' shrank below its naive proportional share to cover the deficit",
      new3[1]["dur"] < 0.17231, str(new3[1]["dur"]))
check("fixture3 zero-sum (span conserved even under floor redistribution)",
      close(sum(n["dur"] for n in new3), sum(n["dur"] for n in F3), 1e-6))


# ── fixture 4: melisma within-unit ratio preservation under a real resize ───────────────
# "oh"(function, 1 note) + a 3-note melisma "glo" (type2+type3+type3), all vowel-initial (no
# floor pressure); no anchors at all -> one segment, weights differ -> the melisma's TOTAL
# allocation differs from its own verbatim sum, but its internal 1:2:3 split must survive.
F4 = [
    note("oh", "en_OW0", 0.20, 2),
    note("glo", "en_OW0", 0.10, 2),
    note("glo", "en_OW0", 0.20, 3),
    note("glo", "en_OW0", 0.30, 3),
]
new4, log4 = du.derive_note_durations(F4, base_params(), rest_split_s=0.35)
melisma_total_new = sum(n["dur"] for n in new4[1:])
melisma_total_old = sum(n["dur"] for n in F4[1:])
check("melisma unit actually resized (not a no-op)", not close(melisma_total_new, melisma_total_old, 1e-4),
      f"{melisma_total_new} vs {melisma_total_old}")
r1 = new4[2]["dur"] / new4[1]["dur"]
r2 = new4[3]["dur"] / new4[1]["dur"]
check("melisma ratio 2nd/1st preserved (verbatim 2.0)", close(r1, 2.0, 1e-9), str(r1))
check("melisma ratio 3rd/1st preserved (verbatim 3.0)", close(r2, 3.0, 1e-9), str(r2))
check("fixture4 zero-sum", close(sum(n["dur"] for n in new4), sum(n["dur"] for n in F4), 1e-6))


# ── fixture 5: multi-phrase — short-rest-inside-phrase fixed, big-rest fixed except steal,
#    rest-steal amount, segment_infeasible verbatim revert, per-phrase + global zero-sum ──
# phrase1: [flame(anchor, phrase-initial, cluster FL len2)] [short rest 0.05] [burns(anchor,
#          phrase1-final, cluster B len1)] — preceded by a big leading rest (steal-eligible).
# BIG rest (0.60) between phrases.
# phrase2: [the(function, non-anchor, phrase-initial)] [short rest 0.05] [true(anchor,
#          phrase2-final, cluster TR len2)] — "the"'s segment is deliberately infeasible
#          (floor 0.125 > distributable 0.10), forcing a verbatim revert + a forced
#          onset_unbudgeted drop on 'true's onset budget.
F5 = [
    rest(0.50),
    note("flame", "en_F-L-EY1-M", 0.30, 2),
    rest(0.05),
    note("burns", "en_B-ER1-N-Z", 0.40, 2),
    rest(0.60),
    note("the", "en_DH-AH0", 0.20, 2),
    rest(0.05),
    note("true", "en_T-R-UW1", 0.35, 2),
]
new5, log5 = du.derive_note_durations(F5, base_params(), rest_split_s=0.35)

check("leading big rest shrinks by exactly the steal (phrase1's first unit is an anchor)",
      close(new5[0]["dur"], 0.50 - 0.10, 1e-9), str(new5[0]["dur"]))
check("rest-steal amount == full budget (0.10s: 2 consonants x 50ms)",
      close(log5["phrases"][0]["steal_s"], 0.10, 1e-9), str(log5["phrases"][0]["steal_s"]))
check("short rest inside phrase1 kept exactly", new5[2]["dur"] == F5[2]["dur"])
check("short rest inside phrase2 kept exactly", new5[6]["dur"] == F5[6]["dur"])
check("big rest between phrases untouched (phrase2's first unit is NOT an anchor)",
      new5[4]["dur"] == F5[4]["dur"], str(new5[4]["dur"]))

p2_flags = log5["phrases"][1]["flags"]
infeasible_flags = [fl for fl in p2_flags if fl["flag"] == "segment_infeasible"]
check("phrase2 logs segment_infeasible for 'the'", len(infeasible_flags) == 1
      and infeasible_flags[0]["units"] == ["the"], str(p2_flags))
check("'the' reverted to its verbatim duration on infeasibility",
      new5[5]["dur"] == F5[5]["dur"], str(new5[5]["dur"]))
unbudgeted_flags = [fl for fl in p2_flags
                    if fl["flag"] == "onset_unbudgeted" and fl.get("reason") == "segment_infeasible_revert"]
check("'true's onset budget forcibly dropped after the infeasible revert",
      len(unbudgeted_flags) == 1, str(p2_flags))

check("fixture5 global zero-sum", close(sum(n["dur"] for n in new5), sum(n["dur"] for n in F5), 1e-6),
      f"{sum(n['dur'] for n in new5)} vs {sum(n['dur'] for n in F5)}")


# ── fixture 6: rest-steal partial cap (rest_steal_max_ms binds below the full budget) ────
F6 = [
    rest(1.00),
    note("spark", "en_S-P-AA1-R-K", 0.30, 2),   # cluster S,P -> budget 0.10 @ default consonant_ms
]
new6, log6 = du.derive_note_durations(F6, base_params(rest_steal_max_ms=30.0), rest_split_s=0.35)
check("partial steal capped by rest_steal_max_ms", close(log6["phrases"][0]["steal_s"], 0.03, 1e-9),
      str(log6["phrases"][0]["steal_s"]))
check("rest shrinks by exactly the capped steal", close(new6[0]["dur"], 1.00 - 0.03, 1e-9),
      str(new6[0]["dur"]))
shortfall_flags = [fl for fl in log6["phrases"][0]["flags"] if fl["flag"] == "onset_unbudgeted"]
check("shortfall logged for the un-covered budget (0.10-0.03=0.07s -> 70ms)",
      len(shortfall_flags) == 1 and close(shortfall_flags[0]["shortfall_ms"], 70.0, 0.5),
      str(shortfall_flags))
check("fixture6 zero-sum", close(sum(n["dur"] for n in new6), sum(n["dur"] for n in F6), 1e-6))


# ── fixture 7: no preceding rest at all -> fully unbudgeted, clamps to phrase start ──────
F7 = [note("spark", "en_S-P-AA1-R-K", 0.30, 2)]
new7, log7 = du.derive_note_durations(F7, base_params(), rest_split_s=0.35)
check("no preceding rest -> steal is 0", log7["phrases"][0]["steal_s"] == 0.0)
sf7 = [fl for fl in log7["phrases"][0]["flags"] if fl["flag"] == "onset_unbudgeted"]
check("no preceding rest -> full shortfall logged (100ms)",
      len(sf7) == 1 and close(sf7[0]["shortfall_ms"], 100.0, 0.5), str(sf7))
check("no preceding rest -> anchor clamps to phrase start (unit unchanged: sole content)",
      close(new7[0]["dur"], F7[0]["dur"], 1e-9))


# ── strength=0.0 must be an EXACT identity (byte-equal durs) ────────────────────────────
new_id, _ = du.derive_note_durations(F5, base_params(strength=0.0), rest_split_s=0.35)
check("strength=0.0 is an exact identity", all(new_id[i]["dur"] == F5[i]["dur"] for i in range(len(F5))),
      str([n["dur"] for n in new_id]))
new_id2, _ = du.derive_note_durations(F1, base_params(strength=0.0), rest_split_s=0.35)
check("strength=0.0 identity holds on fixture1 too",
      all(new_id2[i]["dur"] == F1[i]["dur"] for i in range(len(F1))))


# ── derive_clip: parse/re-emit round-trip on a small synthetic clip ─────────────────────
def clip_from_notes(notes_list, name="test"):
    total_ms = round(sum(n["dur"] for n in notes_list) * 1000)
    return {
        "index": f"{name}_0_{total_ms}", "language": "English", "time": [0, total_ms],
        "duration": " ".join(f"{n['dur']:.4f}" for n in notes_list),
        "text": " ".join(n["text"] for n in notes_list),
        "phoneme": " ".join(n["phon"] for n in notes_list),
        "note_pitch": " ".join(str(n["pitch"]) for n in notes_list),
        "note_type": " ".join(str(n["type"]) for n in notes_list),
    }


clip5 = clip_from_notes(F5)
new_clip5, clog5 = du.derive_clip(clip5, base_params(), rest_split_s=0.35)
check("derive_clip: time unchanged", new_clip5["time"] == clip5["time"])
check("derive_clip: text byte-identical", new_clip5["text"] == clip5["text"])
check("derive_clip: phoneme byte-identical", new_clip5["phoneme"] == clip5["phoneme"])
check("derive_clip: note_pitch byte-identical", new_clip5["note_pitch"] == clip5["note_pitch"])
check("derive_clip: note_type byte-identical", new_clip5["note_type"] == clip5["note_type"])
check("derive_clip: chain check reports ok", clog5["chain_check"]["ok"], str(clog5["chain_check"]))
new_durs5 = [float(x) for x in new_clip5["duration"].split()]
check("derive_clip: sum-of-durs preserved within 0.001s",
      abs(sum(new_durs5) - sum(float(x) for x in clip5["duration"].split())) < 0.001)
check("derive_clip: at least one token actually changed",
      any(abs(new_durs5[i] - float(clip5["duration"].split()[i])) > 1e-6 for i in range(len(new_durs5))))


# ── real chunk (if present): faithfulness + non-triviality ──────────────────────────────
REAL = os.path.expanduser(
    "~/mosh-fms-ksb/used2/asserted-proof/back-half/sing-handoff/scores/u2full-c00.json")
if os.path.isfile(REAL):
    with open(REAL) as f:
        real_clip = json.load(f)[0]
    real_params = du.load_params(None)  # exercises the real, currently-being-fitted params too
    new_real, rlog = du.derive_clip(real_clip, real_params, rest_split_s=0.35)
    span = (real_clip["time"][1] - real_clip["time"][0]) / 1000.0
    check("real clip: chain-sum == time span (+/-0.005s)",
          abs(rlog["chain_check"]["chain_sum"] - span) <= 0.005, str(rlog["chain_check"]))
    check("real clip: text byte-identical", new_real["text"] == real_clip["text"])
    check("real clip: phoneme byte-identical", new_real["phoneme"] == real_clip["phoneme"])
    check("real clip: note_pitch byte-identical", new_real["note_pitch"] == real_clip["note_pitch"])
    check("real clip: note_type byte-identical", new_real["note_type"] == real_clip["note_type"])
    orig_durs = [float(x) for x in real_clip["duration"].split()]
    real_new_durs = [float(x) for x in new_real["duration"].split()]
    check("real clip: sum-of-durs preserved within 0.001s",
          abs(sum(real_new_durs) - sum(orig_durs)) < 0.001,
          f"{sum(real_new_durs)} vs {sum(orig_durs)}")
    n_changed = sum(1 for a, b in zip(orig_durs, real_new_durs) if abs(a - b) > 1e-6)
    check("real clip: at least one unit actually changed", n_changed >= 1, f"n_changed={n_changed}")
    max_delta_ms = max(abs(a - b) for a, b in zip(orig_durs, real_new_durs)) * 1000
    print(f"  [info] real clip u2full-c00: {len(orig_durs)} tokens, {n_changed} changed, "
          f"max |delta| = {max_delta_ms:.1f}ms, chain_sum={rlog['chain_check']['chain_sum']}s "
          f"vs span={span}s")

    # 3x determinism on the real clip (direct output equality, not a hash — keeps the
    # strict digest below environment-independent).
    reruns = [du.derive_clip(real_clip, real_params, rest_split_s=0.35)[0]["duration"] for _ in range(3)]
    check("real clip: 3x deterministic", len(set(reruns)) == 1, str(set(reruns)))
else:
    print("[skip] real u2full-c00.json not present — synthetic checks only")


# ── determinism (3x), fully synthetic/environment-independent ───────────────────────────
def digest():
    n5, l5 = du.derive_note_durations(F5, base_params(), rest_split_s=0.35)
    payload = {"durs": [round(n["dur"], 9) for n in n5], "log": l5}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


d = {digest() for _ in range(3)}
check("3x deterministic (synthetic fixture 5)", len(d) == 1, str(d))


if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
