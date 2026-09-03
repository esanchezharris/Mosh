#!/usr/bin/env python3
"""Golden test for the AUC-table builder (charter Q1 — "the single most informative
artifact"). Hermetic: synthetic session dir, hermetic families only (audiobox + fake).

Proves: census -> usable-label filter (organic, non-contradicted, audio on disk) ->
per-family probe -> one table, with honest per-family statuses. A family that cannot
be scored NEVER shows a number.

Run:  python3 service/taste/taste_table_test.py   (exit 0 = pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from taste import build_table  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _log_line(ts, seq, command, args):
    return json.dumps({"ts": ts, "seq": seq, "command": command, "args": args,
                       "ok": True, "undoable": True})


with tempfile.TemporaryDirectory() as td:
    os.makedirs(os.path.join(td, "renders"), exist_ok=True)
    boots, renders = [], []
    # 16 organic accepts with high CE, 16 organic rejects with low CE — one listen->label
    # boot per render. BOTH verdicts carry their own layerId (matching the native
    # accept_render / reject_render handlers), so both classes join audio + axes and the
    # probe sees a real two-class problem.
    t = 1_780_000_000_000
    for i in range(32):
        verdict = "accept" if i % 2 == 0 else "reject"
        layer = f"rl-{i}"
        clip = str(100 + i)
        # Vary each boot's shape (distinct scrub counts) — real organic sessions
        # never share an exact command signature; any shape repeated 3x would
        # (correctly) trip the replay detector, so keep every (verdict, shape)
        # pair at <= 2 occurrences.
        boot = [
            _log_line(t, 1, "enable_all_meters", {}),
            _log_line(t + 100, 2, "render_layer", {"clipId": clip}),
        ]
        seq = 3
        for k in range(1 + (i // 2) % 8):
            boot.append(_log_line(t + 2000 + 300 * k, seq, "set_transport",
                                  {"position": float(k)}))
            seq += 1
        boot.append(
            _log_line(t + 9000, seq, "accept_render",
                      {"clipId": clip, "layerId": layer, "landing": "new_clip"})
            if verdict == "accept" else
            _log_line(t + 9000, seq, "reject_render",
                      {"clipId": clip, "layerId": layer, "cacheKey": f"ck-{i}",
                       "adapter": "stable_audio3"}))
        boots.append(boot)
        ce = 6.0 + 0.05 * i if verdict == "accept" else 3.0 + 0.05 * i
        d = os.path.join(td, "renders", layer)
        os.makedirs(d)
        json.dump({"ok": True, "adapter": "stable_audio3", "pq": 6.0,
                   "axes": {"CE": ce, "CU": 5.0, "PC": 2.0, "PQ": 6.0}},
                  open(os.path.join(d, "output_manifest.json"), "w"))
        open(os.path.join(d, "output.wav"), "wb").write(
            b"RIFF0000WAVE" + bytes([i]) * 32)
        renders.append(layer)
        t += 60_000

    with open(os.path.join(td, "mosh-log.jsonl"), "w") as f:
        for boot in boots:
            for ln in boot:
                f.write(ln + "\n")

    report = build_table.build_report(td, families=("audiobox", "fake"))

    check("census embedded in the report", report["census"]["labels_total"] == 32)
    fam = {r["family"]: r for r in report["families"]}
    check("both families present", set(fam) == {"audiobox", "fake"})

    ab = fam["audiobox"]
    # Both verdicts join audio+axes now that the reject label carries its own layerId, and
    # CE separates the classes by construction -> the ok path, with a real AUC. Before the
    # join-key fix the rejects could not join at all and this family was single-class.
    check("audiobox: both classes join -> ok status with an AUC",
          ab["status"] == "ok" and ab["auc"] is not None and ab["n"] == 32,
          json.dumps(ab))
    check("audiobox: separable synthetic archive scores AUC 1.0",
          ab["auc"] == 1.0, json.dumps(ab))

    md = build_table.render_markdown(report)
    check("markdown has the table header",
          "| family |" in md and "| audiobox |" in md and "| fake |" in md)

    # Determinism.
    r2 = build_table.build_report(td, families=("audiobox", "fake"))
    check("build_report deterministic",
          json.dumps(report, sort_keys=True) == json.dumps(r2, sort_keys=True))


# The honesty contract, on its own archive: a single-class archive (accepts only, the
# shape a producer who never rejects actually produces) NEVER gets a number. This used to
# ride on the main archive's unjoinable rejects; with the join-key fix that archive is
# two-class, so the case gets its own fixture rather than quietly losing coverage.
with tempfile.TemporaryDirectory() as td_one:
    os.makedirs(os.path.join(td_one, "renders"), exist_ok=True)
    one_boots = []
    t = 1_780_000_000_000
    for i in range(8):
        layer, clip = f"only-{i}", str(200 + i)
        boot = [_log_line(t, 1, "enable_all_meters", {}),
                _log_line(t + 100, 2, "render_layer", {"clipId": clip})]
        seq = 3
        for k in range(1 + i % 4):
            boot.append(_log_line(t + 2000 + 300 * k, seq, "set_transport",
                                  {"position": float(k)}))
            seq += 1
        boot.append(_log_line(t + 9000, seq, "accept_render",
                              {"clipId": clip, "layerId": layer, "landing": "new_clip"}))
        one_boots.append(boot)
        d = os.path.join(td_one, "renders", layer)
        os.makedirs(d)
        json.dump({"ok": True, "adapter": "stable_audio3", "pq": 6.0,
                   "axes": {"CE": 6.0 + 0.05 * i, "CU": 5.0, "PC": 2.0, "PQ": 6.0}},
                  open(os.path.join(d, "output_manifest.json"), "w"))
        open(os.path.join(d, "output.wav"), "wb").write(b"RIFF0000WAVE" + bytes([i]) * 32)
        t += 60_000
    with open(os.path.join(td_one, "mosh-log.jsonl"), "w") as f:
        for boot in one_boots:
            for ln in boot:
                f.write(ln + "\n")
    one = build_table.build_report(td_one, families=("audiobox",))
    ab1 = one["families"][0]
    check("accepts-only archive -> insufficient_labels, no AUC",
          ab1["status"] == "insufficient_labels" and ab1["auc"] is None, json.dumps(ab1))
    check("markdown never renders a fake number for an unscored family",
          "insufficient_labels" in build_table.render_markdown(one))

# A separable archive where BOTH classes join audio+axes: accept and reject rows
# built directly (unit-level entry) — proves the ok-path renders an AUC.
rows_by_family = {"audiobox": [
    {"ts": 1000 + i, "y": i % 2, "x": [5.0 + (1.0 if i % 2 else -1.0), 5.0, 2.0, 6.0]}
    for i in range(32)
]}
scored = build_table.score_families(rows_by_family)
check("ok-path: separable family reports AUC 1.0 and clears the trust bar",
      scored[0]["status"] == "ok" and scored[0]["auc"] == 1.0
      and scored[0]["clears_trust_bar"] is True, json.dumps(scored))
md2 = build_table.render_markdown({"census": {}, "families": scored,
                                   "session_dir": "x", "eval_frac": 0.25})
check("ok-path markdown carries the AUC", "1.0" in md2)

print()
if fails:
    print(f"FAILED: {len(fails)} — {fails}")
    sys.exit(1)
print("taste_table_test: ALL PASS")
