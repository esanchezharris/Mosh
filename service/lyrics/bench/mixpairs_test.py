#!/usr/bin/env python3
"""Golden tests for mixed calibration pairs + full-stanza context (I2b).

Sitting 1 failed two ways the owner caught by ear: every pair came from one
song, and 94% of his calls were "the human bar is better" — labels so one-sided
that a column saying "human" forever scored 0.96. The redo therefore mints TWO
kinds of pair:
  * vs_truth — the ceiling check (machine fill vs the real recorded bar);
  * vs_arm   — arm against arm, which is balanced by construction AND is
               literally the promotion question.
Both normalize to one binary label so the existing agreement stats still apply.

Run:  python3 service/lyrics/bench/mixpairs_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import mixpairs  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def row(item, arm, cand, metrics=None):
    return {"itemId": item, "granularity": "line", "arm": arm,
            "truth": f"human bar for {item}", "candidate": cand,
            "maskedLine": None, "songId": item.split(":")[2] + ":" + item.split(":")[3],
            "context": {"before": ["b1", "b2"], "after": ["a1"]},
            "metrics": metrics or {"judge_win": 0, "emb": 0.5, "ppl": 0.2}}


POOL = []
for n in range(12):
    it = f"v1:line:gd:{n:03}:s0:l4"
    POOL.append(row(it, "arm-a", f"arm-a fill {n}",
                    {"judge_win": 1, "emb": 0.8, "ppl": -0.1}))
    POOL.append(row(it, "arm-b", f"arm-b fill {n}",
                    {"judge_win": 0, "emb": 0.3, "ppl": 0.9}))

pairs, key = mixpairs.mint_mixed(POOL, n=12, dupes=0, seed=7, arm_frac=0.5)

kinds = {}
for v in key.values():
    kinds[v["kind"]] = kinds.get(v["kind"], 0) + 1
check("mints both kinds at roughly the requested split",
      kinds.get("vs_arm", 0) >= 4 and kinds.get("vs_truth", 0) >= 4, str(kinds))
check("every pair renders two distinct texts",
      all(p["left"] != p["right"] for p in pairs))
check("pairs still leak nothing about which side is which",
      not any(k in p for p in pairs for k in
              ("truth", "candidate", "kind", "truthSide", "armLeft", "winnerArm")),
      str(sorted(pairs[0].keys())))

arm_keys = [v for v in key.values() if v["kind"] == "vs_arm"]
check("vs_arm entries name both arms and the canonical option",
      all(set(v) >= {"armLeft", "armRight", "optionArm"} for v in arm_keys))
check("vs_arm compares the SAME item's two fills",
      all(v["armLeft"] != v["armRight"] for v in arm_keys))
check("canonical option is the alphabetically-first arm (stable across pairs)",
      all(v["optionArm"] == min(v["armLeft"], v["armRight"]) for v in arm_keys))
truth_keys = [v for v in key.values() if v["kind"] == "vs_truth"]
check("vs_truth entries still name the truth side",
      all(v["truthSide"] in ("left", "right") for v in truth_keys))
check("both orders occur across the sitting",
      len({v.get("truthSide") for v in truth_keys}) == 2
      or len(truth_keys) < 3,
      # sorted: a bare set's repr order follows PYTHONHASHSEED, which makes the
      # suite's 3x-determinism signature differ run to run for no real reason.
      str(sorted({v.get("truthSide") for v in truth_keys})))

# ---- labels: one binary convention for both kinds -----------------------------
sample_arm = next(p for p in key.items() if p[1]["kind"] == "vs_arm")
pid_arm, k_arm = sample_arm
opt_side = "left" if k_arm["armLeft"] == k_arm["optionArm"] else "right"
labels = mixpairs.owner_labels([{"pairId": pid_arm, "choice": opt_side}], key)
check("vs_arm: choosing the canonical arm labels 1", labels[pid_arm] == 1, str(labels))
other = "right" if opt_side == "left" else "left"
check("vs_arm: choosing the other arm labels 0",
      mixpairs.owner_labels([{"pairId": pid_arm, "choice": other}], key)[pid_arm] == 0)
pid_t, k_t = next(p for p in key.items() if p[1]["kind"] == "vs_truth")
cand_side = "right" if k_t["truthSide"] == "left" else "left"
check("vs_truth: choosing the machine fill labels 1",
      mixpairs.owner_labels([{"pairId": pid_t, "choice": cand_side}], key)[pid_t] == 1)
check("vs_truth: choosing the human bar labels 0",
      mixpairs.owner_labels([{"pairId": pid_t, "choice": k_t["truthSide"]}],
                            key)[pid_t] == 0)
check("tie labels None for both kinds",
      mixpairs.owner_labels([{"pairId": pid_arm, "choice": "tie"},
                             {"pairId": pid_t, "choice": "tie"}], key)
      == {pid_arm: None, pid_t: None})

# ---- machine columns must predict on the SAME binary convention ---------------
machine = {f"{r['itemId']}|{r['arm']}": r["metrics"] for r in POOL}
preds = mixpairs.column_predictions(key, machine, "emb")
check("emb on vs_arm: predicts 1 when the canonical arm scores higher",
      all(preds[p] == 1 for p, v in key.items()
          if v["kind"] == "vs_arm" and v["optionArm"] == "arm-a"),
      str({p: preds[p] for p in list(preds)[:3]}))
ppl_preds = mixpairs.column_predictions(key, machine, "ppl")
check("ppl on vs_arm: LOWER is better, so the sign is inverted",
      all(ppl_preds[p] == 1 for p, v in key.items()
          if v["kind"] == "vs_arm" and v["optionArm"] == "arm-a"))
jw = mixpairs.column_predictions(key, machine, "judge_win")
check("judge_win on vs_truth: passes the per-arm verdict straight through",
      all(jw[p] == machine[f"{v['itemId']}|{v['arm']}"]["judge_win"]
          for p, v in key.items() if v["kind"] == "vs_truth"))
tied = {f"{r['itemId']}|{r['arm']}": {"judge_win": 1} for r in POOL}
check("a column that ties both arms abstains on vs_arm (no coin flip)",
      all(mixpairs.column_predictions(key, tied, "judge_win").get(p) is None
          for p, v in key.items() if v["kind"] == "vs_arm"))

# ---- full-stanza context ------------------------------------------------------
songs = {"gd:001": {"songId": "gd:001", "sections": [
    {"kind": "verse", "label": "Verse 1",
     "lines": [f"stanza line {i}" for i in range(8)]}]}}
ctx = mixpairs.stanza_context("v1:line:gd:001:s0:l4", songs, radius=99)
check("stanza context returns the whole section around the gap",
      ctx["before"] == [f"stanza line {i}" for i in range(4)]
      and ctx["after"] == [f"stanza line {i}" for i in range(5, 8)], str(ctx))
check("stanza context is bounded by the section, not the song",
      mixpairs.stanza_context("v1:line:gd:001:s0:l0", songs, radius=99)["before"] == [])
check("unknown song degrades to empty context rather than raising",
      mixpairs.stanza_context("v1:line:gd:999:s0:l0", songs) == {"before": [],
                                                                 "after": []})

# ---- disagreement weighting: the audit's efficiency finding --------------------
# Measured on the real sitting: 54% of pairs had every metric agreeing, so the
# label only re-confirmed the base rate. Pairs where the columns DISAGREE are
# the ones that separate one judge from another.
COLS = {"judge_win": {}, "emb": {}}
for n, it in enumerate(sorted({r["itemId"] for r in POOL})):
    COLS["judge_win"][it] = 1
    COLS["emb"][it] = 1 if n % 4 == 0 else 0        # disagrees on 1 in 4
ranked = mixpairs.rank_by_disagreement(sorted({r["itemId"] for r in POOL}), COLS)
# judge_win is 1 everywhere, so the DISAGREEING items are the emb==0 ones.
check("items where the metrics disagree rank first",
      all(COLS["emb"][i] == 0 for i in ranked[:3])
      and COLS["emb"][ranked[-1]] == 1, str(ranked[:3]))
check("ranking is total and deterministic",
      len(ranked) == len({r["itemId"] for r in POOL})
      and ranked == mixpairs.rank_by_disagreement(
          sorted({r["itemId"] for r in POOL}), COLS))
picked, key_d = mixpairs.mint_mixed(POOL, n=6, dupes=0, seed=3, arm_frac=0.5,
                                    columns=COLS, anchor_frac=0.34)
kinds = [v.get("selection") for v in key_d.values()]
check("a random ANCHOR stratum is kept so absolute accuracy stays unbiased",
      "anchor" in kinds and "disagreement" in kinds, str(kinds))
check("most of the budget goes to discriminating pairs",
      kinds.count("disagreement") > kinds.count("anchor"), str(kinds))

check("determinism: 3x identical mint",
      all(mixpairs.mint_mixed(POOL, n=12, dupes=0, seed=7, arm_frac=0.5)[0] == pairs
          for _ in range(3)))

# The anchor stratum is what makes the CEILING ("how often does the real bar
# itself read as keep?") an unbiased estimate — so it has to contain vs_truth
# pairs. The first cut allocated arm-vs-arm pairs from the front of the ordered
# item list, which is exactly where the anchors sit: it consumed every anchor and
# left the ceiling with a sample size of zero.
_, key_s = mixpairs.mint_mixed(POOL, n=8, dupes=0, seed=4, arm_frac=0.5,
                               columns=COLS, anchor_frac=0.5)
strata = {}
for v in key_s.values():
    strata.setdefault(v.get("selection"), set()).add(v["kind"])
check("the ANCHOR stratum spans both pair kinds (the ceiling needs vs_truth)",
      strata.get("anchor", set()) == {"vs_arm", "vs_truth"}, str(strata))
check("the disagreement stratum still spans both kinds too",
      strata.get("disagreement", set()) == {"vs_arm", "vs_truth"}, str(strata))

# ---- I2c: un-blinded song identity -------------------------------------------
# The owner stopped sitting 3 because flow is unjudgeable on the page: syllable
# counts are not cadence. He has to be able to pull the track up. Blinding is
# unenforceable anyway once he presses play — so identity is shown and RECORDED,
# never left to leak silently.
SONGS = {f"gd:{n:03}": {"songId": f"gd:{n:03}", "artist": f"Artist {n}",
                        "title": f"Song {n}", "year": 2020 + (n % 6),
                        "sections": [{"kind": "verse", "label": "Verse 2",
                                      "lines": [f"stanza line {i}"
                                                for i in range(9)]}]}
         for n in range(12)}
ip, ik = mixpairs.mint_mixed(POOL, n=12, dupes=0, seed=11, arm_frac=0.5,
                             songs=SONGS, blind_frac=0.25)
shown = [p for p in ip if not p.get("identityHidden")]
hidden = [p for p in ip if p.get("identityHidden")]
check("shown pairs carry artist / title / year / section",
      shown and all(set(p) >= {"artist", "title", "year", "section"}
                    for p in shown), str(sorted(shown[0].keys())) if shown else "")
check("identity is read from the song record, not invented",
      all(p["artist"] == SONGS[ik[p["pairId"]]["itemId"].split(":")[2] + ":"
                               + ik[p["pairId"]]["itemId"].split(":")[3]]["artist"]
          for p in shown))
check("shown pairs carry a listen link to that track",
      all(p.get("listenUrl", "").startswith("http") for p in shown)
      and "Artist" in shown[0]["listenUrl"])
check("the section label comes from the section the gap is in",
      all(p["section"] == "Verse 2" for p in shown))

# The control stratum: identity WITHHELD, so we can tell "the judges are bad"
# apart from "we moved the ruler" when the report is read.
check("a control stratum keeps its identity hidden",
      2 <= len(hidden) <= 5, f"{len(hidden)} hidden of {len(ip)}")
check("hidden pairs carry NO identity fields at all (not merely a flag)",
      all(not any(k in p for k in ("artist", "title", "listenUrl", "section"))
          for p in hidden), str(sorted(hidden[0].keys())) if hidden else "")
check("the hidden subset is stratified across pair kinds",
      len({ik[p["pairId"]]["kind"] for p in hidden}) == 2
      or len(hidden) < 2, str([ik[p["pairId"]]["kind"] for p in hidden]))
check("the hidden subset is deterministic",
      [p["pairId"] for p in mixpairs.mint_mixed(
          POOL, n=12, dupes=0, seed=11, arm_frac=0.5, songs=SONGS,
          blind_frac=0.25)[0] if p.get("identityHidden")]
      == [p["pairId"] for p in hidden])
check("identity still never reveals WHICH fill is the human's",
      not any(k in p for p in ip
              for k in ("truthSide", "truthText", "kind", "armLeft")),
      str(sorted(ip[0].keys())))
check("the key records identity for the report even when the page hides it",
      all(set(ik[p["pairId"]]) >= {"artist", "title", "identityHidden"}
          for p in ip))

# ---- I2c: per-fill acceptability ratings --------------------------------------
# The instrument changed from "pick the better bar" to "rate each bar" — the
# owner's point being that real-vs-generated is not a head-to-head. Rating BOTH
# sides keeps the pairwise label derivable, so elect()/kappa still work.
pid_a = next(p for p, v in ik.items() if v["kind"] == "vs_arm")
pid_t2 = next(p for p, v in ik.items() if v["kind"] == "vs_truth")
opt2 = "left" if ik[pid_a]["armLeft"] == ik[pid_a]["optionArm"] else "right"
oth2 = "right" if opt2 == "left" else "left"


def rate(pid, left, right, **kw):
    return [{"pairId": pid, "side": "left", "rating": left, **kw},
            {"pairId": pid, "side": "right", "rating": right, **kw}]


rr = mixpairs.owner_ratings(rate(pid_a, "keep", "no"), ik)
check("owner_ratings returns the per-side rating for a pair",
      rr[pid_a]["left"] == "keep" and rr[pid_a]["right"] == "no", str(rr))
check("vs_arm: the better-rated arm decides the binary label",
      mixpairs.owner_labels(
          rate(pid_a, *(("keep", "no") if opt2 == "left" else ("no", "keep"))),
          ik)[pid_a] == 1)
check("vs_arm: the other arm rated higher labels 0",
      mixpairs.owner_labels(
          rate(pid_a, *(("no", "keep") if opt2 == "left" else ("keep", "no"))),
          ik)[pid_a] == 0)
check("passable still ranks below keep and above no",
      mixpairs.owner_labels(rate(pid_a, "keep", "passable"), ik)[pid_a]
      == (1 if opt2 == "left" else 0))
tside = ik[pid_t2]["truthSide"]
check("vs_truth: the machine fill rated higher labels 1",
      mixpairs.owner_labels(
          rate(pid_t2, *(("no", "keep") if tside == "left" else ("keep", "no"))),
          ik)[pid_t2] == 1)
check("vs_truth: the human bar rated higher labels 0",
      mixpairs.owner_labels(
          rate(pid_t2, *(("keep", "no") if tside == "left" else ("no", "keep"))),
          ik)[pid_t2] == 0)
check("EQUAL ratings are a genuine tie, not a coin flip",
      mixpairs.owner_labels(rate(pid_a, "keep", "keep"), ik)[pid_a] is None
      and mixpairs.owner_labels(rate(pid_t2, "no", "no"), ik)[pid_t2] is None)
check("a half-rated pair yields no label",
      mixpairs.owner_labels([{"pairId": pid_a, "side": "left",
                              "rating": "keep"}], ik).get(pid_a) is None)
check("whether the owner PLAYED the track is recorded per pair",
      mixpairs.owner_ratings(rate(pid_a, "keep", "no", heard=True),
                             ik)[pid_a]["heard"] is True
      and mixpairs.owner_ratings(rate(pid_a, "keep", "no"),
                                 ik)[pid_a]["heard"] is False)
# A dupe rated differently is the self-consistency probe and must stay ambiguous;
# a deliberate correction after arrowing back is flagged and the latest wins.
check("an UNFLAGGED contradictory repeat resolves to None (dupe probe intact)",
      mixpairs.owner_ratings(rate(pid_a, "keep", "no")
                             + rate(pid_a, "no", "keep"), ik)[pid_a]["left"]
      is None)
check("a FLAGGED revision takes the latest, so arrowing back is not punished",
      mixpairs.owner_ratings(rate(pid_a, "keep", "no")
                             + rate(pid_a, "no", "keep", revision=True),
                             ik)[pid_a]["left"] == "no")
check("junk ratings are ignored rather than scored",
      mixpairs.owner_ratings([{"pairId": pid_a, "side": "left",
                               "rating": "amazing"}], ik).get(pid_a, {})
      .get("left") is None)
check("the old forced-choice rows still resolve (no silent reinterpretation)",
      mixpairs.owner_labels([{"pairId": pid_a, "choice": opt2}], ik)[pid_a] == 1
      and mixpairs.owner_labels([{"pairId": pid_a, "choice": oth2}],
                                ik)[pid_a] == 0)
check("mixing the two instruments on ONE pair refuses to produce a label",
      mixpairs.owner_labels(rate(pid_a, "keep", "no")
                            + [{"pairId": pid_a, "choice": oth2}],
                            ik)[pid_a] is None)

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
