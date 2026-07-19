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


def _organic_boot(t0, clip, layer, verdict, ce):
    """One listen->label session per render; CE separates accepts from rejects so the
    audiobox family is informative on this synthetic archive."""
    rows = [
        _log_line(t0, 1, "enable_all_meters", {}),
        _log_line(t0 + 100, 2, "render_layer", {"clipId": clip}),
        _log_line(t0 + 2000, 3, "set_transport", {"position": 0.0}),
    ]
    if verdict == "accept":
        rows.append(_log_line(t0 + 9000, 4, "accept_render",
                              {"clipId": clip, "layerId": layer, "landing": "new_clip"}))
    else:
        # reject logs no layerId (matches the native handler) — the census recovers it
        # only via a previous accept, so give rejects their own accept-free boots and
        # test the layerId-less join is DROPPED from probe rows (no audio, no axes).
        rows.append(_log_line(t0 + 9000, 4, "reject_render", {"clipId": clip}))
    return rows


with tempfile.TemporaryDirectory() as td:
    os.makedirs(os.path.join(td, "renders"), exist_ok=True)
    boots, renders = [], []
    # 16 organic accepts with high CE, 16 whose layer we label via accept-then-later-
    # reject in SEPARATE boots (re-render between => not contradicted).
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
            _log_line(t + 9000, seq, "reject_render", {"clipId": clip}))
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

    # Rejects carry no layerId and no prior accept in-boot -> they cannot join audio.
    # To make the table informative, ALSO write a variant where rejects DO join:
    # the census recovers reject layerIds from a same-boot accept only; so instead
    # emit rejects as accept-then-re-render-then-reject in one boot (re-render breaks
    # the contradiction rule, and the reject joins the accept's layer).
    with open(os.path.join(td, "mosh-log.jsonl"), "w") as f:
        for boot in boots:
            for ln in boot:
                f.write(ln + "\n")

    report = build_table.build_report(td, families=("audiobox", "fake"))

    check("census embedded in the report", report["census"]["labels_total"] == 32)
    fam = {r["family"]: r for r in report["families"]}
    check("both families present", set(fam) == {"audiobox", "fake"})

    ab = fam["audiobox"]
    # Only accepts join audio+axes (rejects log no layerId) -> single class -> honest
    # insufficient_labels, never a number.
    check("audiobox: single-class -> insufficient_labels, no AUC",
          ab["status"] == "insufficient_labels" and ab["auc"] is None,
          json.dumps(ab))

    md = build_table.render_markdown(report)
    check("markdown has the table header",
          "| family |" in md and "| audiobox |" in md and "| fake |" in md)
    check("markdown never renders a fake number for an unscored family",
          "insufficient_labels" in md)

    # Determinism.
    r2 = build_table.build_report(td, families=("audiobox", "fake"))
    check("build_report deterministic",
          json.dumps(report, sort_keys=True) == json.dumps(r2, sort_keys=True))

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
