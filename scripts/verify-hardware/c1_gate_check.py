"""--c1-gate: a hosted plugin with a sidechain bus keys from its own input.

Owner report 2026-10-14: Waves "C1 gate Stereo" shut all audio even with Gate Open at
-99 dB. Tracktion enables every bus of a hosted plugin and feeds an unrouted sidechain
silence, so the gate keyed from nothing. src/plugins/hosting/SidechainBuses.h turns the
unrouted bus off; the --selftest section proves the layout logic on a probe processor, and
this proves the hosted path against the real plugin.

Opt-in (needs Waves C1 installed and licensed), and it SKIPS — not fails — when the plugin
is not in this machine's catalog. Three renders of a -18 dBFS tone:

  open  Gate Open/Close -99.3 dB  -> must pass the tone (before the fix: -144.5 dBFS)
  shut  Gate Open/Close -10.0 dB  -> must gate it (the threshold is above the tone)
  none  no gate                    -> the reference level

`shut` is the anti-vacuity control: a gate that passes everything would also pass `open`.
"""
import math

PLUGIN_ID = "VST3-C1 gate Stereo-b2a14d3c-b9de7a00"
GATE_OPEN, GATE_CLOSE = 8, 9          # parameter indices of "Gate Open" / "Gate Close"
OPEN_VALUE = 0.006896552              # -99.3 dB
SHUT_VALUE = 0.90                     # -10.0 dB


def _db(rms):
    return 20 * math.log10(rms) if rms > 0 else -200.0


def check_c1_gate(ctx, art, run_script, stats, failed_commands):
    name = "Hosted sidechain plugin keys from its own input (Waves C1 gate)"
    listed, _ = run_script(ctx.bin, [{"command": "list_plugins", "args": {}}], "verify-c1-catalog")
    catalog = next((r for r in listed if r.get("command") == "list_plugins"), {})
    ids = {p.get("id") or p.get("pluginId") for p in (catalog.get("data") or {}).get("plugins", [])}
    if PLUGIN_ID not in ids:
        return {"check": name, "pass": True, "detail": {"skipped": f"{PLUGIN_ID} not in this machine's plugin catalog"}}

    levels, failures = {}, {}
    for tag, value in (("none", None), ("open", OPEN_VALUE), ("shut", SHUT_VALUE)):
        out = art / f"c1_gate_{tag}.wav"
        cmds = [{"command": "create_track", "args": {"name": "Tone"}, "capture": {"T": "trackId"}},
                {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 4.0, "freq": 220.0}}]
        if value is not None:
            cmds += [{"command": "load_plugin", "args": {"trackId": "${T}", "pluginId": PLUGIN_ID}, "capture": {"P": "index"}},
                     {"command": "__wait", "args": {"ms": 3000}}]
            cmds += [{"command": "set_plugin_param", "args": {"trackId": "${T}", "index": "${P}", "paramIndex": i, "value": value}}
                     for i in (GATE_OPEN, GATE_CLOSE)]
        cmds.append({"command": "export_audio", "args": {"file": str(out)}})
        results, proc = run_script(ctx.bin, cmds, f"verify-c1-{tag}", timeout=300)
        bad = failed_commands(results)
        if bad or not out.exists():
            failures[tag] = {"failed_commands": bad, "exists": out.exists(), "stderr": proc.stderr[-300:]}
            continue
        levels[tag] = round(_db(stats(out)["rms"]), 1)

    if failures:
        return {"check": name, "pass": False, "detail": {"failures": failures, "levels_db": levels}}
    passes = abs(levels["open"] - levels["none"]) < 1.0      # -99 dB threshold: the tone goes through
    gates = levels["shut"] < levels["none"] - 40.0           # -10 dB threshold: the tone is gated
    return {"check": name, "pass": passes and gates,
            "detail": {"levels_db": levels, "open_passes_tone": passes, "shut_gates_tone": gates}}
