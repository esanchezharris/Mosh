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
recipe_from_program, verify_recipe, WEIGHTS = _mod.recipe_from_program, _mod.verify_recipe, _mod.WEIGHTS

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata", "verifier_parity.json")
TOL = 1e-6


def _load():
    with open(GOLDEN) as f:
        return json.load(f)["items"]


def test_weights_sum_to_one():
    assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9, f"WEIGHTS sum to {sum(WEIGHTS.values())}"


def test_parity_total_and_dims():
    items = _load()
    assert len(items) == 28, f"expected 28 parity records, got {len(items)}"
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


def test_validity_production_and_exploits():
    items = _load()
    by = {i["name"]: verify_recipe(i["recipe"])["total"] for i in items}
    # the owner's property: a REAL production scores high; a stock-sound OUTLINE (the SAME
    # perfect MIDI, just bundled/default sounds) is crushed by the realness gate.
    assert by["good_real"] > 0.85, f"good_real {by['good_real']}"
    assert by["good_stock"] < 0.6, f"good_stock {by['good_stock']}"
    assert by["good_real"] - by["good_stock"] > 0.3, f"gap {by['good_real'] - by['good_stock']}"
    # every Goodhart exploit still crushed (<0.7) — exclude the good* references + prod variants
    refs = {"good", "good_real", "good_stock", "partial_real"}
    bad = [(n, t) for n, t in by.items() if n not in refs and t >= 0.7]
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


_GOOD_DRUMS = [(36, 0, .25, 118), (36, 2.5, .25, 96), (36, 4, .25, 120), (38, 1, .25, 110), (38, 3, .25, 102),
               (38, 5, .25, 112), (38, 7, .25, 100), (42, 0, .25, 80), (42, .5, .25, 60), (42, 1, .25, 90),
               (42, 1.5, .25, 58), (42, 2, .25, 86), (42, 3, .25, 70), (42, 4, .25, 88), (42, 5, .25, 64), (42, 6, .25, 84)]
_GOOD_BASS = [(33, 0, 1, 110), (40, 2, 1, 96), (36, 4, 1, 108), (43, 6, 1, 90)]
_GOOD_LEAD = [(69, 0, .5, 100), (72, .5, .5, 86), (71, 1, .5, 94), (76, 2, 1, 104),
              (74, 4, .5, 90), (72, 4.5, .5, 82), (69, 5, .5, 98), (77, 6, 1, 92)]


def _program_good():  # same good MIDI + REAL production (real kit + melodic 808 + a real synth)
    prog = [{"command": "set_tempo", "args": {"bpm": 140}},
            {"command": "create_track", "args": {"name": "Drums", "type": "drum"}, "capture": {"v0": "trackId"}},
            {"command": "assign_sample", "args": {"trackId": "${v0}", "note": 36, "file": "/musica/H34V3N/kicks/kick - boom.wav"}},
            {"command": "assign_sample", "args": {"trackId": "${v0}", "note": 38, "file": "/musica/H34V3N/snares/snare - knock.wav"}},
            {"command": "assign_sample", "args": {"trackId": "${v0}", "note": 42, "file": "/musica/H34V3N/hats/hat - tip.wav"}},
            {"command": "set_track_volume", "args": {"trackId": "${v0}", "db": -3}}]
    prog += _drum_clip("v0", _GOOD_DRUMS)
    prog += [{"command": "create_track", "args": {"name": "808"}, "capture": {"v1": "trackId"}},
             {"command": "assign_sample", "args": {"trackId": "${v1}", "note": 36, "file": "/musica/808s/808 sub C.wav", "mode": "melodic"}},
             {"command": "set_track_volume", "args": {"trackId": "${v1}", "db": -5}}]
    prog += _drum_clip("v1", _GOOD_BASS)
    prog += [{"command": "create_track", "args": {"name": "Lead"}, "capture": {"v2": "trackId"}},
             {"command": "load_plugin", "args": {"trackId": "${v2}", "pluginId": "Serum"}},
             {"command": "set_track_volume", "args": {"trackId": "${v2}", "db": -9}}]
    prog += _drum_clip("v2", _GOOD_LEAD)
    return prog


def _program_outline():  # the owner's complaint: same good MIDI but STOCK sounds (load_drum_kit + bare 4OSC)
    prog = [{"command": "set_tempo", "args": {"bpm": 140}},
            {"command": "create_track", "args": {"name": "Drums", "type": "drum"}, "capture": {"v0": "trackId"}},
            {"command": "load_drum_kit", "args": {"trackId": "${v0}"}}]   # bundled stock pads
    prog += _drum_clip("v0", _GOOD_DRUMS)
    prog += [{"command": "create_track", "args": {"name": "808"}, "capture": {"v1": "trackId"}}]  # → 4OSC default
    prog += _drum_clip("v1", _GOOD_BASS)
    prog += [{"command": "create_track", "args": {"name": "Lead"}, "capture": {"v2": "trackId"}}]  # → 4OSC default
    prog += _drum_clip("v2", _GOOD_LEAD)
    return prog


def _program_empty():  # the old failure mode: tracks + clips, NO notes → silent skeleton
    return [{"command": "create_track", "args": {"name": "Drums", "type": "drum"}, "capture": {"v0": "trackId"}},
            {"command": "add_midi_clip", "args": {"trackId": "${v0}"}, "capture": {"v0c": "clipId"}},
            {"command": "create_track", "args": {"name": "Lead"}, "capture": {"v1": "trackId"}}]


def test_program_reward_gradient():
    """The deterministic analog of proveGradient, now PRODUCTION-AWARE: a REAL beat >> the SAME
    beat on STOCK sounds (the outline) >> an empty skeleton — a non-zero, valid gradient over
    rollouts that the GRPO reward sees from the command program (no render needed)."""
    g = verify_recipe(recipe_from_program(_program_good(), bars=2))["total"]
    d = verify_recipe(recipe_from_program(_program_outline(), bars=2))["total"]
    e = verify_recipe(recipe_from_program(_program_empty(), bars=2))["total"]
    assert g > d > e, f"expected real>{d:.3f}(outline)>{e:.3f}(empty), got real={g:.3f} outline={d:.3f} empty={e:.3f}"
    assert g - d > 0.3, f"real-vs-outline gap too small: real={g:.3f} outline={d:.3f}"
    return g, d, e


if __name__ == "__main__":
    test_weights_sum_to_one()
    worst = test_parity_total_and_dims()
    test_validity_production_and_exploits()
    test_program_adapter_roundtrip()
    g, d, e = test_program_reward_gradient()
    items = _load()
    by = {i["name"]: verify_recipe(i["recipe"])["total"] for i in items}
    refs = {"good", "good_real", "good_stock", "partial_real"}
    foolmax = max(t for n, t in by.items() if n not in refs)
    print(f"PARITY OK: 28/28 recipes match TS within {TOL:g} (worst Δ {worst:.2e}); WEIGHTS sum to 1")
    print(f"VALIDITY OK: good_real {by['good_real']:.4f} > 0.85;  good_stock {by['good_stock']:.4f} < 0.6 "
          f"(stock-outline crushed, gap {by['good_real'] - by['good_stock']:.3f});  all 24 exploits < 0.7 (max {foolmax:.4f})")
    print("PROGRAM ADAPTER OK: rollout commands → recipe roundtrip")
    print(f"GRADIENT OK: good {g:.3f} > degraded {d:.3f} > empty {e:.3f} (spread {g - e:.3f}) — valid reward gradient, no render")
