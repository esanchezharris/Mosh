#!/usr/bin/env python3
"""DAW-parity P5 replay lane, native half: replay the command trace an e2e run captured
from REAL UI gestures (ui/e2e/.replay-artifacts/*.json, written by replay-capture.spec.ts)
through `Mosh --run-script`, proving the gesture→command surface the mock accepted is
accepted by the ENGINE too — mock-contract drift dies here.

Id rebinding: the trace carries mock ids (track-10, clip-100...). Ids MINTED during the
trace (a traced command's resultIds) become run-script captures and are substituted where
later args reference them. Ids the trace references but never minted (the mock's seeded
arrangement) get STAND-INS: a create_track per unknown track id, an add_test_tone_clip per
unknown clip id — which is why capture flows stick to wave-clip + mixer ops.

Exit 0 = every replayed command succeeded natively. Advisory in the gate's native lane
first (promote to blocking once stable — see gate.sh).
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "verify-hardware"))
import verify  # noqa: E402

ART = REPO / "ui" / "e2e" / ".replay-artifacts"
ID_ARG_KEYS = ("trackId", "clipId", "busNumber", "bus", "groupId")


def build_script(trace):
    """Translate a captured trace into run-script lines with captures + stand-ins."""
    minted = {}          # mock id -> capture var name
    var_n = [0]

    def var_for(mock_id):
        var_n[0] += 1
        v = f"V{var_n[0]}"
        minted[mock_id] = v
        return v

    # Pass 1: which mock ids does the trace MINT? Many commands ECHO the id they were
    # given (set_clip_fade returns its clipId) — an id counts as minted only when the
    # command's result introduces it, i.e. it does not appear among that command's args.
    pre, lines = [], []
    minted_ids = set()
    for t in trace:
        arg_vals = set(str(v) for v in (t.get("args", {}) or {}).values())
        for k in ("trackId", "clipId", "busNumber", "groupId"):
            mid = t.get("resultIds", {}).get(k)
            if mid is not None and str(mid) not in arg_vals:
                minted_ids.add(mid)

    # Pass 2: stand-ins for referenced-but-never-minted ids (the mock's seed).
    standin_clip_tracks = {}
    for t in trace:
        args = t.get("args", {}) or {}
        for k in ID_ARG_KEYS:
            v = args.get(k)
            if isinstance(v, str) and v not in minted_ids and v not in minted:
                if k == "trackId":
                    pre.append({"command": "create_track", "args": {"name": f"standin-{v}"},
                                "capture": {var_for(v): "trackId"}})
                elif k == "clipId":
                    tvar = standin_clip_tracks.get(v)
                    if tvar is None:
                        pre.append({"command": "create_track", "args": {"name": f"standin-t-{v}"},
                                    "capture": {f"T{v.replace('-', '')}": "trackId"}})
                        tvar = f"T{v.replace('-', '')}"
                        standin_clip_tracks[v] = tvar
                    pre.append({"command": "add_test_tone_clip",
                                "args": {"trackId": "${" + tvar + "}", "seconds": 2.0, "freq": 220.0},
                                "capture": {var_for(v): "clipId"}})
                # bus numbers referenced but not minted: leave literal (native create_bus
                # numbering starts fresh; a literal stale bus is reported as a failure).

    # Pass 3: the traced commands, args rebound, mints captured. String ids rebind by
    # value; bus NUMBERS (ints) rebind only via the "bus" arg key (an int anywhere else
    # is a real value, not an id).
    bus_map = {}   # mock bus number -> capture var
    for t in trace:
        line = {"command": t["command"], "args": {}}
        for k, v in (t.get("args", {}) or {}).items():
            if isinstance(v, str) and v in minted:
                line["args"][k] = "${" + minted[v] + "}"
            elif k == "bus" and isinstance(v, (int, float)) and v in bus_map:
                line["args"][k] = "${" + bus_map[v] + "}"
            else:
                line["args"][k] = v
        caps = {}
        rid = t.get("resultIds", {}) or {}
        arg_vals = set(str(v) for v in (t.get("args", {}) or {}).values())
        for k in ("trackId", "clipId", "groupId"):
            mid = rid.get(k)
            if isinstance(mid, str) and mid not in minted and str(mid) not in arg_vals:
                caps[var_for(mid)] = k
        if rid.get("busNumber") is not None and rid["busNumber"] not in bus_map:
            var_n[0] += 1
            bus_map[rid["busNumber"]] = f"V{var_n[0]}"
            caps[bus_map[rid["busNumber"]]] = "busNumber"
        if caps:
            line["capture"] = caps
        lines.append(line)
    return pre + lines


def main():
    binary = verify.find_binary(sys.argv[1] if len(sys.argv) > 1 else None)
    traces = sorted(ART.glob("*.json"))
    if not traces:
        print(f"replay: no captured traces in {ART} — run the e2e capture spec first "
              f"(cd ui && npx playwright test replay-capture.spec.ts). Nothing to do.")
        return 0
    bad = 0
    for tf in traces:
        trace = json.loads(tf.read_text())
        cmds = build_script(trace)
        results, proc = verify.run_script(binary, cmds, f"replay-{tf.stem}")
        fails = verify.failed_commands(results)
        n_replayed = len([t for t in trace])
        if fails:
            bad += 1
            print(f"replay: {tf.name}: {len(fails)} of {n_replayed} traced commands FAILED natively:")
            for f in fails:
                print(f"  {f.get('command')}: {f.get('error')}")
        else:
            print(f"replay: {tf.name}: {n_replayed} traced commands (+{len(cmds) - n_replayed} "
                  f"stand-ins) all accepted by the engine")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
