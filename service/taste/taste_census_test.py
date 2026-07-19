#!/usr/bin/env python3
"""Golden tests for the taste-label census (workshop charter 2026-07-19, week-1 Q1/Q3).

The census reads a session dir's mosh-log.jsonl + renders/<layerId>/ artifacts and answers,
deterministically: how many accept/reject taste labels exist, which are ORGANIC (a human
listening) vs SCRIPTED-HARNESS replay (the verify/demo scripts that hit the real
~/Library/Mosh — see the "JUCE ignores $HOME" gotcha), which are CONTRADICTED (the same
boot stamps accept AND reject on one clip with no re-render between — the label carries no
preference information), and which labels still join to an on-disk render (wav + manifest).

Pure stdlib, no audio decoding. Run:  python3 service/taste/taste_census_test.py  (exit 0 = pass).
Run three times — output must be byte-identical (asserted by the gate convention).
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from taste import census  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _line(ts, seq, command, args, ok=True, undoable=True):
    return json.dumps({"ts": ts, "seq": seq, "command": command, "args": args,
                       "ok": ok, "undoable": undoable})


# The exact 7-command harness replay observed in the real archive (06-11..06-13):
# create_track, import_clip, create_render_layer, set_render_param, render_layer,
# accept_render, reject_render — accept AND reject on the same clip, seconds apart.
def _scripted_boot(t0, layer_id):
    return [
        _line(t0 + 0, 1, "create_track", {"name": "t"}),
        _line(t0 + 100, 2, "import_clip", {"path": "/x.wav"}),
        _line(t0 + 200, 3, "create_render_layer", {"clipId": "1023"}),
        _line(t0 + 300, 4, "set_render_param", {"clipId": "1023", "grit": 40}),
        _line(t0 + 400, 5, "render_layer", {"clipId": "1023"}),
        _line(t0 + 8000, 6, "accept_render",
              {"clipId": "1023", "layerId": layer_id, "landing": "new_clip"}),
        _line(t0 + 9500, 7, "reject_render", {"clipId": "1023"}),
    ]


# An organic session: UI init (enable_all_meters), param fiddling, a render, transport
# scrubbing (LISTENING), then one accept. No contradiction.
def _organic_boot(t0, layer_id):
    rows = [
        _line(t0 + 0, 1, "enable_all_meters", {}),
        _line(t0 + 500, 2, "set_render_param", {"clipId": "77", "grit": 25}),
        _line(t0 + 900, 3, "set_render_param", {"clipId": "77", "grit": 35}),
        _line(t0 + 1200, 4, "render_layer", {"clipId": "77"}),
    ]
    seq = 5
    for i in range(8):
        rows.append(_line(t0 + 2000 + i * 700, seq, "set_transport",
                          {"position": i * 1.5}, undoable=False))
        seq += 1
    rows.append(_line(t0 + 9000, seq, "accept_render",
                      {"clipId": "77", "layerId": layer_id, "landing": "new_clip"}))
    return rows


def _write_session(root, boots, renders):
    os.makedirs(os.path.join(root, "renders"), exist_ok=True)
    with open(os.path.join(root, "mosh-log.jsonl"), "w") as f:
        for boot in boots:
            for ln in boot:
                f.write(ln + "\n")
    for layer_id, manifest, with_wav in renders:
        d = os.path.join(root, "renders", layer_id)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "output_manifest.json"), "w") as f:
            json.dump(manifest, f)
        if with_wav:
            with open(os.path.join(d, "output.wav"), "wb") as f:
                f.write(b"RIFF0000WAVE")


with tempfile.TemporaryDirectory() as td:
    _write_session(
        td,
        boots=[
            _scripted_boot(1_781_224_000_000, "rl-a"),
            _scripted_boot(1_781_225_000_000, "rl-b"),
            _organic_boot(1_782_781_000_000, "rl-real"),
        ],
        renders=[
            ("rl-a", {"ok": True, "adapter": "fake", "pq": 0.752}, True),
            ("rl-b", {"ok": True, "adapter": "fake", "pq": 0.752}, True),
            ("rl-real", {"ok": True, "adapter": "stable_audio3", "pq": 5.87,
                         "axes": {"CE": 4.9, "CU": 5.5, "PC": 2.1, "PQ": 5.87}}, True),
        ],
    )

    boots = census.parse_boots(os.path.join(td, "mosh-log.jsonl"))
    check("parse_boots splits on seq reset", len(boots) == 3, f"got {len(boots)}")

    labels = census.label_rows(boots)
    check("finds all 5 label events", len(labels) == 5, f"got {len(labels)}")

    scripted = [r for r in labels if r["scripted"]]
    organic = [r for r in labels if not r["scripted"]]
    check("scripted-harness boots flagged", len(scripted) == 4,
          f"got {len(scripted)}")
    check("organic accept survives", len(organic) == 1
          and organic[0]["verdict"] == "accept" and organic[0]["layerId"] == "rl-real")

    contradicted = [r for r in labels if r["contradicted"]]
    check("accept+reject same clip, no re-render between = contradicted",
          len(contradicted) == 4, f"got {len(contradicted)}")

    joined = census.join_renders(td, labels)
    with_audio = [r for r in joined if r["wav"] is not None]
    check("labels join to on-disk renders", len(with_audio) == 5)
    real_axes = [r for r in joined if r.get("axes")]
    check("audiobox axes surface from the manifest", len(real_axes) == 1
          and abs(real_axes[0]["axes"]["CE"] - 4.9) < 1e-9)

    summary = census.summarize(td)
    check("summary: organic accept/reject counts", summary["organic_accepts"] == 1
          and summary["organic_rejects"] == 0, json.dumps(summary, sort_keys=True))
    check("summary: scripted label count", summary["scripted_labels"] == 4)
    check("summary: renders with axes", summary["renders_with_axes"] == 1)

    # Undo-mining census (charter Q3): undos within the window after a render-ish
    # command are candidate implicit negatives.
    boots2 = [[
        json.loads(_line(1_782_000_000_000, 1, "render_layer", {"clipId": "9"})),
        json.loads(_line(1_782_000_005_000, 2, "undo", {}, undoable=False)),
        json.loads(_line(1_782_000_900_000, 3, "move_clip", {"clipId": "9"})),
        json.loads(_line(1_782_000_905_000, 4, "undo", {}, undoable=False)),
    ]]
    u = census.undo_stats(boots2, window_ms=30_000)
    check("undo_stats counts undos + attributes the preceding command",
          u["undos"] == 2 and u["after"]["render_layer"] == 1
          and u["after"]["move_clip"] == 1, json.dumps(u, sort_keys=True))

    # REPLAY detection: the real archive is full of demo/verify scripts replayed
    # dozens of times against the real ~/Library/Mosh (each boot the same command
    # sequence, only timing varies). Identical command-signature repeated >= 3x
    # marks every such boot a replay; implicit-label mining must exclude them.
    def _mk(t0):
        return [json.loads(_line(t0 + i * 1000, i + 1, c, {"clipId": "5"},
                                 undoable=(c != "undo")))
                for i, c in enumerate(
                    ["create_track", "move_clip", "undo", "move_clip", "undo"])]
    replayed = [_mk(1_790_000_000_000), _mk(1_790_001_000_000), _mk(1_790_002_000_000)]
    unique = [[json.loads(_line(1_790_003_000_000, 1, "enable_all_meters", {})),
               json.loads(_line(1_790_003_001_000, 2, "move_clip", {"clipId": "8"})),
               json.loads(_line(1_790_003_002_000, 3, "undo", {}, undoable=False))]]
    flags = census.replay_flags(replayed + unique)
    check("replay_flags marks 3x-identical boots, spares the unique one",
          flags == [True, True, True, False], str(flags))
    u_all = census.undo_stats(replayed + unique)
    check("undo_stats splits organic vs replay undos",
          u_all["undos"] == 7 and u_all["organic_undos"] == 1
          and u_all["organic_after"] == {"move_clip": 1},
          json.dumps(u_all, sort_keys=True))

    # Determinism: summarize twice — byte-identical JSON.
    s1 = json.dumps(census.summarize(td), sort_keys=True)
    s2 = json.dumps(census.summarize(td), sort_keys=True)
    check("summarize deterministic", s1 == s2)


# ── TASTE-002: the native spigot lines. PR #185's in-place overhaul removed
# accept/reject from the wave loop; the restored spigot logs reset_render_layer as an
# explicit NEGATIVE (with layerId/cacheKey/adapter join keys) and render_kept as a
# save/export-time soft POSITIVE. The census must parse both, grade polarity, and let
# an EXPLICIT label supersede the implicit soft positive within the same
# no-re-render segment.
def _inplace_boot(t0):
    """An organic in-place session: two clips render + auto-apply; a save logs
    render_kept for both; clip 88 is then reset (explicit negative) with no re-render
    between — its kept row is superseded. Clip 77's kept row survives."""
    rows = [
        _line(t0 + 0, 1, "enable_all_meters", {}),
        _line(t0 + 500, 2, "render_layer", {"clipId": "77"}),
        _line(t0 + 800, 3, "render_layer", {"clipId": "88"}),
    ]
    seq = 4
    for i in range(6):
        rows.append(_line(t0 + 2000 + i * 700, seq, "set_transport",
                          {"position": i * 1.5}, undoable=False))
        seq += 1
    rows.append(_line(t0 + 9000, seq, "save", {})); seq += 1
    rows.append(_line(t0 + 9010, seq, "render_kept",
                      {"clipId": "77", "layerId": "rl-keep", "cacheKey": "ck77",
                       "adapter": "fake"})); seq += 1
    rows.append(_line(t0 + 9020, seq, "render_kept",
                      {"clipId": "88", "layerId": "rl-gone", "cacheKey": "ck88",
                       "adapter": "fake"})); seq += 1
    rows.append(_line(t0 + 20000, seq, "reset_render_layer",
                      {"clipId": "88", "layerId": "rl-gone", "cacheKey": "ck88",
                       "adapter": "fake"}))
    return rows


with tempfile.TemporaryDirectory() as td2:
    _write_session(
        td2,
        boots=[_inplace_boot(1_783_000_000_000)],
        renders=[
            ("rl-keep", {"ok": True, "adapter": "fake", "pq": 0.7}, True),
            ("rl-gone", {"ok": True, "adapter": "fake", "pq": 0.7}, True),
        ],
    )
    boots2 = census.parse_boots(os.path.join(td2, "mosh-log.jsonl"))
    labels2 = census.label_rows(boots2)
    check("spigot lines parsed as labels", len(labels2) == 3, f"got {len(labels2)}")
    verd = sorted(r["verdict"] for r in labels2)
    check("verdict mapping: kept/kept/reset", verd == ["kept", "kept", "reset"], str(verd))
    kept77 = [r for r in labels2 if r["clipId"] == "77"][0]
    kept88 = [r for r in labels2 if r["clipId"] == "88" and r["verdict"] == "kept"][0]
    reset88 = [r for r in labels2 if r["verdict"] == "reset"][0]
    check("surviving kept is organic (not scripted/contradicted/superseded)",
          not kept77["scripted"] and not kept77["contradicted"]
          and not kept77["superseded"])
    check("explicit reset supersedes the same clip's soft positive",
          kept88["superseded"] and not kept77["superseded"])
    check("kept->reset is supersession, NOT contradiction",
          not kept88["contradicted"] and not reset88["contradicted"])
    check("labels carry the native join keys (layerId/cacheKey/adapter)",
          kept77["layerId"] == "rl-keep" and kept77["cacheKey"] == "ck77"
          and kept77["adapter"] == "fake" and reset88["cacheKey"] == "ck88")

    joined2 = census.join_renders(td2, labels2)
    check("spigot labels join to on-disk renders directly by layerId",
          all(r["wav"] is not None for r in joined2))

    s = census.summarize(td2)
    check("summary: organic kept/reset counts + superseded readout",
          s["organic_kepts"] == 1 and s["organic_resets"] == 1
          and s["superseded_kepts"] == 1, json.dumps(s, sort_keys=True))

    # accept->reset (both EXPLICIT, opposite polarity, no re-render between) IS a
    # contradiction — the same audio graded both ways.
    xb = [[json.loads(_line(1_784_000_000_000, 1, "accept_render",
                            {"clipId": "9", "layerId": "rl-x"})),
           json.loads(_line(1_784_000_010_000, 2, "reset_render_layer",
                            {"clipId": "9", "layerId": "rl-x", "cacheKey": "ckx",
                             "adapter": "fake"}))]]
    lx = census.label_rows(xb)
    check("accept->reset without re-render = contradiction (explicit cross-polarity)",
          len(lx) == 2 and all(r["contradicted"] for r in lx),
          json.dumps(lx, sort_keys=True))

    # reject->reset is the SAME polarity (double negative) — not a contradiction.
    nb = [[json.loads(_line(1_785_000_000_000, 1, "reject_render", {"clipId": "9"})),
           json.loads(_line(1_785_000_010_000, 2, "reset_render_layer",
                            {"clipId": "9", "layerId": "rl-n", "cacheKey": "ckn",
                             "adapter": "fake"}))]]
    check("reject->reset same polarity is NOT a contradiction",
          not any(r["contradicted"] for r in census.label_rows(nb)))

    # Spigot labels without listening are scripted-harness, like accept/reject.
    sb = [[json.loads(_line(1_786_000_000_000, 1, "render_layer", {"clipId": "5"})),
           json.loads(_line(1_786_000_001_000, 2, "save", {})),
           json.loads(_line(1_786_000_001_100, 3, "render_kept",
                            {"clipId": "5", "layerId": "rl-s", "cacheKey": "cks",
                             "adapter": "fake"}))]]
    check("spigot labels without listening are scripted",
          census.label_rows(sb)[0]["scripted"])

    # Determinism over the spigot fixture too.
    t1 = json.dumps(census.summarize(td2), sort_keys=True)
    t2 = json.dumps(census.summarize(td2), sort_keys=True)
    check("spigot summarize deterministic", t1 == t2)

print()
if fails:
    print(f"FAILED: {len(fails)} — {fails}")
    sys.exit(1)
print("taste_census_test: ALL PASS")
