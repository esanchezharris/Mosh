#!/usr/bin/env python3
"""Parity + validity guard for recipe_verifier.py (the Python GRPO recipe-reward).

PARITY: the port must reproduce the TS verifier's verdict on the SAME 25 recipes (1 good
reference + the 24 red-team exploits) within 1e-6 on the total AND every dim. The golden,
testdata/verifier_parity.json, is dumped by ui/scripts/dumpVerifierParity.mts from the
committed TS verifier. If the port drifts from TS, the GRPO reward stops matching the
validated verifier — so this is the anti-drift gate.

VALIDITY: re-assert the TS test's own guarantees on the Python side — the good beat scores
high (>0.85) and EVERY Goodhart exploit is crushed (<0.7) — so optimizing against this reward
can't be gamed by the known attacks.

PROGRAM ADAPTER: recipe_from_program reconstructs a recipe from a MoshOps command rollout.

Run: python3 service/teardown/flywheel/recipe_verifier_test.py   (or via pytest)
"""
import importlib.util
import json
import os

# load recipe_verifier.py directly (it's pure stdlib) — bypass flywheel/__init__.py, which
# pulls heavy audio deps (oracle.score) the deterministic verifier doesn't need.
_RV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recipe_verifier.py")
_spec = importlib.util.spec_from_file_location("recipe_verifier", _RV)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
recipe_from_program, verify_recipe = _mod.recipe_from_program, _mod.verify_recipe

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata", "verifier_parity.json")
TOL = 1e-6


def _load():
    with open(GOLDEN) as f:
        return json.load(f)["items"]


def test_parity_total_and_dims():
    items = _load()
    assert len(items) == 25, f"expected 25 parity records, got {len(items)}"
    worst = 0.0
    for it in items:
        v = verify_recipe(it["recipe"])
        dt = abs(v["total"] - it["total"])
        worst = max(worst, dt)
        assert dt <= TOL, f"{it['name']}: total {v['total']} vs TS {it['total']} (Δ{dt:.2e})"
        for k, ts_val in it["dims"].items():
            dd = abs(v["dims"][k] - ts_val)
            worst = max(worst, dd)
            assert dd <= TOL, f"{it['name']}: dim {k} {v['dims'][k]} vs TS {ts_val} (Δ{dd:.2e})"
    return worst


def test_validity_good_high_exploits_crushed():
    items = _load()
    good = next(i for i in items if i["name"] == "good")
    assert verify_recipe(good["recipe"])["total"] > 0.85
    survivors = [(i["name"], verify_recipe(i["recipe"])["total"]) for i in items if i["name"] != "good"]
    bad = [s for s in survivors if s[1] >= 0.7]
    assert not bad, f"surviving exploits (≥0.7): {bad}"


def test_program_adapter_roundtrip():
    # a tiny run-script-shaped rollout: tempo + 2 tracks (capture vars) + notes via clip refs
    prog = [
        {"command": "set_tempo", "args": {"bpm": 140}},
        {"command": "create_track", "args": {"name": "Drums", "type": "drum"}, "capture": {"v0": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${v0}"}, "capture": {"v1": "clipId"}},
        {"command": "add_note", "args": {"clipId": "${v1}", "pitch": 36, "start": 0, "length": 0.25, "velocity": 118}},
        {"command": "add_note", "args": {"clipId": "${v1}", "pitch": 38, "start": 1, "length": 0.25, "velocity": 100}},
        {"command": "create_track", "args": {"name": "808"}, "capture": {"v2": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${v2}"}, "capture": {"v3": "clipId"}},
        {"command": "add_note", "args": {"clipId": "${v3}", "pitch": 33, "start": 0, "length": 1, "velocity": 110}},
    ]
    r = recipe_from_program(prog)
    assert r["tempo"] == 140
    roles = sorted(t["role"] for t in r["tracks"])
    assert roles == ["bass", "drums"], roles
    drums = next(t for t in r["tracks"] if t["role"] == "drums")
    assert len(drums["notes"]) == 2 and any(n["pitch"] == 36 for n in drums["notes"])
    bass = next(t for t in r["tracks"] if t["role"] == "bass")
    assert len(bass["notes"]) == 1 and bass["notes"][0]["pitch"] == 33


def _drum_clip(var, notes):
    out = [{"command": "add_midi_clip", "args": {"trackId": f"${{{var}}}"}, "capture": {f"{var}c": "clipId"}}]
    for p, s, ln, v in notes:
        out.append({"command": "add_note", "args": {"clipId": f"${{{var}c}}", "pitch": p, "start": s, "length": ln, "velocity": v}})
    return out


def _program_good():
    prog = [{"command": "set_tempo", "args": {"bpm": 140}},
            {"command": "create_track", "args": {"name": "Drums", "type": "drum"}, "capture": {"v0": "trackId"}}]
    dn = [(36, 0, .25, 118), (36, 2.5, .25, 96), (36, 4, .25, 120), (38, 1, .25, 110), (38, 3, .25, 102),
          (38, 5, .25, 112), (38, 7, .25, 100), (42, 0, .25, 80), (42, .5, .25, 60), (42, 1, .25, 90),
          (42, 1.5, .25, 58), (42, 2, .25, 86), (42, 3, .25, 70), (42, 4, .25, 88), (42, 5, .25, 64), (42, 6, .25, 84)]
    prog += _drum_clip("v0", dn)
    prog += [{"command": "create_track", "args": {"name": "808"}, "capture": {"v1": "trackId"}}]
    prog += _drum_clip("v1", [(33, 0, 1, 110), (40, 2, 1, 96), (36, 4, 1, 108), (43, 6, 1, 90)])
    prog += [{"command": "create_track", "args": {"name": "Lead"}, "capture": {"v2": "trackId"}}]
    prog += _drum_clip("v2", [(69, 0, .5, 100), (72, .5, .5, 86), (71, 1, .5, 94), (76, 2, 1, 104),
                              (74, 4, .5, 90), (72, 4.5, .5, 82), (69, 5, .5, 98), (77, 6, 1, 92)])
    return prog


def _program_degraded():  # flat velocity + bar-2 clone (the metronome exploit, as a rollout)
    prog = [{"command": "set_tempo", "args": {"bpm": 140}},
            {"command": "create_track", "args": {"name": "Drums", "type": "drum"}, "capture": {"v0": "trackId"}}]
    dn = [(36, b, .25, 100) for b in (0, 1, 2, 3, 4, 5, 6, 7)] + [(38, b, .25, 100) for b in (1, 3, 5, 7)]
    prog += _drum_clip("v0", dn)
    prog += [{"command": "create_track", "args": {"name": "Lead"}, "capture": {"v1": "trackId"}}]
    prog += _drum_clip("v1", [(69, b, .5, 100) for b in (0, 1, 2, 3, 4, 5, 6, 7)])  # one pitch class, clone bars
    return prog


def _program_empty():  # the old failure mode: tracks + clips, NO notes → silent skeleton
    return [{"command": "create_track", "args": {"name": "Drums", "type": "drum"}, "capture": {"v0": "trackId"}},
            {"command": "add_midi_clip", "args": {"trackId": "${v0}"}, "capture": {"v0c": "clipId"}},
            {"command": "create_track", "args": {"name": "Lead"}, "capture": {"v1": "trackId"}}]


def test_program_reward_gradient():
    """The deterministic analog of proveGradient: good >> degraded >> empty, with real spread —
    i.e. the RECIPE reward gives a non-zero, VALID gradient over rollouts (no render needed)."""
    g = verify_recipe(recipe_from_program(_program_good(), bars=2))["total"]
    d = verify_recipe(recipe_from_program(_program_degraded(), bars=2))["total"]
    e = verify_recipe(recipe_from_program(_program_empty(), bars=2))["total"]
    assert g > d > e, f"expected good>{d:.3f}>{e:.3f}, got good={g:.3f} deg={d:.3f} empty={e:.3f}"
    assert g - e > 0.3, f"reward spread too small: good={g:.3f} empty={e:.3f}"
    return g, d, e


if __name__ == "__main__":
    worst = test_parity_total_and_dims()
    test_validity_good_high_exploits_crushed()
    test_program_adapter_roundtrip()
    g, d, e = test_program_reward_gradient()
    items = _load()
    good = next(i for i in items if i["name"] == "good")["total"]
    foolmax = max(verify_recipe(i["recipe"])["total"] for i in items if i["name"] != "good")
    print(f"PARITY OK: 25/25 recipes match TS within {TOL:g} (worst Δ {worst:.2e})")
    print(f"VALIDITY OK: good {good:.4f} > 0.85;  all 24 exploits < 0.7 (max {foolmax:.4f})")
    print("PROGRAM ADAPTER OK: rollout commands → recipe roundtrip")
    print(f"GRADIENT OK: good {g:.3f} > degraded {d:.3f} > empty {e:.3f} (spread {g - e:.3f}) — valid reward gradient, no render")
