#!/usr/bin/env python3
"""FX capability probes against the INSTALLED Mosh binary — run before ANY fx pack
render (binary-vs-repo drift is this session's recurring hazard; probe every start).

  1. list_builtins carries the EXACT types the presets need (a past bench failed on a
     fuzzy "ott" — the type is `moshOTT`).
  2. Param round-trip: every preset value set via set_plugin_param reads back from
     __snapshot within ±0.01 (de-risks index/order/mapping drift; describe_plugin does
     not exist in the binary).
  3. Audibility: dry vs drum-OTT render of a two-band tone mix — gain-aligned residual
     must land in (−40, −5) dB: audible, not destructive.
  4. Bus render (optional, --bus): tone tracks routed via set_track_output into a
     lowpass'd bus must actually attenuate the high band — decides master-glue in/out.

    MOSH_BIN=/Applications/Mosh.app/Contents/MacOS/Mosh python3 scripts/verify-hardware/fx_probe.py
"""
from __future__ import annotations

import argparse
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
for p in (HERE, os.path.join(REPO, "service")):
    if p not in sys.path:
        sys.path.insert(0, p)

import verify  # noqa: E402
from teardown.render.fx import FX_PRESETS, preset_param_rows  # noqa: E402

DEFAULT_BIN = "/Applications/Mosh.app/Contents/MacOS/Mosh"
fails: list[str] = []


def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond or not extra else f"  [{extra}]"))
    if not cond:
        fails.append(name)


def snaps_of(results):
    return {r.get("label", ""): r.get("data", {}) or {}
            for r in results if r.get("command") == "__snapshot"}


def probe_builtins(binp) -> bool:
    results, _ = verify.run_script(binp, [{"command": "list_builtins", "args": {}}],
                                   "fxprobe-builtins")
    types = set()
    for r in results:
        for p in (r.get("data", {}) or {}).get("plugins", []) or []:
            types.add(p.get("type"))
    needed = {FX_PRESETS[c]["type"] for c in FX_PRESETS}
    check("list_builtins carries every preset type (exact match)",
          needed <= types, f"need {sorted(needed)}, have {sorted(types)[:12]}")
    return needed <= types


def probe_roundtrip(binp):
    for cname, preset in FX_PRESETS.items():
        cmds = [{"command": "create_track", "args": {"name": "FxP"}, "capture": {"T0": "trackId"}},
                {"command": "load_builtin", "args": {"trackId": "${T0}", "type": preset["type"]},
                 "capture": {"FX0_" + preset["type"]: "index"}}]
        cmds += preset_param_rows(preset, "${T0}", "FX0_" + preset["type"])
        cmds.append({"command": "__snapshot", "args": {"label": "st"}})
        results, _ = verify.run_script(binp, cmds, f"fxprobe-rt-{cname}")
        bad = [r for r in results if r.get("command") not in ("__snapshot",) and not r.get("ok")]
        check(f"{cname}: all commands succeed", not bad, str(bad[:2]))
        snap = snaps_of(results).get("st", {})
        track = next((t for t in snap.get("tracks", []) if t.get("name") == "FxP"), {})
        plug = next((p for p in track.get("plugins", []) or []
                     if preset["type"].lower() in (str(p.get("type", "")) + str(p.get("name", ""))).lower()), None)
        check(f"{cname}: plugin visible in snapshot", plug is not None,
              str([p.get("type") for p in track.get("plugins", []) or []]))
        if plug is None:
            continue
        got = {int(p["index"]): float(p["value"]) for p in plug.get("params", []) or []
               if p.get("index") is not None and p.get("value") is not None}
        from teardown.render.fx import norm_value
        for name, real in preset["params"].items():
            idx, want = norm_value(preset["type"], name, real)
            have = got.get(idx)
            check(f"{cname}: {name} round-trips (idx {idx}: {want:.3f})",
                  have is not None and abs(have - want) <= 0.01,
                  f"got {have}")


def probe_audibility(binp):
    from teardown.render.balance import gain_aligned_residual_db
    art = verify.ART
    dry_wav = str(art / "fxprobe-dry.wav")
    fx_wav = str(art / "fxprobe-fx.wav")
    # PULSED tones, not steady ones: OTT on a steady sine is ≈ a static band gain
    # (measured residual −42.8 dB = "inaudible") — compression only shows against a
    # moving envelope, so stagger short pulses to exercise the 120 ms release.
    base = [{"command": "create_track", "args": {"name": "Lo"}, "capture": {"T0": "trackId"}},
            {"command": "create_track", "args": {"name": "Hi"}, "capture": {"T1": "trackId"}}]
    for k, (tvar, freq) in enumerate((("T0", 100), ("T1", 2000))):
        for j, start in enumerate((0.0, 0.7, 1.4)):
            cvar = f"C{k}_{j}"
            base.append({"command": "add_test_tone_clip",
                         "args": {"trackId": f"${{{tvar}}}", "freq": freq, "seconds": 0.3,
                                  "name": f"p{k}{j}"},
                         "capture": {cvar: "clipId"}})
            if start > 0:
                base.append({"command": "move_clip",
                             "args": {"clipId": f"${{{cvar}}}", "start": start}})
    results, _ = verify.run_script(
        binp, base + [{"command": "export_audio", "args": {"file": dry_wav}}], "fxprobe-dry")
    check("audibility: dry render exports", os.path.isfile(dry_wav),
          str([r for r in results if not r.get("ok")][:2]))
    # MECHANISM proof, not preset calibration: crank OTT (amount 0.9) — if even that
    # is inaudible, the plugin isn't processing audio in the render. The conservative
    # preset's per-BEAT audibility is decided by the factory's delta gate per candidate
    # (measured: amount 0.18 on tone pulses = −41 dB residual, ≈ gain-only — tones are
    # a weak OTT stimulus; real drums with transients are the real test).
    preset = dict(FX_PRESETS["drum-ott-v0"])
    preset["params"] = dict(preset["params"], amount=0.9)
    fx_cmds = []
    for tvar in ("T0", "T1"):
        fx_cmds.append({"command": "load_builtin",
                        "args": {"trackId": f"${{{tvar}}}", "type": preset["type"]},
                        "capture": {f"FX{tvar}": "index"}})
        fx_cmds += preset_param_rows(preset, f"${{{tvar}}}", f"FX{tvar}")
    verify.run_script(binp, base + fx_cmds
                      + [{"command": "export_audio", "args": {"file": fx_wav}}], "fxprobe-fx")
    check("audibility: fx render exports", os.path.isfile(fx_wav))
    if os.path.isfile(dry_wav) and os.path.isfile(fx_wav):
        resid = gain_aligned_residual_db(dry_wav, fx_wav)
        check(f"mechanism: cranked OTT audibly processes the render (residual {resid} dB)",
              -40.0 < resid < 0.0, str(resid))


def probe_bus(binp) -> bool:
    import numpy as np
    import soundfile as sf
    art = verify.ART
    routed = str(art / "fxprobe-bus.wav")
    cmds = [{"command": "create_track", "args": {"name": "Src"}, "capture": {"T0": "trackId"}},
            {"command": "add_test_tone_clip", "args": {"trackId": "${T0}", "freq": 2000, "seconds": 1.5}},
            {"command": "create_track", "args": {"name": "Bus"}, "capture": {"B": "trackId"}},
            {"command": "set_track_output", "args": {"trackId": "${T0}", "destTrackId": "${B}"}},
            {"command": "load_builtin", "args": {"trackId": "${B}", "type": "lowpass"},
             "capture": {"LP": "index"}},
            # close the filter hard (normalized 0.05 ≈ low cutoff) — the default may be
            # wide open, which would false-negative the routing question
            {"command": "set_plugin_param",
             "args": {"trackId": "${B}", "index": "${LP}", "paramIndex": 0, "value": 0.05}},
            {"command": "export_audio", "args": {"file": routed}}]
    results, _ = verify.run_script(binp, cmds, "fxprobe-bus")
    bad = [r for r in results if r.get("command") != "__snapshot" and not r.get("ok")]
    if bad or not os.path.isfile(routed):
        check("bus probe: routed render works (glue stays OUT of v0)", False, str(bad[:2]))
        return False
    x, sr = sf.read(routed)
    if getattr(x, "ndim", 1) > 1:
        x = x.mean(axis=1)
    spec = np.abs(np.fft.rfft(x)) ** 2
    freqs = np.fft.rfftfreq(len(x), 1.0 / sr)
    hi = float(spec[(freqs > 1500) & (freqs < 2500)].sum())
    total = float(spec.sum()) + 1e-12
    attenuated = hi / total < 0.5   # a default lowpass on the bus must eat the 2 kHz tone
    check(f"bus probe: lowpass'd bus attenuates the 2 kHz tone (hi frac {hi/total:.2f})",
          attenuated)
    return attenuated


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bus", action="store_true", help="also probe bus routing (glue gate)")
    args = ap.parse_args(argv)
    binp = os.environ.get("MOSH_BIN", "").strip() or DEFAULT_BIN
    if not os.path.isfile(binp):
        print(f"no Mosh binary at {binp}")
        return 1
    if probe_builtins(binp):
        probe_roundtrip(binp)
        probe_audibility(binp)
    if args.bus:
        probe_bus(binp)
    print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
    return len(fails)


if __name__ == "__main__":
    raise SystemExit(main())
