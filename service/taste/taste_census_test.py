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
# Both labels carry their own join keys, matching MoshOps::cmdAcceptRender/cmdRejectRender.
def _scripted_boot(t0, layer_id):
    return [
        _line(t0 + 0, 1, "create_track", {"name": "t"}),
        _line(t0 + 100, 2, "import_clip", {"path": "/x.wav"}),
        _line(t0 + 200, 3, "create_render_layer", {"clipId": "1023"}),
        _line(t0 + 300, 4, "set_render_param", {"clipId": "1023", "grit": 40}),
        _line(t0 + 400, 5, "render_layer", {"clipId": "1023"}),
        _line(t0 + 8000, 6, "accept_render",
              {"clipId": "1023", "layerId": layer_id, "landing": "new_clip"}),
        _line(t0 + 9500, 7, "reject_render",
              {"clipId": "1023", "layerId": layer_id, "cacheKey": "ck-1023",
               "adapter": "fake"}),
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

    # A reject joins on its OWN layerId, not on a neighbouring accept's. Proven by making the
    # two DIFFER: the clip is accepted on rl-old, re-rendered, then rejected on rl-new. The
    # last-layer-for-clip fallback would attribute the reject to rl-old and pair the negative
    # with the wrong audio; the row's own key is the only thing that gets this right.
    with tempfile.TemporaryDirectory() as td2:
        boot = [
            _line(1_783_000_000_000, 1, "enable_all_meters", {}),
            _line(1_783_000_001_000, 2, "render_layer", {"clipId": "55"}),
            _line(1_783_000_002_000, 3, "set_transport", {"position": 1.0}),
            _line(1_783_000_003_000, 4, "accept_render",
                  {"clipId": "55", "layerId": "rl-old", "landing": "new_clip"}),
            _line(1_783_000_004_000, 5, "render_layer", {"clipId": "55"}),
            _line(1_783_000_005_000, 6, "set_transport", {"position": 2.0}),
            _line(1_783_000_006_000, 7, "reject_render",
                  {"clipId": "55", "layerId": "rl-new", "cacheKey": "ck-new",
                   "adapter": "stable_audio3"}),
        ]
        _write_session(td2, boots=[boot], renders=[
            ("rl-old", {"ok": True, "adapter": "fake", "pq": 1.0}, True),
            ("rl-new", {"ok": True, "adapter": "stable_audio3", "pq": 2.0}, True),
        ])
        j2 = census.join_renders(td2, census.label_rows(
            census.parse_boots(os.path.join(td2, "mosh-log.jsonl"))))
        rej = [r for r in j2 if r["verdict"] == "reject"]
        check("reject joins on its own layerId, not the preceding accept's",
              len(rej) == 1 and rej[0]["layerId"] == "rl-new"
              and rej[0]["adapter"] == "stable_audio3", json.dumps(rej, sort_keys=True))

    # LEGACY archive rows: rejects logged before the join-key fix carry clipId alone. The
    # fallback still recovers them from the boot's most recent layerId for that clip, so the
    # scarce existing archive stays readable.
    with tempfile.TemporaryDirectory() as td3:
        boot = [
            _line(1_784_000_000_000, 1, "enable_all_meters", {}),
            _line(1_784_000_001_000, 2, "render_layer", {"clipId": "66"}),
            _line(1_784_000_002_000, 3, "set_transport", {"position": 1.0}),
            _line(1_784_000_003_000, 4, "accept_render",
                  {"clipId": "66", "layerId": "rl-legacy", "landing": "new_clip"}),
            _line(1_784_000_004_000, 5, "reject_render", {"clipId": "66"}),   # pre-fix shape
        ]
        _write_session(td3, boots=[boot], renders=[
            ("rl-legacy", {"ok": True, "adapter": "fake", "pq": 3.0}, True)])
        j3 = census.join_renders(td3, census.label_rows(
            census.parse_boots(os.path.join(td3, "mosh-log.jsonl"))))
        legacy = [r for r in j3 if r["verdict"] == "reject"]
        check("legacy key-less reject still recovers a layerId (archive stays readable)",
              len(legacy) == 1 and legacy[0]["layerId"] == "rl-legacy"
              and legacy[0]["wav"] is not None, json.dumps(legacy, sort_keys=True))

    # An unrecoverable legacy reject (no layerId anywhere for the clip) stays HONESTLY
    # unjoined — it is never attached to some other clip's render.
    with tempfile.TemporaryDirectory() as td4:
        boot = [
            _line(1_785_000_000_000, 1, "enable_all_meters", {}),
            _line(1_785_000_001_000, 2, "render_layer", {"clipId": "77"}),
            _line(1_785_000_002_000, 3, "set_transport", {"position": 1.0}),
            _line(1_785_000_003_000, 4, "reject_render", {"clipId": "77"}),   # pre-fix, no accept
        ]
        _write_session(td4, boots=[boot], renders=[
            ("rl-other", {"ok": True, "adapter": "fake", "pq": 3.0}, True)])
        j4 = census.join_renders(td4, census.label_rows(
            census.parse_boots(os.path.join(td4, "mosh-log.jsonl"))))
        check("an unrecoverable legacy reject stays unjoined (no wrong-render guess)",
              len(j4) == 1 and j4[0]["layerId"] is None and j4[0]["wav"] is None,
              json.dumps(j4, sort_keys=True))

    # Determinism: summarize twice — byte-identical JSON.
    s1 = json.dumps(census.summarize(td), sort_keys=True)
    s2 = json.dumps(census.summarize(td), sort_keys=True)
    check("summarize deterministic", s1 == s2)

print()
if fails:
    print(f"FAILED: {len(fails)} — {fails}")
    sys.exit(1)
print("taste_census_test: ALL PASS")
