#!/usr/bin/env python3
"""V3 default-shell acceptance harness (docs/VERIFICATION.md, "V3 default-shell acceptance").

Automates every part of the six owner rows that a machine can honestly close, on this Mac,
against the REAL engine — and writes the dated evidence directory the flip PR cites:

    ~/Library/Mosh/task-evidence/<YYYY-MM-DD>-v3-acceptance/

What it proves, row by row (each check would read differently if the feature were absent):

  V3-beat   `add_drum_pattern` with no target lands a kit + one-bar pattern; the offline
            render has real drum onsets; one undo removes the track. (The dock's lofi ask is
            exercised against the mock loop by ui/e2e/v3-beat.spec.ts in the V3-feel run.)
  V3-vocal  `Mosh --v3-vocal-smoke` on a BlackHole loopback: a 1-bar count-in rolls and is
            EXCLUDED from the take, two passes land as non-silent WAVs within the calibrated
            tolerance, Again rejects/mutes, Keep moves the pass to LEAD, undo reverses it.
  V3-mix    level / pan / mute / solo / a 4OSC preset / a send to a reverb bus / a clip move
            each change the RENDERED audio in the direction the edit implies, and one undo
            each returns the render to the baseline byte-for-byte within tolerance.
            Snapshot cost and command latency are measured (feel is still the owner's).
  V3-file   save_as → new_project → open_project reproduces the same project projection;
            the exported mixdown is non-silent; a generated .mid imports as one clip with
            the expected note count; undo removes it.
  V3-mp     two REAL Mosh processes on this Mac over the local relay (scripts/playtest/
            mp-two-window-dry-run.sh): create/join, claim→commit, bus, group, late-join
            bootstrap, a multi-second take byte-identical on the peer.  --cloud adds the
            cloud-relay smoke. The mock peer's lock badge is covered by v3-multiplayer.spec.
  V3-feel   the whole V3 Playwright suite (mock backend) plus ui/e2e/v3-acceptance-screens
            .spec.ts: every surface screenshotted in every colorway, accents proven distinct
            by pixel readback.

What stays with the owner (printed per row in REPORT.md): ears (does the beat / take /
mix / export SOUND right), feel and latency at the desk, a second physical Mac, and a
physical phone. Those are minutes, not a session: listen to the WAVs and flip the PNGs.

Usage:
    python3 scripts/v3-acceptance/run.py                 # all rows, newest local Release
    python3 scripts/v3-acceptance/run.py --bin <Mosh> --only beat,mix
    python3 scripts/v3-acceptance/run.py --cloud         # also the cloud-relay mp smoke
Exit 0 iff every row it ran passed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "verify-hardware"))
import verify as V  # noqa: E402  (load_wav / stats / onsets_seconds / diff_rms / find_binary)
from harness_session import reset_owned_harness_session  # noqa: E402

DEFAULT_DRUM_BEAT = "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x."
LOOPBACK_DEVICE = os.environ.get("MOSH_V3_LOOPBACK_DEVICE", "BlackHole 2ch")
STAMP = dt.datetime.now().strftime("%Y-%m-%d")


# ── plumbing ────────────────────────────────────────────────────────────────────────
class Row:
    def __init__(self, id_: str, title: str, owner: list[str]):
        self.id, self.title, self.owner = id_, title, owner
        self.checks: list[dict] = []
        self.artifacts: list[str] = []
        self.notes: list[str] = []
        self.blocked: str | None = None

    def chk(self, cond: bool, what: str, detail=None) -> bool:
        self.checks.append({"ok": bool(cond), "what": what, "detail": detail})
        return bool(cond)

    @property
    def passed(self) -> bool:
        return self.blocked is None and bool(self.checks) and all(c["ok"] for c in self.checks)

    def to_json(self) -> dict:
        return {"id": self.id, "title": self.title, "passed": self.passed, "blocked": self.blocked,
                "checks": self.checks, "artifacts": self.artifacts, "notes": self.notes, "owner": self.owner}


def _session_base() -> Path:
    return Path.home() / "Library" / "Mosh"


def _session_dir(leaf: str) -> Path:
    return _session_base() / "_harness" / leaf


def run_script(binary: Path, cmds: list[dict], leaf: str, out_dir: Path, extra_env: dict | None = None,
               timeout: int = 240) -> tuple[list[dict], subprocess.CompletedProcess, float]:
    """`Mosh --run-script` on an isolated harness session. Returns (results, proc, seconds)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    spath, opath = out_dir / f"{leaf}.script.jsonl", out_dir / f"{leaf}.results.jsonl"
    spath.write_text("\n".join(json.dumps(c) for c in cmds) + "\n")
    if opath.exists():
        opath.unlink()
    reset_owned_harness_session(_session_dir(leaf))
    env = dict(os.environ)
    env.update({"MOSH_RUN_SCRIPT": str(spath), "MOSH_RUN_SCRIPT_OUT": str(opath),
                "MOSH_SELFTEST_SESSION": f"_harness/{leaf}", "MOSH_NO_AUDIO": "1", "MOSH_ENABLE_SA3": "0"})
    env.update(extra_env or {})
    t0 = time.monotonic()
    proc = subprocess.run([str(binary), "--run-script", "-ApplePersistenceIgnoreState", "YES"],
                          env=env, capture_output=True, text=True, timeout=timeout)
    secs = time.monotonic() - t0
    (out_dir / f"{leaf}.stderr.log").write_text(proc.stderr[-20000:])
    results = []
    if opath.exists():
        for line in opath.read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    results.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return results, proc, secs


def failed(results: list[dict]) -> list[dict]:
    return [{"command": r.get("command"), "error": r.get("error")} for r in results if not r.get("ok", False)]


def snap(results: list[dict], label: str) -> dict:
    for r in results:
        if r.get("command") == "__snapshot" and r.get("label") == label:
            return r.get("data", {})
    return {}


def data_of(results: list[dict], command: str, nth: int = 0) -> dict:
    hits = [r for r in results if r.get("command") == command]
    return hits[nth].get("data", {}) if len(hits) > nth else {}


def tracks(s: dict) -> list[dict]:
    return [t for t in s.get("tracks", []) if not t.get("isReturn")]


def track_by_id(s: dict, tid: str) -> dict:
    for t in s.get("tracks", []):
        if t.get("id") == tid:
            return t
    return {}


def clip_by_id(s: dict, cid: str) -> dict:
    for t in s.get("tracks", []):
        for c in t.get("clips", []):
            if c.get("id") == cid:
                return c
    return {}


def projection(s: dict) -> list[dict]:
    """The part of a snapshot a reopen must reproduce: names, kinds, clip placement, plugins,
    mixer state. Ids are deliberately included — Tracktion persists itemIDs in the edit."""
    out = []
    for t in s.get("tracks", []):
        out.append({
            "id": t.get("id"), "name": t.get("name"), "type": t.get("type"), "isReturn": bool(t.get("isReturn")),
            "volumeDb": round(float(t.get("volumeDb", 0.0)), 3), "pan": round(float(t.get("pan", 0.0)), 3),
            "mute": bool(t.get("mute")), "solo": bool(t.get("solo")),
            "plugins": [p.get("name") for p in (t.get("plugins") or [])],
            "clips": sorted([(c.get("id"), c.get("type"), round(float(c.get("start", 0)), 4), round(float(c.get("length", 0)), 4))
                             for c in t.get("clips", [])]),
        })
    return out


def stereo_rms(path: Path) -> tuple[float, float]:
    data, _sr, ch = V.load_wav(str(path))
    if ch < 2:
        m = float(np.sqrt(np.mean(data ** 2)))
        return m, m
    return float(np.sqrt(np.mean(data[:, 0] ** 2))), float(np.sqrt(np.mean(data[:, 1] ** 2)))


def write_smf(path: Path, notes: list[tuple[int, int, int]], ppq: int = 480) -> None:
    """A format-0 Standard MIDI File: (pitch, start_ticks, length_ticks) notes on channel 1."""
    events = []
    for pitch, start, length in notes:
        events.append((start, bytes([0x90, pitch, 100])))
        events.append((start + length, bytes([0x80, pitch, 0])))
    events.sort(key=lambda e: e[0])
    track, last = bytearray(), 0
    def vlq(n: int) -> bytes:
        out = bytearray([n & 0x7F]); n >>= 7
        while n:
            out.insert(0, 0x80 | (n & 0x7F)); n >>= 7
        return bytes(out)
    for at, msg in events:
        track += vlq(at - last) + msg
        last = at
    track += vlq(0) + b"\xff\x2f\x00"
    path.write_bytes(b"MThd" + struct.pack(">IHHH", 6, 0, 1, ppq) + b"MTrk" + struct.pack(">I", len(track)) + bytes(track))


def four_osc_preset_file(binary: Path) -> Path | None:
    """The bundled Keys patch (the one the V3 '+ Chords' moment loads); the Keys track in
    row B is named for it. Falls back to the first bundled file so an older bundle (which
    shipped mosh-*.json, where sort order happened to pick mosh-keys) still runs the row."""
    root = binary.parents[1] / "Resources" / "presets" / "4osc"   # Mosh.app/Contents/MacOS/Mosh → Contents/Resources
    files = sorted(p for p in root.glob("*.json") if p.is_file()) if root.exists() else []
    for name in ("Keys.json", "mosh-keys.json"):
        if (root / name).is_file():
            return root / name
    return files[0] if files else None


# ── V3-beat ─────────────────────────────────────────────────────────────────────────
def row_beat(ctx) -> Row:
    row = Row("V3-beat", "Drop in a beat", [
        "Does the kit SOUND like a drum kit at the desk (the render only proves onsets).",
        "The dock's lofi ask against a real model — the mock loop is what the e2e proves.",
    ])
    out = ctx.out / "beat"; out.mkdir(parents=True, exist_ok=True)
    wav = out / "beat.wav"
    cmds = [
        {"command": "__snapshot", "args": {"label": "base"}},
        {"command": "add_drum_pattern", "args": {"pattern": DEFAULT_DRUM_BEAT, "name": "Drums", "start": 0},
         "capture": {"T": "trackId", "C": "clipId"}},
        {"command": "__snapshot", "args": {"label": "beat"}},
        {"command": "export_audio", "args": {"file": str(wav)}},
        {"command": "undo"},
        {"command": "__snapshot", "args": {"label": "undone"}},
    ]
    results, proc, _ = run_script(ctx.bin, cmds, f"v3-accept-beat-{ctx.pid}", out)
    row.artifacts += [str(out / f"v3-accept-beat-{ctx.pid}.results.jsonl")]
    if not row.chk(not failed(results) and proc.returncode == 0, "every command ok", failed(results) or proc.stderr[-300:]):
        return row
    base, beat, undone = snap(results, "base"), snap(results, "beat"), snap(results, "undone")
    added = data_of(results, "add_drum_pattern")
    row.chk(len(tracks(beat)) == len(tracks(base)) + 1, "one drum track created by the single command",
            {"before": len(tracks(base)), "after": len(tracks(beat))})
    t = track_by_id(beat, added.get("trackId", ""))
    row.chk(bool(t) and len(t.get("clips", [])) == 1, "the pattern landed as one clip on that track", {"track": t.get("name"), "kit": t.get("drumKit")})
    if row.chk(wav.exists(), "offline render produced a WAV", str(wav)):
        st = V.stats(str(wav)); onsets = V.onsets_seconds(str(wav))
        row.artifacts.append(str(wav))
        row.chk(st["rms"] > 0.003 and st["peak"] > 0.05, "the render is not silent", st)
        row.chk(len([o for o in onsets if o < 2.1]) >= 6, "at least six distinct drum hits in the bar (kick/snare/hat grid)",
                {"onsets": [round(o, 3) for o in onsets[:16]]})
    row.chk(len(tracks(undone)) == len(tracks(base)), "one undo removes the track again",
            {"after_undo": len(tracks(undone))})
    return row


# ── V3-mix ──────────────────────────────────────────────────────────────────────────
def row_mix(ctx) -> Row:
    row = Row("V3-mix", "Mix: level, pan, mute, solo, 4OSC preset, send, zoom/drag", [
        "Whether the edits FEEL immediate at the desk (numbers below are the engine's cost, not the UI's).",
        "Zoom is a pure-UI gesture: proven by ui/e2e/v3-timeline.spec.ts on the mock, not here.",
    ])
    out = ctx.out / "mix"; out.mkdir(parents=True, exist_ok=True)
    w = lambda n: str(out / f"{n}.wav")

    # A. mixer edits on a DETERMINISTIC project (drums + a tone): sample-exact comparisons.
    #    4OSC is kept out of this project on purpose — its oscillators start at a random
    #    phase, so two renders of the same 4OSC project differ by ~0.16 RMS and would drown
    #    every "undo returns the baseline" check (measured 2026-09-19).
    cmds = [
        {"command": "add_drum_pattern", "args": {"pattern": DEFAULT_DRUM_BEAT, "name": "Drums", "start": 0}},
        {"command": "create_track", "args": {"name": "Vox"}, "capture": {"TV": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${TV}", "seconds": 2.0, "freq": 220.0}, "capture": {"CV": "clipId"}},
        {"command": "__snapshot", "args": {"label": "base"}},
        {"command": "export_audio", "args": {"file": w("00_base")}},
        {"command": "set_track_volume", "args": {"trackId": "${TV}", "db": -12.0}},
        {"command": "export_audio", "args": {"file": w("01_level")}},
        {"command": "undo"},
        {"command": "export_audio", "args": {"file": w("01_level_undone")}},
        {"command": "set_track_pan", "args": {"trackId": "${TV}", "pan": -1.0}},
        {"command": "export_audio", "args": {"file": w("02_pan")}},
        {"command": "undo"},
        {"command": "set_track_mute", "args": {"trackId": "${TV}", "mute": True}},
        {"command": "export_audio", "args": {"file": w("03_mute")}},
        {"command": "undo"},
        {"command": "set_track_solo", "args": {"trackId": "${TV}", "solo": True}},
        {"command": "export_audio", "args": {"file": w("04_solo")}},
        {"command": "undo"},
        {"command": "create_bus", "args": {"name": "Verb"}, "capture": {"B": "busNumber", "RT": "trackId"}},
        {"command": "load_builtin", "args": {"trackId": "${RT}", "type": "reverb"}, "capture": {"RV": "index"}},
        {"command": "set_plugin_param", "args": {"trackId": "${RT}", "index": "${RV}", "paramIndex": 0, "value": 0.95}},
        {"command": "set_plugin_param", "args": {"trackId": "${RT}", "index": "${RV}", "paramIndex": 2, "value": 1.0}},
        {"command": "add_send", "args": {"trackId": "${TV}", "bus": "${B}", "db": 0.0}},
        {"command": "__snapshot", "args": {"label": "send"}},
        {"command": "export_audio", "args": {"file": w("06_send")}},
        {"command": "set_send_level", "args": {"trackId": "${TV}", "bus": "${B}", "db": -100.0}},
        {"command": "export_audio", "args": {"file": w("06_send_off")}},
        {"command": "undo"}, {"command": "undo"}, {"command": "undo"}, {"command": "undo"}, {"command": "undo"}, {"command": "undo"},
        {"command": "move_clip", "args": {"clipId": "${CV}", "start": 1.0}},
        {"command": "__snapshot", "args": {"label": "moved"}},
        {"command": "export_audio", "args": {"file": w("07_moved")}},
        {"command": "undo"},
        {"command": "__snapshot", "args": {"label": "final"}},
        {"command": "export_audio", "args": {"file": w("08_final")}},
        {"command": "__bench_snapshot", "args": {"iterations": 20}},
    ]
    results, proc, _ = run_script(ctx.bin, cmds, f"v3-accept-mix-{ctx.pid}", out)
    row.artifacts += [str(out / f"v3-accept-mix-{ctx.pid}.results.jsonl")]
    if not row.chk(not failed(results) and proc.returncode == 0, "every mixer command ok", failed(results) or proc.stderr[-300:]):
        return row
    need = ["00_base", "01_level", "01_level_undone", "02_pan", "03_mute", "04_solo", "06_send", "06_send_off", "07_moved", "08_final"]
    if not row.chk(all(Path(w(n)).exists() for n in need), "every mixer render exists", [n for n in need if not Path(w(n)).exists()]):
        return row
    row.artifacts += [w(n) for n in need]
    base = V.stats(w("00_base"))
    row.chk(base["rms"] > 0.003, "baseline render is not silent", base)
    d = lambda n: round(V.diff_rms(w("00_base"), w(n)), 5)
    lvl = V.stats(w("01_level"))
    row.chk(d("01_level") > 0.003 and lvl["rms"] < base["rms"], "−12 dB on Vox makes the render quieter", {"diff": d("01_level"), "rms": lvl["rms"], "base_rms": base["rms"]})
    row.chk(d("01_level_undone") < 0.0005, "one undo returns the render to the baseline (level)", d("01_level_undone"))
    bl, br = stereo_rms(Path(w("00_base"))); pl, pr = stereo_rms(Path(w("02_pan")))
    row.chk(bl > 0 and abs(bl / max(br, 1e-9) - 1.0) < 0.15, "baseline is centred", {"L": round(bl, 5), "R": round(br, 5)})
    row.chk(pl / max(pr, 1e-9) > 1.25, "pan hard-left tilts the render to the left channel", {"L": round(pl, 5), "R": round(pr, 5)})
    mu = V.stats(w("03_mute"))
    row.chk(d("03_mute") > 0.003 and mu["rms"] < base["rms"], "mute removes Vox from the render", {"diff": d("03_mute"), "rms": mu["rms"]})
    row.chk(d("04_solo") > 0.003, "solo changes the render (only Vox remains)", d("04_solo"))
    sendsnap = snap(results, "send")
    tv = data_of(results, "create_track", 0).get("trackId", "")
    row.chk(len(track_by_id(sendsnap, tv).get("sends") or []) == 1, "the send shows on Vox in the snapshot", track_by_id(sendsnap, tv).get("sends"))
    row.chk(d("06_send") > 0.001 and d("06_send_off") < max(0.0005, d("06_send") * 0.1), "the send to the reverb bus is audible and −100 dB collapses it",
            {"wet": d("06_send"), "off": d("06_send_off")})
    cv = data_of(results, "import_clip").get("clipId", "")   # add_test_tone_clip reports as import_clip
    moved = snap(results, "moved")
    row.chk(abs(float(clip_by_id(moved, cv).get("start", -1)) - 1.0) < 1e-6, "move_clip puts the clip at 1.0 s in the snapshot", clip_by_id(moved, cv).get("start"))
    mv = V.stats(w("07_moved"))
    row.chk(mv["duration_s"] > base["duration_s"] + 0.8, "the moved clip extends the render by ~1 s", {"base": base["duration_s"], "moved": mv["duration_s"]})
    row.chk(d("08_final") < 0.0005, "after every undo the render equals the baseline", d("08_final"))
    row.chk(projection(snap(results, "final")) == projection(snap(results, "base")), "after every undo the snapshot projection equals the baseline")
    bench = data_of(results, "__bench_snapshot")
    row.chk(float(bench.get("avgMs", 1e9)) < 100.0, "snapshot() costs under 100 ms (feel budget, engine side)", bench)

    # B. the native instrument: insert 4OSC, pick a bundled preset, undo. Spectral metrics,
    #    because 4OSC's random start phase makes sample-exact comparison meaningless.
    preset = four_osc_preset_file(ctx.bin)
    row.chk(preset is not None, "a bundled 4OSC preset exists in the app bundle", str(preset))
    notes = [{"pitch": 60 + i * 3, "start": i * 0.5, "length": 0.45, "velocity": 100} for i in range(4)]
    cmds_b = [
        {"command": "create_track", "args": {"name": "Keys"}, "capture": {"TK": "trackId"}},
        {"command": "load_builtin", "args": {"trackId": "${TK}", "type": "4osc"}, "capture": {"PK": "index"}},
        {"command": "add_midi_clip", "args": {"trackId": "${TK}", "length": 2.0, "notes": notes}},
        {"command": "__snapshot", "args": {"label": "base"}},
        {"command": "export_audio", "args": {"file": w("10_keys")}},
        {"command": "load_preset", "args": {"trackId": "${TK}", "index": "${PK}", "file": str(preset)}},
        {"command": "__snapshot", "args": {"label": "preset"}},
        {"command": "export_audio", "args": {"file": w("11_keys_preset")}},
        {"command": "undo"},
        {"command": "__snapshot", "args": {"label": "undone"}},
        {"command": "export_audio", "args": {"file": w("12_keys_undone")}},
    ]
    rb, pb, _ = run_script(ctx.bin, cmds_b, f"v3-accept-keys-{ctx.pid}", out)
    row.artifacts += [str(out / f"v3-accept-keys-{ctx.pid}.results.jsonl")]
    if row.chk(not failed(rb) and pb.returncode == 0 and all(Path(w(n)).exists() for n in ("10_keys", "11_keys_preset", "12_keys_undone")),
               "4OSC insert / preset / undo commands ok and rendered", failed(rb) or pb.stderr[-300:]):
        row.artifacts += [w(n) for n in ("10_keys", "11_keys_preset", "12_keys_undone")]
        feats = {n: V.wav_features(w(n)) for n in ("10_keys", "11_keys_preset", "12_keys_undone")}
        row.chk(feats["10_keys"]["rms"] > 0.003, "4OSC plays the MIDI clip (non-silent render)", feats["10_keys"])
        c0, c1, c2 = (feats[n]["centroid_hz"] for n in ("10_keys", "11_keys_preset", "12_keys_undone"))
        row.chk(abs(c1 - c0) / max(c0, 1.0) > 0.05 or abs(feats["11_keys_preset"]["rms"] - feats["10_keys"]["rms"]) / max(feats["10_keys"]["rms"], 1e-9) > 0.1,
                "the preset changes the Keys timbre (spectral centroid or level moves by > 5 % / 10 %)",
                {"centroid_hz": [round(c0), round(c1), round(c2)], "rms": [feats[n]["rms"] for n in ("10_keys", "11_keys_preset", "12_keys_undone")], "preset": preset.name if preset else None})
        row.chk(abs(c2 - c0) / max(c0, 1.0) < 0.03, "one undo returns the Keys timbre to the baseline (centroid within 3 %)", {"centroid_hz": [round(c0), round(c2)]})
        pj = lambda s: [{k: v for k, v in t.items() if k != "id"} for t in projection(s)]
        row.chk(pj(snap(rb, "undone")) == pj(snap(rb, "base")), "after undo the Keys snapshot projection equals the baseline")

    # C. command latency: forty cheap edits, wall-clocked in a second process
    lat = [{"command": "create_track", "args": {"name": "Lat"}, "capture": {"T": "trackId"}}]
    for i in range(40):
        lat.append({"command": "set_track_volume", "args": {"trackId": "${T}", "db": -1.0 * (i % 6)}})
    r2, p2, secs = run_script(ctx.bin, lat, f"v3-accept-latency-{ctx.pid}", out)
    per = (secs * 1000.0) / max(1, len(lat))
    row.chk(not failed(r2) and per < 250.0, "forty mixer edits average under 250 ms each INCLUDING process launch (upper bound on engine latency)",
            {"ms_per_command_upper_bound": round(per, 1), "process_seconds": round(secs, 2)})
    return row


# ── V3-file ─────────────────────────────────────────────────────────────────────────
def row_file(ctx) -> Row:
    row = Row("V3-file", "Save, close, reopen, export; import a .mid", [
        "Whether the export PLAYS right in another app / on speakers (the WAV is checked for content, not listened to).",
    ])
    out = ctx.out / "file"; out.mkdir(parents=True, exist_ok=True)
    song, mixdown, riff = out / "song.mosh", out / "mixdown.wav", out / "riff.mid"
    write_smf(riff, [(60, 0, 240), (64, 480, 240), (67, 960, 240), (72, 1440, 480)])
    notes = [{"pitch": 60 + i * 3, "start": i * 0.5, "length": 0.45, "velocity": 100} for i in range(4)]
    cmds = [
        {"command": "add_drum_pattern", "args": {"pattern": DEFAULT_DRUM_BEAT, "name": "Drums", "start": 0}},
        {"command": "create_track", "args": {"name": "Keys"}, "capture": {"TK": "trackId"}},
        {"command": "load_builtin", "args": {"trackId": "${TK}", "type": "4osc"}},
        {"command": "add_midi_clip", "args": {"trackId": "${TK}", "length": 2.0, "notes": notes}},
        {"command": "create_track", "args": {"name": "Vox"}, "capture": {"TV": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${TV}", "seconds": 2.0, "freq": 220.0}},
        {"command": "set_track_volume", "args": {"trackId": "${TV}", "db": -6.0}},
        {"command": "__snapshot", "args": {"label": "before"}},
        {"command": "save_as", "args": {"file": str(song)}},
        {"command": "new_project", "args": {"name": "scratch"}},
        {"command": "__snapshot", "args": {"label": "empty"}},
        {"command": "open_project", "args": {"file": str(song)}},
        {"command": "__snapshot", "args": {"label": "reopened"}},
        {"command": "export_audio", "args": {"file": str(mixdown)}},
        {"command": "import_midi_file", "args": {"file": str(riff)}, "capture": {"MC": "clipId", "MT": "trackId"}},
        {"command": "__snapshot", "args": {"label": "imported"}},
        {"command": "undo"},
        {"command": "__snapshot", "args": {"label": "importundone"}},
    ]
    results, proc, _ = run_script(ctx.bin, cmds, f"v3-accept-file-{ctx.pid}", out)
    row.artifacts += [str(out / f"v3-accept-file-{ctx.pid}.results.jsonl")]
    if not row.chk(not failed(results) and proc.returncode == 0, "every command ok", failed(results) or proc.stderr[-300:]):
        return row
    before, empty, reopened = snap(results, "before"), snap(results, "empty"), snap(results, "reopened")
    row.chk(song.exists(), "save_as wrote the project file", str(song)); row.artifacts.append(str(song))
    row.chk(len(tracks(empty)) < len(tracks(before)), "new_project actually cleared the session (anti-vacuity for the reopen)",
            {"before": len(tracks(before)), "empty": len(tracks(empty))})
    row.chk(projection(reopened) == projection(before), "reopen reproduces the project projection (names, clips, plugins, mixer)",
            None if projection(reopened) == projection(before) else {"before": projection(before), "reopened": projection(reopened)})
    if row.chk(mixdown.exists(), "export_audio wrote the mixdown", str(mixdown)):
        st = V.stats(str(mixdown)); row.artifacts.append(str(mixdown))
        row.chk(st["rms"] > 0.003 and 1.5 < st["duration_s"] < 6.0, "the mixdown is non-silent and the project's length", st)
    imp = data_of(results, "import_midi_file")
    imported, undone = snap(results, "imported"), snap(results, "importundone")
    row.chk(int(imp.get("noteCount", 0)) == 4, "import_midi_file read all four notes", imp)
    row.chk(bool(clip_by_id(imported, imp.get("clipId", ""))), "the .mid landed as one clip in the snapshot",
            clip_by_id(imported, imp.get("clipId", "")).get("name"))
    row.chk(not clip_by_id(undone, imp.get("clipId", "")), "one undo removes the imported clip")
    return row


# ── V3-vocal ────────────────────────────────────────────────────────────────────────
def row_vocal(ctx) -> Row:
    row = Row("V3-vocal", "Arm, count-in 1 bar, two takes in the Booth, Keep, undo", [
        "Sing into a real mic and listen back: audibility, monitoring feel, and latency at the desk.",
        "The Booth's buttons drive exactly these commands (ui/e2e/v3-record.spec.ts on the mock); this row proves the engine under them.",
    ])
    out = ctx.out / "vocal"; out.mkdir(parents=True, exist_ok=True)
    devices = subprocess.run(["system_profiler", "SPAudioDataType"], capture_output=True, text=True).stdout
    if LOOPBACK_DEVICE not in devices:
        row.blocked = f'loopback device "{LOOPBACK_DEVICE}" not present (install BlackHole)'
        return row
    leaf = f"v3-accept-vocal-{ctx.pid}"
    reset_owned_harness_session(_session_dir(leaf))
    env = dict(os.environ)
    env.pop("CI", None)   # CI=true opens the JUCE device output-only
    env.update({"MOSH_AUDIO_OUTPUT_DEVICE": LOOPBACK_DEVICE, "MOSH_AUDIO_INPUT_DEVICE": LOOPBACK_DEVICE,
                "MOSH_SELFTEST_SESSION": f"_harness/{leaf}", "MOSH_ENABLE_SA3": "0"})
    try:
        proc = subprocess.run([str(ctx.bin), "--v3-vocal-smoke", "-ApplePersistenceIgnoreState", "YES"],
                              env=env, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired as e:
        row.chk(False, "the smoke finished within 180 s", str(e)); return row
    (out / "v3-vocal-smoke.log").write_text((proc.stdout or "") + "\n--- stderr ---\n" + (proc.stderr or ""))
    row.artifacts.append(str(out / "v3-vocal-smoke.log"))
    summary = {}
    for line in (proc.stdout or "").splitlines():
        if line.startswith("V3-VOCAL-SMOKE: "):
            try:
                summary = json.loads(line[len("V3-VOCAL-SMOKE: "):])
            except json.JSONDecodeError:
                pass
    failed_lines = [l for l in (proc.stderr or "").splitlines() if "FAIL" in l][:12]
    row.chk(proc.returncode == 0 and summary and int(summary.get("failures", 1)) == 0,
            f"Mosh --v3-vocal-smoke passed every check ({summary.get('checks', '?')} checks) on {LOOPBACK_DEVICE}",
            {"rc": proc.returncode, "summary": summary, "failed": failed_lines})
    for key in ("take1", "take2"):
        src = Path(summary.get(key) or "/nonexistent")
        if src.is_file():
            dst = out / f"{key}.wav"; shutil.copy2(src, dst); row.artifacts.append(str(dst))
            st = V.stats(str(dst))
            row.chk(st["rms"] > 0.001, f"{key} copied to evidence and is non-silent", st)
        else:
            row.chk(False, f"{key} WAV exists on disk", str(src))
    if summary:
        ms = lambda k: round(float(summary.get(k) or 0.0), 2)
        row.notes.append(f"calibrated loopback {ms('calibratedMs')} ms, landing tolerance {ms('toleranceMs')} ms; "
                         f"take1 (count-in) landed {ms('take1OffsetMs')} ms from the guide, take2 (Again, no count-in) "
                         f"{ms('take2OffsetMs')} ms — a count-in landing is up to one device block early (engine follow-up)")
    return row


# ── V3-mp ───────────────────────────────────────────────────────────────────────────
def row_mp(ctx) -> Row:
    row = Row("V3-mp", "Two peers: invite, join, claim a track, edit, leave", [
        "A second PHYSICAL Mac on another network path (this run is two processes on one Mac).",
        "Whether the ~1 s propagation feels live at the desk.",
    ])
    out = ctx.out / "mp"; out.mkdir(parents=True, exist_ok=True)
    # The dry run defaults to relay port 8798, which another harness (or a stale relay) can
    # hold — bind refused silently reads as "A never produced a room code". Pick a free one.
    env = dict(os.environ); env.update({"MOSH_BIN": str(ctx.bin), "TAKE_SECONDS": "30", "ART": str(out / "dry-run"),
                                        "PORT": V._service_port(8798)})
    row.notes.append(f"local relay on 127.0.0.1:{env['PORT']}")
    try:
        proc = subprocess.run(["bash", str(REPO / "scripts/playtest/mp-two-window-dry-run.sh")], env=env,
                              capture_output=True, text=True, timeout=420, cwd=str(REPO))
    except subprocess.TimeoutExpired as e:
        row.chk(False, "two-window dry run finished within 420 s", str(e)); return row
    (out / "two-window-dry-run.log").write_text(proc.stdout + "\n--- stderr ---\n" + proc.stderr)
    row.artifacts.append(str(out / "two-window-dry-run.log"))
    verdict = [l for l in proc.stdout.splitlines() if l.startswith("PASS:") or l.startswith("FAIL")]
    row.chk(proc.returncode == 0 and any(l.startswith("PASS:") for l in verdict),
            "two real Mosh processes over the local relay: create/join, claim→commit, bus, group, late-join bootstrap, multi-second take identical on the peer",
            {"rc": proc.returncode, "verdict": verdict[:6] or proc.stdout[-600:]})
    if ctx.cloud:
        env2 = dict(os.environ); env2.update({"MOSH_BIN": str(ctx.bin), "ART": str(out / "cloud-smoke")})
        try:
            p2 = subprocess.run(["bash", str(REPO / "scripts/playtest/mp-live-smoke.sh")], env=env2,
                                capture_output=True, text=True, timeout=420, cwd=str(REPO))
            (out / "cloud-smoke.log").write_text(p2.stdout + "\n--- stderr ---\n" + p2.stderr)
            row.artifacts.append(str(out / "cloud-smoke.log"))
            row.chk(p2.returncode == 0, "two real Mosh processes over the CLOUD relay (the playtest path)", {"rc": p2.returncode, "tail": p2.stdout[-400:]})
        except subprocess.TimeoutExpired as e:
            row.chk(False, "cloud-relay smoke finished within 420 s", str(e))
    else:
        row.notes.append("cloud relay not exercised (pass --cloud); the local relay is the same protocol on 127.0.0.1")
    return row


# ── V3-feel ─────────────────────────────────────────────────────────────────────────
def row_feel(ctx) -> Row:
    row = Row("V3-feel", "Every V3 surface in every colorway", [
        "Ten minutes of ORDINARY use per colorway at the desk — flip the PNGs first; if one looks wrong, that is the ten minutes.",
        "The screenshots are the dev lane (Chromium + mock backend), the same React code the native WebView renders.",
    ])
    out = ctx.out / "feel"; out.mkdir(parents=True, exist_ok=True)
    screens = out / "screens"; screens.mkdir(exist_ok=True)
    env = dict(os.environ); env.update({"V3_ACCEPT_OUT": str(screens), "CI": "1"})
    report = out / "playwright-v3.json"
    try:
        proc = subprocess.run(["npx", "playwright", "test", "e2e/v3-", "--project=chromium", "--reporter=json"],
                              env=env, capture_output=True, text=True, timeout=1500, cwd=str(REPO / "ui"))
    except subprocess.TimeoutExpired as e:
        row.chk(False, "the V3 Playwright suite finished within 25 min", str(e)); return row
    (out / "playwright-v3.stderr.log").write_text(proc.stderr[-20000:])
    stats = {}
    try:
        data = json.loads(proc.stdout[proc.stdout.index("{"):])
        report.write_text(json.dumps(data, indent=1)); stats = data.get("stats", {})
    except (ValueError, json.JSONDecodeError):
        (out / "playwright-v3.stdout.log").write_text(proc.stdout[-20000:])
    row.artifacts += [str(report)]
    expected, unexpected = int(stats.get("expected", 0)), int(stats.get("unexpected", 0))
    row.chk(proc.returncode == 0 and unexpected == 0 and expected >= 40,
            f"the whole V3 suite is green ({expected} passed, {unexpected} failed)", {"rc": proc.returncode, "stats": stats})
    pngs = sorted(screens.glob("*.png"))
    row.artifacts += [str(p) for p in pngs]
    row.chk(len(pngs) >= 32, "eight surfaces × four colorways screenshotted", {"count": len(pngs), "first": [p.name for p in pngs[:4]]})
    return row


# ── report ──────────────────────────────────────────────────────────────────────────
def write_report(ctx, rows: list[Row]) -> None:
    # A partial run (--only / --skip) updates its rows in place and keeps the others from the
    # previous rows.json, so REPORT.md always describes the whole directory.
    prior = []
    try:
        prior = json.loads((ctx.out / "rows.json").read_text())
    except (OSError, json.JSONDecodeError):
        pass
    ran = {r.id for r in rows}
    kept = [p for p in prior if p.get("id") not in ran]
    if kept:
        for p in kept:
            k = Row(p["id"], p.get("title", ""), p.get("owner", []))
            k.checks, k.artifacts, k.blocked = p.get("checks", []), p.get("artifacts", []), p.get("blocked")
            k.notes = p.get("notes", []) + ["(from an earlier run in this directory; not re-run now)"]
            rows.append(k)
        rows.sort(key=lambda r: list(ROWS).index(r.id.replace("V3-", "")) if r.id.replace("V3-", "") in ROWS else 99)
    lines = [f"# V3 default-shell acceptance — automated evidence, {STAMP}", "",
             f"- repo `{REPO}` @ `{ctx.commit}`", f"- binary `{ctx.bin}` (built {ctx.bin_built})",
             f"- rows: {', '.join(r.id for r in rows)}; loopback device `{LOOPBACK_DEVICE}`", "",
             "Every check below would read differently if the feature were absent (vacuous-tests rule). ",
             "The *owner* column is what no machine can close; each is minutes with the artifacts here, not a session.", "",
             "| row | automated | checks | owner still owes |", "| --- | --- | --- | --- |"]
    for r in rows:
        state = "BLOCKED: " + r.blocked if r.blocked else ("PASS" if r.passed else "FAIL")
        n_ok = sum(1 for c in r.checks if c["ok"])
        lines.append(f"| {r.id} | {state} | {n_ok}/{len(r.checks)} | " + "<br>".join(r.owner) + " |")
    for r in rows:
        lines += ["", f"## {r.id} — {r.title}", ""]
        if r.blocked:
            lines.append(f"**BLOCKED:** {r.blocked}")
        for c in r.checks:
            det = "" if c["detail"] in (None, "", [], {}) else f"  \n  `{json.dumps(c['detail'], default=str)[:400]}`"
            lines.append(f"- {'✅' if c['ok'] else '❌'} {c['what']}{det}")
        for n in r.notes:
            lines.append(f"- ℹ️ {n}")
        if r.artifacts:
            lines += ["", "artifacts:", ""] + [f"- `{a}`" for a in r.artifacts[:60]]
        lines += ["", "owner residual:", ""] + [f"- {o}" for o in r.owner]
    (ctx.out / "REPORT.md").write_text("\n".join(lines) + "\n")
    (ctx.out / "rows.json").write_text(json.dumps([r.to_json() for r in rows], indent=1, default=str))


class Ctx:
    pass


ROWS = {"beat": row_beat, "mix": row_mix, "file": row_file, "vocal": row_vocal, "mp": row_mp, "feel": row_feel}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", help="Mosh binary (default: newest local build)")
    ap.add_argument("--out", help="evidence directory (default ~/Library/Mosh/task-evidence/<date>-v3-acceptance)")
    ap.add_argument("--only", help="comma list of rows: beat,mix,file,vocal,mp,feel")
    ap.add_argument("--skip", help="comma list of rows to skip")
    ap.add_argument("--cloud", action="store_true", help="also run the cloud-relay multiplayer smoke")
    args = ap.parse_args()

    ctx = Ctx()
    ctx.bin = Path(args.bin) if args.bin else V.find_binary()
    ctx.bin_built = dt.datetime.fromtimestamp(ctx.bin.stat().st_mtime).isoformat(timespec="seconds")
    ctx.commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    ctx.out = Path(args.out) if args.out else Path.home() / "Library" / "Mosh" / "task-evidence" / f"{STAMP}-v3-acceptance"
    ctx.out.mkdir(parents=True, exist_ok=True)
    ctx.cloud = args.cloud
    ctx.pid = os.getpid()
    selected = [k for k in ROWS if (not args.only or k in args.only.split(",")) and not (args.skip and k in args.skip.split(","))]
    print(f"v3-acceptance: binary {ctx.bin} (built {ctx.bin_built}), commit {ctx.commit}\n  evidence → {ctx.out}\n  rows: {selected}")
    (ctx.out / "env.json").write_text(json.dumps({"binary": str(ctx.bin), "built": ctx.bin_built, "commit": ctx.commit,
                                                  "date": dt.datetime.now().isoformat(timespec="seconds"), "rows": selected,
                                                  "loopback": LOOPBACK_DEVICE, "cloud": args.cloud}, indent=1))
    rows: list[Row] = []
    for key in selected:
        t0 = time.monotonic()
        print(f"── {key} …", flush=True)
        try:
            row = ROWS[key](ctx)
        except Exception as e:  # a harness bug is a FAIL with a reason, never a silent skip
            row = Row(f"V3-{key}", key, []); row.chk(False, "harness ran without raising", repr(e))
        rows.append(row)
        state = "BLOCKED" if row.blocked else ("PASS" if row.passed else "FAIL")
        print(f"   {row.id}: {state} ({sum(c['ok'] for c in row.checks)}/{len(row.checks)} checks, {time.monotonic() - t0:.0f}s)")
        for c in row.checks:
            if not c["ok"]:
                print(f"     ✗ {c['what']}: {json.dumps(c['detail'], default=str)[:300]}")
        if row.blocked:
            print(f"     blocked: {row.blocked}")
    write_report(ctx, rows)
    ok = all(r.passed for r in rows)
    print(f"\nv3-acceptance: {'PASS' if ok else 'FAIL'} — {ctx.out / 'REPORT.md'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
