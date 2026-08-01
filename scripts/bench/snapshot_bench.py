#!/usr/bin/env python3
"""D1 — snapshot() scaling benchmark (MEASURE before optimizing).

snapshot() rebuilds the whole project tree and the WebView re-pulls it on every
snapshot_invalidated. The review flagged this as a potential O(project-size) lag source at
100 tracks / dense MIDI. Before building scoped invalidation (a real lift), MEASURE: this
builds a large project via `Mosh --run-script` and times ops.snapshot() (build + JSON
marshal — the exact per-edit cost the bridge pays) plus the serialized size.

If snapshot() stays cheap at 100 tracks, scoped invalidation is premature. If it balloons,
that's the signal to build it. Transport is already split off the snapshot, so a moving
playhead is NOT in this cost.

Usage: python3 scripts/bench/snapshot_bench.py [--tracks 100] [--notes 200] [--bin <Mosh>]
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def find_binary(explicit=None):
    if explicit:
        return Path(explicit)
    for c in [
        REPO / "build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh",
        REPO / "build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh",
        Path("/Applications/Mosh.app/Contents/MacOS/Mosh"),
    ]:
        if c.exists():
            return c
    sys.exit("Mosh binary not found — build it or pass --bin")


def main():
    ap = argparse.ArgumentParser(description="snapshot() scaling benchmark")
    ap.add_argument("--tracks", type=int, default=100)
    ap.add_argument("--notes", type=int, default=200, help="MIDI notes per track")
    ap.add_argument("--iterations", type=int, default=30, help="snapshot() timing iterations")
    ap.add_argument("--bin")
    args = ap.parse_args()
    binary = find_binary(args.bin)

    cmds = []
    for t in range(args.tracks):
        cmds.append({"command": "create_track", "args": {"name": f"T{t}"}, "capture": {"T": "trackId"}})
        notes = [{"pitch": 36 + (i % 24), "start": i * 0.25, "length": 0.2, "velocity": 100}
                 for i in range(args.notes)]
        cmds.append({"command": "add_midi_clip",
                     "args": {"trackId": "${T}", "start": 0, "length": args.notes * 0.25, "notes": notes}})
    cmds.append({"command": "__bench_snapshot", "args": {"iterations": args.iterations}})

    art = REPO / "verify-artifacts"
    art.mkdir(exist_ok=True)
    spath = art / "snapshot_bench.script.jsonl"
    opath = art / "snapshot_bench.results.jsonl"
    spath.write_text("\n".join(json.dumps(c) for c in cmds) + "\n")
    if opath.exists():
        opath.unlink()
    env = dict(os.environ)
    env.update({"MOSH_RUN_SCRIPT": str(spath), "MOSH_RUN_SCRIPT_OUT": str(opath),
                "MOSH_SELFTEST_SESSION": "_harness/snapshot-bench", "MOSH_NO_AUDIO": "1"})
    subprocess.run([str(binary), "--run-script"], env=env, capture_output=True, text=True, timeout=300)

    bench, fails = None, 0
    for line in (opath.read_text().splitlines() if opath.exists() else []):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("command") == "__bench_snapshot":
            bench = r.get("data")
        elif not r.get("ok", True):
            fails += 1
    if not bench:
        sys.exit("no __bench_snapshot result — rebuild the binary (the hook is in SelfTest.cpp)")

    total_notes = args.tracks * args.notes
    print(f"project: {args.tracks} tracks × {args.notes} notes = ~{total_notes} MIDI notes  "
          f"(setup failures: {fails})")
    print(f"snapshot(): {bench['avgMs']:.2f} ms avg   {bench['jsonBytes'] / 1024:.1f} KiB serialized   "
          f"(over {bench['iterations']} iters)")
    # A soft guideline: a single edit should re-marshal in well under a frame budget (~16ms).
    verdict = "OK — scoped invalidation not yet warranted" if bench["avgMs"] < 16 else \
              "SLOW — consider scoped invalidation (emit changed trackId; UI patches that subtree)"
    print(f"verdict: {verdict}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
