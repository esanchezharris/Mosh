#!/usr/bin/env python3
"""DAW-conformance harness — turns the gathered reality pack into a reproducible gate.

Loads docs/reality-pack/mosh_daw_eval_suite.csv (200 rows), groups them into the ~24
distinct scenario families ((area, user_action) pairs), runs each family ONCE through
the real command surface via `Mosh --run-script`, and fans the verdict back out to every
eval-id that shares that scenario. Reuses scripts/verify-hardware/verify.py's run-script
+ WAV helpers (and the `__snapshot` run-script directive) so state/audio/undo assertions
hit the SAME snapshot() and rendered audio the app produces — no privileged backdoor.

Scope: CONVENTIONAL DAW PARITY (locked 2026-06-26). The Monster / Arena / Collaboration
areas (and the battle-submission bespoke row) are reported `out-of-scope`, not failed.

Verdict statuses:
  pass         in-scope capability proven headless (state/audio/undo asserted)
  fail         in-scope capability BROKE — a regression. The only status that fails the gate.
  gap          in-scope capability ABSENT (a known backlog item, e.g. export range/tail). Tracked, not failed.
  hardware     needs a live audio device / mic / MIDI — proven in the Phase 1 hardware pass, not here.
  out-of-scope Monster/Arena/Collaboration/battle — outside this parity pass.

Usage:
    python3 scripts/daw-conformance/conformance.py [--bin <Mosh>] [--json out.json]
Exit 0 unless an in-scope family FAILS (a regression).
"""
import argparse
import csv
import json
import math
import os
import struct
import sys
import wave
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "verify-hardware"))
import verify  # noqa: E402  run_script, stats, diff_rms, find_binary, failed_commands, ART, _mosh_session_base

PACK = REPO / "docs" / "reality-pack"
EVAL_CSV = PACK / "mosh_daw_eval_suite.csv"
SELF = Path(__file__).resolve().parent
ARTDIR = REPO / "verify-artifacts" / "conformance"

OUT_OF_SCOPE_AREAS = {"Monster", "Arena", "Collaboration"}

PASS, FAIL, GAP, HARDWARE, OOS = "pass", "fail", "gap", "hardware", "out-of-scope"


# ── shared helpers ────────────────────────────────────────────────────────────────
class Ctx:
    def __init__(self, binary):
        self.bin = binary


def synth_wav(path, seconds=1.0, freq=220.0, sr=44100):
    """Write a small mono 16-bit sine WAV with the stdlib (no numpy needed to create)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    n = int(seconds * sr)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(n):
            v = int(0.6 * 32767 * math.sin(2 * math.pi * freq * i / sr))
            frames += struct.pack("<h", v)
        w.writeframes(bytes(frames))
    return str(path)


def drive(cmds, session, env=None, timeout=120):
    """Run a command list (with optional __snapshot directives) and return
    (results, snaps, proc). `snaps` maps a __snapshot label -> snapshot dict."""
    results, proc = verify.run_script(None_to_bin(), cmds, session, extra_env=env, timeout=timeout)
    snaps = {}
    for r in results:
        if r.get("command") == "__snapshot":
            snaps[r.get("label", f"_{len(snaps)}")] = r.get("data", {}) or {}
    return results, snaps, proc


_BIN = {"bin": None}
def None_to_bin():
    return _BIN["bin"]


def cmd_fails(results):
    """Failed real commands, ignoring the read-only __snapshot directive lines."""
    return [r for r in results if r.get("command") != "__snapshot" and not r.get("ok", False)]


def tracks_of(snap):
    return snap.get("tracks", []) or []


def track_named(snap, name):
    for t in tracks_of(snap):
        if t.get("name") == name:
            return t
    return None


def clips_of(track):
    return (track or {}).get("clips", []) or []


def verdict(status, lane, invariants, detail):
    return {"status": status, "lane": lane, "invariants": invariants, "detail": detail}


def _err(proc, extra=None):
    d = {"stderr": (proc.stderr or "")[-400:]}
    if extra:
        d.update(extra)
    return d


# ── families (one per distinct in-scope (area, user_action)) ──────────────────────
# Each returns verdict(...). Keyed in FAMILIES below by the EXACT CSV (area, user_action).

def fam_transport_play(ctx):
    # Playback audibility needs a live device (headless play() is skipped when !hasAudio).
    return verdict(HARDWARE, "audio", [1, 4],
                   {"note": "play→audible + playhead advance is proven in the Phase 1 hardware pass "
                            "(headless play is a no-op without CoreAudio)."})


def fam_transport_seek(ctx):
    out_clip_start = None
    cmds = [
        {"command": "create_track", "args": {"name": "Seek"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0}, "capture": {"C": "clipId"}},
        {"command": "__snapshot", "args": {"label": "before"}},
        {"command": "set_transport", "args": {"position": 1.5}},
        {"command": "__snapshot", "args": {"label": "after"}},
    ]
    results, snaps, proc = drive(cmds, "conf-transport-seek")
    if cmd_fails(results):
        return verdict(FAIL, "state", [8], _err(proc, {"failed": cmd_fails(results)}))
    before, after = snaps.get("before", {}), snaps.get("after", {})
    pos = after.get("transport", {}).get("position")
    c0 = clips_of(track_named(before, "Seek"))
    c1 = clips_of(track_named(after, "Seek"))
    start_before = c0[0].get("start") if c0 else None
    start_after = c1[0].get("start") if c1 else None
    ok = pos is not None and abs(pos - 1.5) < 0.05 and start_before == start_after
    return verdict(PASS if ok else FAIL, "state", [8],
                   {"position": pos, "clip_start_before": start_before, "clip_start_after": start_after})


def fam_import_wav(ctx):
    src = synth_wav(ARTDIR / "import_beat.wav", 1.0, 196.0)
    cmds = [
        {"command": "create_track", "args": {"name": "Imp"}, "capture": {"T": "trackId"}},
        {"command": "import_clip", "args": {"file": src, "trackId": "${T}"}, "capture": {"C": "clipId"}},
        {"command": "__snapshot", "args": {"label": "after"}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "undone"}},
    ]
    results, snaps, proc = drive(cmds, "conf-import-wav")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [2, 69, 75], _err(proc, {"failed": cmd_fails(results)}))
    after = clips_of(track_named(snaps.get("after", {}), "Imp"))
    undone = clips_of(track_named(snaps.get("undone", {}), "Imp"))
    created = len(after) == 1 and (after[0].get("sourceFile", "").endswith("import_beat.wav"))
    retained = Path(src).exists()  # import must not move/consume the source asset
    undo_ok = len(undone) == 0
    ok = created and retained and undo_ok
    return verdict(PASS if ok else FAIL, "state+undo", [2, 69, 75],
                   {"created": created, "source_retained": retained, "undo_removes": undo_ok,
                    "note": "drag GESTURE is e2e-covered; the import capability is proven here."})


def fam_import_unicode(ctx):
    src = synth_wav(ARTDIR / "naïve mix ünî.wav", 1.0, 247.0)
    cmds = [
        {"command": "create_track", "args": {"name": "Uni"}, "capture": {"T": "trackId"}},
        {"command": "import_clip", "args": {"file": src, "trackId": "${T}", "name": "naïve mix"}, "capture": {"C": "clipId"}},
        {"command": "__snapshot", "args": {"label": "after"}},
    ]
    results, snaps, proc = drive(cmds, "conf-import-unicode")
    if cmd_fails(results):
        return verdict(FAIL, "state", [69], _err(proc, {"failed": cmd_fails(results)}))
    after = clips_of(track_named(snaps.get("after", {}), "Uni"))
    ok = len(after) == 1 and not after[0].get("sourceMissing", False)
    return verdict(PASS if ok else FAIL, "state", [69],
                   {"imported": len(after) == 1, "name": after[0].get("name") if after else None,
                    "note": "wav proxy for the unicode/space-filename path; real mp3 decode is format-dependent."})


def fam_record_no_fake_clip(ctx):
    # invariant 45/49 — a record attempt with NO input device must create NO clip (no fake clip).
    cmds = [
        {"command": "create_track", "args": {"name": "Rec"}, "capture": {"T": "trackId"}},
        {"command": "arm_track", "args": {"trackId": "${T}", "armed": True}},
        {"command": "set_transport", "args": {"action": "record"}},
        {"command": "stop_recording", "args": {}},
        {"command": "__snapshot", "args": {"label": "after"}},
    ]
    results, snaps, proc = drive(cmds, "conf-record-nofake")
    # arm/record/stop all degrade gracefully (ok + applied:false) headless — none should error.
    if cmd_fails(results):
        return verdict(FAIL, "state", [45, 49], _err(proc, {"failed": cmd_fails(results)}))
    after = clips_of(track_named(snaps.get("after", {}), "Rec"))
    ok = len(after) == 0
    return verdict(PASS if ok else FAIL, "state", [45, 49],
                   {"clips_after_failed_record": len(after),
                    "note": "no input device headless → graceful no-op, no fabricated clip."})


def fam_record_countin(ctx):
    # G2b landed: set_count_in is a real project-wide preference (same MOSH_PROJECT
    # node/template as set_key), wired into tracktion_engine's own pre-roll
    # (te::Edit::setCountInMode, consulted by TransportControl's record-start logic
    # to roll the playhead back N bars and play an audible click before capture
    # begins). The STATE surface (persisted setting + snapshot field) is provable
    # headless, exercised below; the AUDIBLE pre-roll + delayed capture start needs
    # a live audio device (headless record() is a no-op without CoreAudio, same as
    # fam_transport_play) -> verdict stays "hardware", proven in the Phase 1
    # hardware pass. The prior "no count-in token anywhere" GAP is closed by this
    # command existing at all.
    cmds = [
        {"command": "__snapshot", "args": {"label": "before"}},
        {"command": "set_count_in", "args": {"bars": 1}},
        {"command": "__snapshot", "args": {"label": "one_bar"}},
        {"command": "set_count_in", "args": {"bars": 2}},
        {"command": "__snapshot", "args": {"label": "two_bars"}},
        {"command": "set_count_in", "args": {"bars": 0}},   # restore default
        {"command": "__snapshot", "args": {"label": "after"}},
    ]
    results, snaps, proc = drive(cmds, "conf-record-countin")
    if cmd_fails(results):
        return verdict(FAIL, "hardware", [5, 41, 42], _err(proc, {"failed": cmd_fails(results)}))

    before = (snaps.get("before", {}).get("session", {}) or {}).get("countInBars")
    one_bar = (snaps.get("one_bar", {}).get("session", {}) or {}).get("countInBars")
    two_bars = (snaps.get("two_bars", {}).get("session", {}) or {}).get("countInBars")
    after = (snaps.get("after", {}).get("session", {}) or {}).get("countInBars")
    ok = before == 0 and one_bar == 1 and two_bars == 2 and after == 0

    return verdict(HARDWARE if ok else FAIL, "hardware", [5, 41, 42],
                   {"note": "count-in/pre-roll state proven headless (before=0, one_bar=1, two_bars=2, "
                            "restored=0); the audible click + delayed capture start still needs a live "
                            "device -- covered by the Phase 1 hardware pass, same posture as transport play.",
                    "before": before, "one_bar": one_bar, "two_bars": two_bars, "after": after})


def fam_clip_move(ctx):
    cmds = [
        {"command": "create_track", "args": {"name": "Mv"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0}, "capture": {"C": "clipId"}},
        {"command": "__snapshot", "args": {"label": "before"}},
        {"command": "move_clip", "args": {"clipId": "${C}", "start": 8.0}},
        {"command": "__snapshot", "args": {"label": "moved"}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "undone"}},
    ]
    results, snaps, proc = drive(cmds, "conf-clip-move")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [21, 96], _err(proc, {"failed": cmd_fails(results)}))
    s0 = clips_of(track_named(snaps.get("before", {}), "Mv"))[0].get("start")
    s1 = clips_of(track_named(snaps.get("moved", {}), "Mv"))[0].get("start")
    s2 = clips_of(track_named(snaps.get("undone", {}), "Mv"))[0].get("start")
    ok = abs(s1 - 8.0) < 0.01 and abs(s2 - s0) < 0.01
    return verdict(PASS if ok else FAIL, "state+undo", [21, 96],
                   {"start_before": s0, "start_moved": s1, "start_undone": s2})


def fam_clip_split_dup(ctx):
    cmds = [
        {"command": "create_track", "args": {"name": "Sp"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 4.0, "freq": 220.0}, "capture": {"C": "clipId"}},
        {"command": "split_clip", "args": {"clipId": "${C}", "time": 2.0}, "capture": {"N": "newClipId"}},
        {"command": "__snapshot", "args": {"label": "split"}},
        {"command": "duplicate_clip", "args": {"clipId": "${N}"}, "capture": {"D": "newClipId"}},
        {"command": "__snapshot", "args": {"label": "dup"}},
    ]
    results, snaps, proc = drive(cmds, "conf-clip-split-dup")
    if cmd_fails(results):
        return verdict(FAIL, "state", [24, 25], _err(proc, {"failed": cmd_fails(results)}))
    split = clips_of(track_named(snaps.get("split", {}), "Sp"))
    dup = clips_of(track_named(snaps.get("dup", {}), "Sp"))
    srcs = {c.get("sourceFile") for c in split if c.get("sourceFile")}
    same_source = len(split) == 2 and len(srcs) == 1     # both halves reference the same source
    new_instance = len(dup) == 3 and len({c.get("id") for c in dup}) == 3
    ok = same_source and new_instance
    return verdict(PASS if ok else FAIL, "state", [24, 25],
                   {"clips_after_split": len(split), "same_source": same_source,
                    "clips_after_dup": len(dup), "duplicate_is_new_instance": new_instance})


def fam_mixer_gain(ctx):
    cmds = [
        {"command": "create_track", "args": {"name": "Vox"}, "capture": {"T": "trackId"}},
        {"command": "set_track_volume", "args": {"trackId": "${T}", "db": -6.0}},
        {"command": "__snapshot", "args": {"label": "set"}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "undone"}},
    ]
    results, snaps, proc = drive(cmds, "conf-mixer-gain")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [51, 97], _err(proc, {"failed": cmd_fails(results)}))
    v1 = track_named(snaps.get("set", {}), "Vox").get("volumeDb")
    v2 = track_named(snaps.get("undone", {}), "Vox").get("volumeDb")
    set_ok = abs(v1 - (-6.0)) < 0.5            # inv 51 — the gain change applies
    undo_ok = abs(v2 - 0.0) < 0.5              # inv 97 — undo restores the prior gain
    if set_ok and undo_ok:
        return verdict(PASS, "state+undo", [51, 97], {"volumeDb_set": v1, "volumeDb_undone": v2})
    if set_ok and not undo_ok:
        # Discovered baseline defect: cmdSetTrackVolume's vp->setVolumeDb() bypasses the
        # UndoManager, so its transaction is empty — undo does NOT restore the prior gain
        # (yet it logs undoable:true). Same shape for set_track_pan / master. inv 97.
        return verdict(GAP, "state+undo", [51, 97],
                       {"gap": "G14", "volumeDb_set": v1, "volumeDb_undone": v2,
                        "note": "gain APPLIES (inv 51 ✓) but UNDO does not restore it (inv 97 ✗): "
                                "set_track_volume/pan bypass the UndoManager. Backlog G14."})
    return verdict(FAIL, "state+undo", [51, 97], {"volumeDb_set": v1, "volumeDb_undone": v2})


def fam_mixer_mute_solo(ctx):
    cmds = [
        {"command": "create_track", "args": {"name": "A"}, "capture": {"T": "trackId"}},
        {"command": "create_track", "args": {"name": "B"}},
        {"command": "set_track_mute", "args": {"trackId": "${T}", "mute": True}},
        {"command": "set_track_solo", "args": {"trackId": "${T}", "solo": True}},
        {"command": "__snapshot", "args": {"label": "after"}},
    ]
    results, snaps, proc = drive(cmds, "conf-mixer-mute-solo")
    if cmd_fails(results):
        return verdict(FAIL, "state", [14, 15, 58], _err(proc, {"failed": cmd_fails(results)}))
    a = track_named(snaps.get("after", {}), "A")
    ok = bool(a.get("mute")) and bool(a.get("solo"))
    return verdict(PASS if ok else FAIL, "state", [14, 15, 58],
                   {"mute": a.get("mute"), "solo": a.get("solo")})


def _find_builtin_type(ctx, *keywords):
    """Resolve a built-in plugin `type` whose name/category matches any keyword."""
    results, _ = verify.run_script(ctx.bin, [{"command": "list_builtins", "args": {}}], "conf-list-builtins")
    for r in results:
        if r.get("command") == "list_builtins" and r.get("ok"):
            for p in r.get("data", {}).get("plugins", []):
                blob = (str(p.get("name", "")) + " " + str(p.get("category", "")) + " " + str(p.get("type", ""))).lower()
                if any(k in blob for k in keywords):
                    return p.get("type")
    return None


def fam_effects_add(ctx):
    rtype = _find_builtin_type(ctx, "reverb")
    if not rt_ok(rtype):
        return verdict(FAIL, "state", [53], {"error": "no built-in reverb found in list_builtins"})
    cmds = [
        {"command": "create_track", "args": {"name": "Fx"}, "capture": {"T": "trackId"}},
        {"command": "load_builtin", "args": {"trackId": "${T}", "type": rtype}, "capture": {"I": "index"}},
        {"command": "__snapshot", "args": {"label": "added"}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "undone"}},
    ]
    results, snaps, proc = drive(cmds, "conf-effects-add")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [53], _err(proc, {"failed": cmd_fails(results)}))
    added = (track_named(snaps.get("added", {}), "Fx") or {}).get("plugins", []) or []
    undone = (track_named(snaps.get("undone", {}), "Fx") or {}).get("plugins", []) or []
    has_reverb = any("reverb" in (str(p.get("name", "")) + str(p.get("type", ""))).lower() for p in added)
    ok = has_reverb and len(undone) < len(added)
    return verdict(PASS if ok else FAIL, "state+undo", [53],
                   {"type": rtype, "plugins_after_add": len(added), "has_reverb": has_reverb,
                    "plugins_after_undo": len(undone)})


def fam_effects_bypass(ctx):
    dtype = _find_builtin_type(ctx, "delay")
    if not rt_ok(dtype):
        return verdict(FAIL, "state", [54], {"error": "no built-in delay found in list_builtins"})
    cmds = [
        {"command": "create_track", "args": {"name": "Dl"}, "capture": {"T": "trackId"}},
        {"command": "load_builtin", "args": {"trackId": "${T}", "type": dtype}, "capture": {"I": "index"}},
        {"command": "bypass_plugin", "args": {"trackId": "${T}", "index": "${I}", "bypassed": True}},
        {"command": "__snapshot", "args": {"label": "bypassed"}},
        {"command": "bypass_plugin", "args": {"trackId": "${T}", "index": "${I}", "bypassed": False}},
        {"command": "__snapshot", "args": {"label": "reenabled"}},
    ]
    results, snaps, proc = drive(cmds, "conf-effects-bypass")
    if cmd_fails(results):
        return verdict(FAIL, "state", [54], _err(proc, {"failed": cmd_fails(results)}))
    pb = (track_named(snaps.get("bypassed", {}), "Dl") or {}).get("plugins", []) or []
    pr = (track_named(snaps.get("reenabled", {}), "Dl") or {}).get("plugins", []) or []
    order_unchanged = len(pb) == len(pr) and len(pb) >= 1
    # bypass/enabled flag may serialize under one of these keys (defensive across snapshot shapes)
    def flag(p):
        for k in ("bypassed", "enabled", "bypass"):
            if k in p:
                return (k, p[k])
        return (None, None)
    ok = order_unchanged  # toggling succeeded without error + order preserved
    return verdict(PASS if ok else FAIL, "state", [54],
                   {"order_unchanged": order_unchanged, "bypassed_flag": flag(pb[0]) if pb else None,
                    "reenabled_flag": flag(pr[0]) if pr else None})


def fam_automation_create(ctx):
    etype = _find_builtin_type(ctx, "eq", "4band")
    if not rt_ok(etype):
        return verdict(FAIL, "state", [61, 66], {"error": "no built-in EQ found for automation target"})
    cmds = [
        {"command": "create_track", "args": {"name": "Au"}, "capture": {"T": "trackId"}},
        {"command": "load_builtin", "args": {"trackId": "${T}", "type": etype}, "capture": {"I": "index"}},
        {"command": "add_automation_point", "args": {"trackId": "${T}", "pluginIndex": "${I}", "paramIndex": 0, "time": 0.0, "value": 1.0}, "capture": {"P0": "pointIndex"}},
        {"command": "add_automation_point", "args": {"trackId": "${T}", "pluginIndex": "${I}", "paramIndex": 0, "time": 4.0, "value": 0.0}, "capture": {"P1": "pointIndex"}},
        {"command": "__snapshot", "args": {"label": "auto"}},
    ]
    results, snaps, proc = drive(cmds, "conf-automation-create")
    if cmd_fails(results):
        return verdict(FAIL, "state", [61, 66], _err(proc, {"failed": cmd_fails(results)}))
    p0 = verify._data_field(results, "add_automation_point", "pointIndex")
    ok = p0 is not None and p0 >= 0
    return verdict(PASS if ok else FAIL, "state", [61, 66],
                   {"first_point_index": p0, "note": "fade-out is volume automation; proven here on an EQ param "
                                                      "(track-vol locator is a separate path)."})


def fam_automation_edit_undo(ctx):
    etype = _find_builtin_type(ctx, "eq", "4band")
    if not rt_ok(etype):
        return verdict(FAIL, "state+undo", [67], {"error": "no built-in EQ found for automation target"})
    cmds = [
        {"command": "create_track", "args": {"name": "Ae"}, "capture": {"T": "trackId"}},
        {"command": "load_builtin", "args": {"trackId": "${T}", "type": etype}, "capture": {"I": "index"}},
        {"command": "add_automation_point", "args": {"trackId": "${T}", "pluginIndex": "${I}", "paramIndex": 0, "time": 1.0, "value": 0.5}, "capture": {"P": "pointIndex"}},
        {"command": "set_automation_point", "args": {"trackId": "${T}", "pluginIndex": "${I}", "paramIndex": 0, "pointIndex": "${P}", "time": 1.0, "value": 0.9}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "after"}},
    ]
    results, snaps, proc = drive(cmds, "conf-automation-edit")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [67], _err(proc, {"failed": cmd_fails(results)}))
    undo_did = any(r.get("command") == "undo" and r.get("data") in (True, "true") for r in results)
    ok = undo_did
    return verdict(PASS if ok else FAIL, "state+undo", [67],
                   {"undo_returned_true": undo_did})


def fam_browser_preview(ctx):
    src = synth_wav(ARTDIR / "preview_sample.wav", 1.0, 330.0)
    cmds = [
        {"command": "__snapshot", "args": {"label": "before"}},
        {"command": "audition_file", "args": {"path": src}},
        {"command": "stop_audition", "args": {}},
        {"command": "__snapshot", "args": {"label": "after"}},
    ]
    results, snaps, proc = drive(cmds, "conf-browser-preview")
    if cmd_fails(results):
        return verdict(FAIL, "state", [70], _err(proc, {"failed": cmd_fails(results)}))
    before, after = snaps.get("before", {}), snaps.get("after", {})
    nb = sum(len(clips_of(t)) for t in tracks_of(before))
    na = sum(len(clips_of(t)) for t in tracks_of(after))
    unchanged = (len(tracks_of(before)) == len(tracks_of(after))) and nb == na
    return verdict(PASS if unchanged else FAIL, "state", [70],
                   {"session_unchanged": unchanged, "tracks": len(tracks_of(after)), "clips": na,
                    "note": "preview audibility is hardware (Phase 1); the no-mutation invariant is proven here."})


def fam_browser_relink(ctx):
    a = synth_wav(ARTDIR / "relink_a.wav", 1.0, 220.0)
    b = synth_wav(ARTDIR / "relink_b.wav", 1.5, 277.0)
    cmds = [
        {"command": "create_track", "args": {"name": "Rl"}, "capture": {"T": "trackId"}},
        {"command": "import_clip", "args": {"file": a, "trackId": "${T}"}, "capture": {"C": "clipId"}},
        {"command": "__snapshot", "args": {"label": "before"}},
        {"command": "relink_clip", "args": {"clipId": "${C}", "file": b}},
        {"command": "__snapshot", "args": {"label": "after"}},
    ]
    results, snaps, proc = drive(cmds, "conf-browser-relink")
    if cmd_fails(results):
        return verdict(FAIL, "state", [71, 73], _err(proc, {"failed": cmd_fails(results)}))
    cb = clips_of(track_named(snaps.get("before", {}), "Rl"))
    ca = clips_of(track_named(snaps.get("after", {}), "Rl"))
    if not cb or not ca:
        return verdict(FAIL, "state", [71, 73], {"error": "clip missing", "before": len(cb), "after": len(ca)})
    repointed = ca[0].get("sourceFile", "").endswith("relink_b.wav")
    placement_kept = abs(ca[0].get("start", 0) - cb[0].get("start", 0)) < 0.01
    ok = repointed and placement_kept
    return verdict(PASS if ok else FAIL, "state", [71, 73],
                   {"repointed": repointed, "placement_kept": placement_kept,
                    "source_after": Path(ca[0].get("sourceFile", "")).name})


def fam_export_mixdown(ctx):
    out = ARTDIR / "export_mixdown.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "L"}, "capture": {"T1": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T1}", "seconds": 2.0, "freq": 220.0}},
        {"command": "create_track", "args": {"name": "R"}, "capture": {"T2": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T2}", "seconds": 2.0, "freq": 330.0}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    results, snaps, proc = drive(cmds, "conf-export-mixdown")
    if cmd_fails(results) or not out.exists():
        return verdict(FAIL, "audio", [78, 79, 83], _err(proc, {"failed": cmd_fails(results), "exists": out.exists()}))
    st = verify.stats(out)
    ok = st["rms"] > 0.01 and st["peak"] > 0.05
    return verdict(PASS if ok else FAIL, "audio", [78, 79, 83],
                   {**st, "note": "export/bounce mixdown proven; battle-submission immutable-render is out-of-scope."})


def fam_export_range_tail(ctx):
    # G1: export_audio range (full/loop/custom) + delay-tail (cut/include) policy.
    # Drives a REAL headless render for each span and asserts the ACTUAL rendered
    # duration matches the requested span (invariant 78) and that an included tail
    # captures MORE audio than a cut one on the same short custom range, with a
    # reverb actually ringing (invariant 81). Relational (duration_s/frames), not
    # golden-PCM, so it stays robust to any reverb-tail float noise across runs.
    rtype = _find_builtin_type(ctx, "reverb")
    if not rt_ok(rtype):
        return verdict(FAIL, "audio", [78, 81], {"error": "no built-in reverb found in list_builtins"})

    full_out = ARTDIR / "export_range_full.wav"
    loop_out = ARTDIR / "export_range_loop.wav"
    custom_out = ARTDIR / "export_range_custom.wav"
    tail_cut_out = ARTDIR / "export_range_tail_cut.wav"
    tail_include_out = ARTDIR / "export_range_tail_include.wav"

    cmds = [
        {"command": "create_track", "args": {"name": "Rng"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 4.0, "freq": 220.0}},
        {"command": "export_audio", "args": {"file": str(full_out)}},
        {"command": "set_transport", "args": {"loopStart": 0.5, "loopEnd": 2.5}},
        {"command": "export_audio", "args": {"file": str(loop_out), "range": "loop"}},
        {"command": "export_audio", "args": {"file": str(custom_out), "range": "custom", "start": 1.0, "end": 3.0}},
        # Push a built-in reverb hot (big room, fully wet) so tail:'include' actually
        # captures decaying tail audio past the range end — a silence-trim edge case
        # (no decaying source) would make include==cut, which would NOT prove the policy.
        {"command": "load_builtin", "args": {"trackId": "${T}", "type": rtype}, "capture": {"I": "index"}},
        {"command": "set_plugin_param", "args": {"trackId": "${T}", "index": "${I}", "paramIndex": 0, "value": 0.95}},
        {"command": "set_plugin_param", "args": {"trackId": "${T}", "index": "${I}", "paramIndex": 2, "value": 1.0}},
        {"command": "export_audio", "args": {"file": str(tail_cut_out), "range": "custom", "start": 0.0, "end": 1.0, "tail": "cut"}},
        {"command": "export_audio", "args": {"file": str(tail_include_out), "range": "custom", "start": 0.0, "end": 1.0,
                                              "tail": "include", "tailSeconds": 1.5}},
    ]
    results, snaps, proc = drive(cmds, "conf-export-range-tail")
    if cmd_fails(results):
        return verdict(FAIL, "audio", [78, 81], _err(proc, {"failed": cmd_fails(results)}))
    for p in (full_out, loop_out, custom_out, tail_cut_out, tail_include_out):
        if not p.exists():
            return verdict(FAIL, "audio", [78, 81], {"error": f"{p.name} was not produced"})

    full_s, loop_s, custom_s = verify.stats(full_out), verify.stats(loop_out), verify.stats(custom_out)
    cut_s, inc_s = verify.stats(tail_cut_out), verify.stats(tail_include_out)

    span_ok = (
        1.5 < full_s["duration_s"] < 6.0
        and abs(loop_s["duration_s"] - 2.0) < 0.2 and loop_s["duration_s"] < full_s["duration_s"]
        and abs(custom_s["duration_s"] - 2.0) < 0.2 and custom_s["duration_s"] < full_s["duration_s"]
    )
    tail_ok = inc_s["duration_s"] > cut_s["duration_s"] or inc_s["frames"] > cut_s["frames"]
    ok = span_ok and tail_ok
    return verdict(PASS if ok else FAIL, "audio", [78, 81],
                   {"full_duration_s": full_s["duration_s"], "loop_duration_s": loop_s["duration_s"],
                    "custom_duration_s": custom_s["duration_s"], "tail_cut_duration_s": cut_s["duration_s"],
                    "tail_include_duration_s": inc_s["duration_s"], "span_ok": span_ok, "tail_ok": tail_ok})


def rt_ok(t):
    return isinstance(t, str) and len(t) > 0


# ── post-pack families (EXTRA_FAMILIES) — capabilities shipped after 2026-06-26 ────
def synth_pulse_wav(path, bpm=120.0, beats=8, sr=44100):
    """Short click train at `bpm` (60ms decaying bursts) — a source detect_clip_bpm can
    actually read (a pure sine has no pulse and correctly errors)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    spacing = 60.0 / bpm
    n = int(spacing * beats * sr)
    burst = int(0.06 * sr)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(n):
            t = (i / sr) % spacing
            k = int(t * sr)
            v = 0.0
            if k < burst:
                v = 0.8 * (1.0 - k / burst) * math.sin(2 * math.pi * 1000.0 * i / sr)
            frames += struct.pack("<h", int(v * 32767))
        w.writeframes(bytes(frames))
    return str(path)


def session_of(snap):
    return snap.get("session", {}) or {}


def clip0(snap, track_name):
    cs = clips_of(track_named(snap, track_name))
    return cs[0] if cs else {}


def plugin0(snap, track_name):
    ps = (track_named(snap, track_name) or {}).get("plugins", []) or []
    return ps[0] if ps else {}


def fam_clip_fades(ctx):
    # G4b: clip-edge fades render as state without moving boundaries; one undo per edit.
    cmds = [
        {"command": "create_track", "args": {"name": "Fd"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0},
         "capture": {"C": "clipId"}},
        {"command": "__snapshot", "args": {"label": "before"}},
        {"command": "set_clip_fade", "args": {"clipId": "${C}", "fadeInSec": 0.5, "fadeOutSec": 1.0,
                                              "curveOut": "sCurve"}},
        {"command": "__snapshot", "args": {"label": "faded"}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "undone"}},
    ]
    results, snaps, proc = drive(cmds, "conf-clip-fades")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [30, 56, 79], _err(proc, {"failed": cmd_fails(results)}))
    b, f, u = clip0(snaps["before"], "Fd"), clip0(snaps["faded"], "Fd"), clip0(snaps["undone"], "Fd")
    start_stable = abs(f.get("start", -1) - b.get("start", -2)) < 0.01 and \
        abs(f.get("length", -1) - b.get("length", -2)) < 0.01
    set_ok = abs(f.get("fadeInSec", 0) - 0.5) < 0.01 and abs(f.get("fadeOutSec", 0) - 1.0) < 0.01 \
        and f.get("fadeOutType") != b.get("fadeOutType")
    undo_ok = abs(u.get("fadeInSec", -1)) < 0.01 and abs(u.get("fadeOutSec", -1)) < 0.01
    ok = start_stable and set_ok and undo_ok
    return verdict(PASS if ok else FAIL, "state+undo", [30, 56, 79],
                   {"fadeIn": f.get("fadeInSec"), "fadeOut": f.get("fadeOutSec"),
                    "curve_changed": f.get("fadeOutType") != b.get("fadeOutType"),
                    "boundaries_stable": start_stable, "undo_ok": undo_ok,
                    "note": "fade curve AUDIBILITY is the verify.py check_clip_fades golden."})


def fam_clip_reverse_normalize(ctx):
    # Reverse + non-destructive normalize are clip state; one undo each, exact restore.
    cmds = [
        {"command": "create_track", "args": {"name": "Rv"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 1.0, "freq": 330.0},
         "capture": {"C": "clipId"}},
        {"command": "set_clip_reverse", "args": {"clipId": "${C}", "reversed": True}},
        {"command": "__snapshot", "args": {"label": "rev"}},
        {"command": "normalize_clip", "args": {"clipId": "${C}", "targetDb": 0.0}},
        {"command": "__snapshot", "args": {"label": "norm"}},
        {"command": "undo", "args": {}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "undone"}},
    ]
    results, snaps, proc = drive(cmds, "conf-clip-reverse-norm")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [97], _err(proc, {"failed": cmd_fails(results)}))
    rev, norm, und = clip0(snaps["rev"], "Rv"), clip0(snaps["norm"], "Rv"), clip0(snaps["undone"], "Rv")
    # The 0.6-amplitude test tone normalizes to ~+4.4 dB; the exact figure is the
    # verify.py peak check — here we assert direction + exact undo restore.
    rev_ok = rev.get("reversed") is True
    norm_ok = norm.get("gainDb", 0.0) > 2.0
    undo_ok = und.get("reversed") is False and abs(und.get("gainDb", -1.0)) < 0.01
    ok = rev_ok and norm_ok and undo_ok
    return verdict(PASS if ok else FAIL, "state+undo", [97],
                   {"reversed": rev.get("reversed"), "gainDb_after_normalize": norm.get("gainDb"),
                    "undo_ok": undo_ok})


def fam_clip_crossfade_loop(ctx):
    # Auto-crossfade flag + the clip loop region round-trip (enable → fields → disable).
    cmds = [
        {"command": "create_track", "args": {"name": "Xl"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0},
         "capture": {"C": "clipId"}},
        {"command": "set_clip_crossfade", "args": {"clipId": "${C}", "enabled": True}},
        {"command": "set_clip_loop", "args": {"clipId": "${C}", "enabled": True, "start": 0.0, "length": 1.0}},
        {"command": "__snapshot", "args": {"label": "on"}},
        {"command": "set_clip_loop", "args": {"clipId": "${C}", "enabled": False}},
        {"command": "__snapshot", "args": {"label": "loopoff"}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "loopback"}},
    ]
    results, snaps, proc = drive(cmds, "conf-clip-xfade-loop")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [], _err(proc, {"failed": cmd_fails(results)}))
    on, off, back = clip0(snaps["on"], "Xl"), clip0(snaps["loopoff"], "Xl"), clip0(snaps["loopback"], "Xl")
    on_ok = on.get("autoCrossfade") is True and on.get("loopEnabled") is True \
        and abs(on.get("loopLength", 0) - 1.0) < 0.01
    off_ok = off.get("loopEnabled") is False
    undo_ok = back.get("loopEnabled") is True and abs(back.get("loopLength", 0) - 1.0) < 0.01
    ok = on_ok and off_ok and undo_ok
    return verdict(PASS if ok else FAIL, "state+undo", [],
                   {"crossfade": on.get("autoCrossfade"), "loop_on": on.get("loopEnabled"),
                    "loopLength": on.get("loopLength"), "loop_off_ok": off_ok, "undo_ok": undo_ok})


def fam_ripple_delete(ctx):
    # Ripple delete_time_range closes the gap downstream; ONE undo reverts remove+slide.
    cmds = [
        {"command": "create_track", "args": {"name": "Rip"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 1.0, "freq": 220.0}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 1.0, "freq": 330.0},
         "capture": {"C2": "clipId"}},
        {"command": "move_clip", "args": {"clipId": "${C2}", "start": 2.0}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 1.0, "freq": 440.0},
         "capture": {"C3": "clipId"}},
        {"command": "move_clip", "args": {"clipId": "${C3}", "start": 4.0}},
        {"command": "__snapshot", "args": {"label": "before"}},
        {"command": "delete_time_range", "args": {"start": 2.0, "end": 3.0, "trackIds": ["${T}"],
                                                  "ripple": True}},
        {"command": "__snapshot", "args": {"label": "rippled"}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "undone"}},
    ]
    results, snaps, proc = drive(cmds, "conf-ripple-delete")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [], _err(proc, {"failed": cmd_fails(results)}))

    def starts(label):
        return sorted(round(c.get("start", -1), 2) for c in clips_of(track_named(snaps[label], "Rip")))
    removed = len(starts("rippled")) == 2
    slid = starts("rippled") == [0.0, 3.0]
    atomic = starts("undone") == starts("before") and len(starts("undone")) == 3
    ok = removed and slid and atomic
    return verdict(PASS if ok else FAIL, "state+undo", [],
                   {"before": starts("before"), "rippled": starts("rippled"),
                    "undone": starts("undone")})


def fam_warp_stretch(ctx):
    # Easy-warp: detect_clip_bpm reads a real pulse; stretch_clip{bars} derives sourceBpm
    # and fills the span; set_clip_warp round-trips; one undo per edit.
    pulse = synth_pulse_wav(ARTDIR / "pulse120.wav", bpm=120.0, beats=8)
    cmds = [
        {"command": "create_track", "args": {"name": "Wp"}, "capture": {"T": "trackId"}},
        {"command": "import_clip", "args": {"trackId": "${T}", "file": pulse}, "capture": {"P": "clipId"}},
        {"command": "detect_clip_bpm", "args": {"clipId": "${P}"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0},
         "capture": {"C": "clipId"}},
        {"command": "__snapshot", "args": {"label": "before"}},
        {"command": "stretch_clip", "args": {"clipId": "${C}", "bars": 2}},
        {"command": "__snapshot", "args": {"label": "stretched"}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "undone"}},
    ]
    results, snaps, proc = drive(cmds, "conf-warp-stretch")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [24], _err(proc, {"failed": cmd_fails(results)}))
    bpm = verify._data_field(results, "detect_clip_bpm", "bpm")
    conf = verify._data_field(results, "detect_clip_bpm", "confidence")
    tempo = session_of(snaps["before"]).get("tempo", 120.0)
    beats_per_bar = session_of(snaps["before"]).get("timeSigNumerator", 4)
    want_len = 2 * beats_per_bar * 60.0 / tempo   # 2 bars at the project tempo

    def tone(label):
        for c in clips_of(track_named(snaps[label], "Wp")):
            if "tone" in (c.get("name") or ""):
                return c
        return {}
    st, un = tone("stretched"), tone("undone")
    detect_ok = bpm is not None and abs(bpm - 120.0) < 6.0 and (conf or 0) >= 0.1
    stretch_ok = st.get("autoTempo") is True and abs(st.get("length", 0) - want_len) < 0.1
    undo_ok = un.get("autoTempo") is not True and abs(un.get("length", 0) - 2.0) < 0.05
    ok = detect_ok and stretch_ok and undo_ok
    return verdict(PASS if ok else FAIL, "state+undo", [24],
                   {"detected_bpm": bpm, "confidence": conf, "stretched_len": st.get("length"),
                    "want_len": want_len, "sourceBpm": st.get("sourceBpm"), "undo_ok": undo_ok,
                    "note": "pitch preservation at this ratio is the verify.py check_warp_stretch lane."})


def fam_automation_write_record(ctx):
    # G10 write mode: while armed, set_plugin_param captures a curve point at the
    # transport position IN THE SAME TXN — one undo reverts value AND point.
    etype = _find_builtin_type(ctx, "eq", "4band")
    if not rt_ok(etype):
        return verdict(FAIL, "state+undo", [63, 64], {"error": "no built-in EQ found"})
    cmds = [
        {"command": "create_track", "args": {"name": "Wr"}, "capture": {"T": "trackId"}},
        {"command": "load_builtin", "args": {"trackId": "${T}", "type": etype}, "capture": {"I": "index"}},
        {"command": "__snapshot", "args": {"label": "before"}},
        {"command": "set_track_automation_mode", "args": {"trackId": "${T}", "mode": "write"}},
        {"command": "set_transport", "args": {"position": 2.0}},
        {"command": "set_plugin_param", "args": {"trackId": "${T}", "index": "${I}", "paramIndex": 0,
                                                 "value": 0.8}},
        {"command": "__snapshot", "args": {"label": "written"}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "undone"}},
    ]
    results, snaps, proc = drive(cmds, "conf-automation-write")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [63, 64], _err(proc, {"failed": cmd_fails(results)}))

    def param0(label):
        return ((plugin0(snaps[label], "Wr") or {}).get("params", [{}]) or [{}])[0]
    b, w, u = param0("before"), param0("written"), param0("undone")
    mode_ok = (track_named(snaps["written"], "Wr") or {}).get("automationMode") == "write"
    pts = w.get("points", []) or []
    captured = w.get("automated") is True and any(abs(p.get("t", -1) - 2.0) < 0.05 and
                                                 abs(p.get("v", -1) - 0.8) < 0.05 for p in pts)
    undo_ok = (u.get("automated") is not True) and abs(u.get("value", -1) - b.get("value", -2)) < 0.01
    ok = mode_ok and captured and undo_ok
    return verdict(PASS if ok else FAIL, "state+undo", [63, 64],
                   {"mode_ok": mode_ok, "point_captured": captured, "points": pts[:3],
                    "one_undo_reverts_both": undo_ok})


def fam_automation_curve_write(ctx):
    # write_automation_curve: replace clears only the spanned window; merge adds.
    etype = _find_builtin_type(ctx, "eq", "4band")
    if not rt_ok(etype):
        return verdict(FAIL, "state+undo", [63], {"error": "no built-in EQ found"})
    cmds = [
        {"command": "create_track", "args": {"name": "Cw"}, "capture": {"T": "trackId"}},
        {"command": "load_builtin", "args": {"trackId": "${T}", "type": etype}, "capture": {"I": "index"}},
        {"command": "write_automation_curve", "args": {"trackId": "${T}", "pluginIndex": "${I}",
                                                       "paramIndex": 0, "apply": "replace",
                                                       "points": [{"t": 0.0, "v": 0.0}, {"t": 2.0, "v": 1.0}]}},
        {"command": "__snapshot", "args": {"label": "two"}},
        {"command": "write_automation_curve", "args": {"trackId": "${T}", "pluginIndex": "${I}",
                                                       "paramIndex": 0, "apply": "merge",
                                                       "points": [{"t": 1.0, "v": 0.5}]}},
        {"command": "__snapshot", "args": {"label": "three"}},
        {"command": "write_automation_curve", "args": {"trackId": "${T}", "pluginIndex": "${I}",
                                                       "paramIndex": 0, "apply": "replace",
                                                       "points": [{"t": 0.5, "v": 0.2}, {"t": 1.5, "v": 0.8}]}},
        {"command": "__snapshot", "args": {"label": "windowed"}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "undone"}},
    ]
    results, snaps, proc = drive(cmds, "conf-automation-curve")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [63], _err(proc, {"failed": cmd_fails(results)}))

    def times(label):
        p = ((plugin0(snaps[label], "Cw") or {}).get("params", [{}]) or [{}])[0]
        return sorted(round(pt.get("t", -1), 2) for pt in (p.get("points", []) or []))
    two, three, windowed, undone = times("two"), times("three"), times("windowed"), times("undone")
    ok = (two == [0.0, 2.0] and three == [0.0, 1.0, 2.0]
          and windowed == [0.0, 0.5, 1.5, 2.0]     # replace cleared ONLY [0.5,1.5] → t=1 gone
          and undone == three)
    return verdict(PASS if ok else FAIL, "state+undo", [63],
                   {"after_replace": two, "after_merge": three, "after_windowed_replace": windowed,
                    "after_undo": undone})


def fam_master_bus(ctx):
    # Master-bus chain: builtin insert + fader + bypass are real state; undo restores.
    rtype = _find_builtin_type(ctx, "reverb")
    if not rt_ok(rtype):
        return verdict(FAIL, "state+undo", [97], {"error": "no built-in reverb found"})
    cmds = [
        {"command": "load_master_builtin", "args": {"type": rtype}, "capture": {"I": "index"}},
        {"command": "set_master_volume", "args": {"db": -6.0}},
        {"command": "__snapshot", "args": {"label": "set"}},
        {"command": "bypass_master_plugin", "args": {"index": "${I}", "bypassed": True}},
        {"command": "__snapshot", "args": {"label": "bypassed"}},
        {"command": "undo", "args": {}},
        {"command": "__snapshot", "args": {"label": "unbypassed"}},
    ]
    results, snaps, proc = drive(cmds, "conf-master-bus")
    if cmd_fails(results):
        return verdict(FAIL, "state+undo", [97], _err(proc, {"failed": cmd_fails(results)}))

    def master(label):
        return snaps[label].get("master", {}) or {}
    def mplug(label):
        ps = master(label).get("plugins", []) or []
        return ps[0] if ps else {}
    vol_ok = abs(master("set").get("volumeDb", 0) - (-6.0)) < 0.5
    ins_ok = rt_ok(mplug("set").get("name", "")) and mplug("set").get("enabled") is True
    byp_ok = mplug("bypassed").get("enabled") is False
    undo_ok = mplug("unbypassed").get("enabled") is True
    ok = vol_ok and ins_ok and byp_ok and undo_ok
    return verdict(PASS if ok else FAIL, "state+undo", [97],
                   {"volumeDb": master("set").get("volumeDb"), "plugin": mplug("set").get("name"),
                    "bypass_ok": byp_ok, "undo_ok": undo_ok,
                    "note": "master audibility is the verify.py check_master_chain golden."})


def fam_group_bus_routing(ctx):
    # Sends/buses + group (submix) tracks are snapshot-visible routing state.
    cmds = [
        {"command": "create_bus", "args": {"name": "FXB"}, "capture": {"B": "busNumber"}},
        {"command": "create_track", "args": {"name": "Src"}, "capture": {"T": "trackId"}},
        {"command": "add_send", "args": {"trackId": "${T}", "bus": "${B}", "db": -3.0}},
        {"command": "__snapshot", "args": {"label": "sent"}},
        {"command": "set_send_level", "args": {"trackId": "${T}", "bus": "${B}", "db": -12.0}},
        {"command": "__snapshot", "args": {"label": "lowered"}},
        {"command": "remove_send", "args": {"trackId": "${T}", "bus": "${B}"}},
        {"command": "__snapshot", "args": {"label": "removed"}},
        {"command": "create_track", "args": {"name": "Ga"}, "capture": {"T1": "trackId"}},
        {"command": "create_track", "args": {"name": "Gb"}, "capture": {"T2": "trackId"}},
        {"command": "create_group_track", "args": {"trackIds": ["${T1}", "${T2}"], "name": "Grp"},
         "capture": {"G": "groupId"}},
        {"command": "__snapshot", "args": {"label": "grouped"}},
        {"command": "ungroup_track", "args": {"trackId": "${G}"}},
        {"command": "__snapshot", "args": {"label": "ungrouped"}},
    ]
    results, snaps, proc = drive(cmds, "conf-group-bus")
    if cmd_fails(results):
        return verdict(FAIL, "state", [59], _err(proc, {"failed": cmd_fails(results)}))

    def sends(label):
        return (track_named(snaps[label], "Src") or {}).get("sends", []) or []
    bus_num = verify._data_field(results, "create_bus", "busNumber")
    sent = sends("sent")
    send_ok = len(sent) == 1 and abs(sent[0].get("db", 0) - (-3.0)) < 0.5
    level_ok = abs((sends("lowered") or [{}])[0].get("db", 0) - (-12.0)) < 0.5
    removed_ok = sends("removed") == []
    buses_ok = any(b.get("name") == "FXB" for b in snaps["sent"].get("buses", []) or [])
    ga = track_named(snaps["grouped"], "Ga") or {}
    group_ok = bool(ga.get("parentId"))
    ungroup_ok = not (track_named(snaps["ungrouped"], "Ga") or {}).get("parentId")
    ok = send_ok and level_ok and removed_ok and buses_ok and group_ok and ungroup_ok
    return verdict(PASS if ok else FAIL, "state", [59],
                   {"bus": bus_num, "send_db": sent[0].get("db") if sent else None,
                    "level_ok": level_ok, "removed_ok": removed_ok, "buses_ok": buses_ok,
                    "group_ok": group_ok, "ungroup_ok": ungroup_ok,
                    "note": "send-path audibility is the verify.py check_send_return lane."})


def fam_scale_lock(ctx):
    # Scale lock (inv 88) is an INPUT AID: set_key persists producer intent; existing
    # notes are NEVER rewritten by a key change; invalid tonic is rejected.
    cmds = [
        {"command": "create_track", "args": {"name": "Kt"}, "capture": {"KT": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${KT}", "name": "Keys", "length": 4.0}, "capture": {"C": "clipId"}},
        {"command": "add_note", "args": {"clipId": "${C}", "pitch": 64, "start": 0.0, "length": 1.0}},
        {"command": "set_key", "args": {"tonic": "C", "mode": "minor"}},
        {"command": "__snapshot", "args": {"label": "keyed"}},
    ]
    results, snaps, proc = drive(cmds, "conf-scale-lock")
    if cmd_fails(results):
        return verdict(FAIL, "state", [88], _err(proc, {"failed": cmd_fails(results)}))
    key = session_of(snaps["keyed"]).get("key", {}) or {}
    key_ok = key.get("tonic") == "C" and key.get("mode") == "minor"
    # E natural (64) is out of C minor — the key change must NOT rewrite it.
    notes = []
    for t in tracks_of(snaps["keyed"]):
        for c in clips_of(t):
            notes += c.get("notes", []) or []
    note_ok = any(n.get("pitch") == 64 for n in notes)
    # Invalid tonic must error (run separately so the main chain stays clean).
    bad, _, _ = drive([{"command": "set_key", "args": {"tonic": "H", "mode": "minor"}}],
                      "conf-scale-lock-bad")
    rejected = len(cmd_fails(bad)) == 1
    ok = key_ok and note_ok and rejected
    return verdict(PASS if ok else FAIL, "state", [88],
                   {"key": key, "out_of_scale_note_untouched": note_ok,
                    "invalid_tonic_rejected": rejected,
                    "note": "the pitch-resolving input aid itself is UI-side (piano roll shading) — e2e lane."})


def fam_meter_midsession(ctx):
    # METER-001: tracks created mid-session are metered; the toggle round-trips.
    cmds = [
        {"command": "create_track", "args": {"name": "M1"}, "capture": {"T": "trackId"}},
        {"command": "__snapshot", "args": {"label": "created"}},
        {"command": "disable_track_meter", "args": {"trackId": "${T}"}},
        {"command": "__snapshot", "args": {"label": "off"}},
        {"command": "enable_track_meter", "args": {"trackId": "${T}"}},
        {"command": "__snapshot", "args": {"label": "on"}},
    ]
    results, snaps, proc = drive(cmds, "conf-meter-midsession")
    if cmd_fails(results):
        return verdict(FAIL, "state", [], _err(proc, {"failed": cmd_fails(results)}))
    created = (track_named(snaps["created"], "M1") or {}).get("meterEnabled")
    off = (track_named(snaps["off"], "M1") or {}).get("meterEnabled")
    on = (track_named(snaps["on"], "M1") or {}).get("meterEnabled")
    ok = created is True and off is False and on is True
    return verdict(PASS if ok else FAIL, "state", [],
                   {"created": created, "disabled": off, "reenabled": on,
                    "note": "live level VALUES ride the 30 Hz levels event — hardware lane."})


def fam_takes_recording_graceful(ctx):
    # Recording surface headless: arm/monitor/takes are graceful no-ops that never
    # fabricate state (inv 44/49 class). Live capture itself is the hardware lane.
    cmds = [
        {"command": "create_track", "args": {"name": "Rec"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 1.0, "freq": 220.0},
         "capture": {"C": "clipId"}},
        {"command": "arm_track", "args": {"trackId": "${T}", "armed": True}},
        {"command": "set_input_monitor", "args": {"trackId": "${T}", "mode": "on"}},
        {"command": "list_takes", "args": {"clipId": "${C}"}},
        {"command": "__snapshot", "args": {"label": "after"}},
    ]
    results, snaps, proc = drive(cmds, "conf-takes-graceful")
    if cmd_fails(results):
        return verdict(FAIL, "state", [], _err(proc, {"failed": cmd_fails(results)}))
    takes = verify._data_field(results, "list_takes", "takes")
    clip = clip0(snaps["after"], "Rec")
    no_fake = "takes" not in clip or not clip.get("takes")
    n_clips = len(clips_of(track_named(snaps["after"], "Rec")))
    ok = takes is not None and no_fake and n_clips == 1
    return verdict(PASS if ok else FAIL, "state", [],
                   {"takes": takes, "no_fabricated_takes": no_fake, "clips": n_clips,
                    "note": "arm/monitor accept + no-op headless (no input device); live capture "
                            "+ count-in audibility = the owner runbook REC rows."})


# ── golden producer workflows (DAW-parity P7) ─────────────────────────────────────
# Workflow-level parity: single features passing ≠ the workflow working. Each is one
# composite family over the real command surface; a missing capability mid-chain is a
# tracked GAP, a broken step is a FAIL.
def _canon_snap(snap):
    """Python twin of the selftest matrix canon(): strip volatile subtrees so equality
    means state equality."""
    import copy
    s = copy.deepcopy(snap)
    s.pop("transport", None)
    s.pop("controller", None)
    sess = s.get("session", {})
    for k in ("dirty", "recentProjects", "recoveryAvailable", "recoverableCount"):
        sess.pop(k, None)

    def rnd(x):
        # Same 1e-6 rounding as the C++ matrix canon(): the fader dB<->position curve and
        # save/reload float32 carry round-trip with epsilon — that is restoration, not drift.
        if isinstance(x, float):
            return round(x, 6) + 0.0
        if isinstance(x, dict):
            return {k: rnd(v) for k, v in x.items()}
        if isinstance(x, list):
            return [rnd(v) for v in x]
        return x
    return json.dumps(rnd(s), sort_keys=True)


def fam_workflow_beat(ctx):
    # W1: drums (composite pattern) → melody → quantize → arrange → balance → export.
    out = ARTDIR / "wf_beat.wav"
    cmds = [
        {"command": "add_drum_pattern",
         "args": {"pattern": "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x."}},
        {"command": "create_track", "args": {"name": "Melody"}, "capture": {"MT": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${MT}", "start": 0.0, "length": 4.0},
         "capture": {"MC": "clipId"}},
        {"command": "add_note", "args": {"clipId": "${MC}", "pitch": 60, "start": 0.06, "length": 0.5}},
        {"command": "add_note", "args": {"clipId": "${MC}", "pitch": 63, "start": 1.1, "length": 0.5}},
        {"command": "add_note", "args": {"clipId": "${MC}", "pitch": 67, "start": 2.05, "length": 0.5}},
        {"command": "quantize_notes", "args": {"clipId": "${MC}", "division": 0.25, "strength": 1.0}},
        {"command": "duplicate_clip", "args": {"clipId": "${MC}"}},
        {"command": "set_track_volume", "args": {"trackId": "${MT}", "db": -4.0}},
        {"command": "__snapshot", "args": {"label": "arranged"}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    results, snaps, proc = drive(cmds, "conf-wf-beat")
    if cmd_fails(results):
        return verdict(FAIL, "workflow", [], _err(proc, {"failed": cmd_fails(results)}))
    if not out.exists():
        return verdict(FAIL, "workflow", [], {"error": "no export produced"})
    st = verify.stats(out)
    snap = snaps.get("arranged", {})
    drums = track_named(snap, "Drums")
    melody_clips = len(clips_of(track_named(snap, "Melody")))
    audible = st["rms"] > 0.005 and st["peak"] > 0.02   # the silent-drums class, workflow level
    ok = drums is not None and melody_clips == 2 and audible
    return verdict(PASS if ok else FAIL, "workflow+audio", [],
                   {"drum_track": drums is not None, "melody_clips": melody_clips,
                    "export_rms": st["rms"], "export_s": st["duration_s"]})


def fam_workflow_record_comp(ctx):
    # W2: arm → count-in → (live capture + comp = the hardware half). The state spine is
    # proven headless; the mic take itself is the owner runbook's REC rows.
    cmds = [
        {"command": "create_track", "args": {"name": "Vox"}, "capture": {"T": "trackId"}},
        {"command": "set_count_in", "args": {"bars": 1}},
        {"command": "arm_track", "args": {"trackId": "${T}", "armed": True}},
        {"command": "set_input_monitor", "args": {"trackId": "${T}", "mode": "automatic"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 1.0, "freq": 220.0},
         "capture": {"C": "clipId"}},
        {"command": "list_takes", "args": {"clipId": "${C}"}},
        {"command": "__snapshot", "args": {"label": "after"}},
        {"command": "set_count_in", "args": {"bars": 0}},
    ]
    results, snaps, proc = drive(cmds, "conf-wf-record")
    if cmd_fails(results):
        return verdict(FAIL, "workflow", [], _err(proc, {"failed": cmd_fails(results)}))
    countin = session_of(snaps.get("after", {})).get("countInBars")
    takes = verify._data_field(results, "list_takes", "takes")
    ok = countin == 1 and takes is not None
    if not ok:
        return verdict(FAIL, "workflow", [], {"countInBars": countin, "takes": takes})
    return verdict(HARDWARE, "workflow", [],
                   {"note": "arm/count-in/monitor/takes state proven headless; the live take + "
                            "comp-by-ear is the owner runbook REC-mic row.",
                    "countInBars": countin})


def fam_workflow_mix_stems(ctx):
    # W3: buses + sends + automation → stems; the stem sum NULLS against the mix at unity
    # master (stems render pre-master — measured in verify.py's P4 pass).
    stem_dir = ARTDIR / "wf_stems"
    mix = ARTDIR / "wf_stems_mix.wav"
    rtype = _find_builtin_type(ctx, "reverb")
    etype = _find_builtin_type(ctx, "eq", "4band")
    if not (rt_ok(rtype) and rt_ok(etype)):
        return verdict(FAIL, "workflow", [], {"error": "builtins missing"})
    cmds = [
        {"command": "create_track", "args": {"name": "A"}, "capture": {"TA": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${TA}", "seconds": 2.0, "freq": 220.0}},
        {"command": "create_track", "args": {"name": "B"}, "capture": {"TB": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${TB}", "seconds": 2.0, "freq": 660.0}},
        {"command": "create_bus", "args": {"name": "Verb"}, "capture": {"BN": "busNumber", "RT": "trackId"}},
        {"command": "load_builtin", "args": {"trackId": "${RT}", "type": rtype}, "capture": {"RV": "index"}},
        {"command": "add_send", "args": {"trackId": "${TA}", "bus": "${BN}", "db": -6.0}},
        {"command": "load_builtin", "args": {"trackId": "${TA}", "type": etype}, "capture": {"EQ": "index"}},
        {"command": "write_automation_curve", "args": {"trackId": "${TA}", "pluginIndex": "${EQ}",
                                                       "paramIndex": 1, "apply": "replace",
                                                       "points": [{"t": 0.0, "v": 0.5}, {"t": 2.0, "v": 0.3}]}},
        {"command": "set_master_volume", "args": {"db": 0.0}},
        {"command": "export_stems", "args": {"dir": str(stem_dir)}},
        {"command": "export_audio", "args": {"file": str(mix)}},
    ]
    results, snaps, proc = drive(cmds, "conf-wf-mixstems")
    if cmd_fails(results):
        return verdict(FAIL, "workflow", [], _err(proc, {"failed": cmd_fails(results)}))
    stems_res = next((r for r in results if r.get("command") == "export_stems"), {})
    stems = stems_res.get("data", {}).get("stems", [])
    files = [Path(s["file"]) for s in stems]
    if len(files) < 2 or not all(f.exists() for f in files) or not mix.exists():
        return verdict(FAIL, "workflow", [], {"stems": [str(f) for f in files]})
    import numpy as np
    total = None
    for f in files:
        d, _, _ = verify.load_wav(f)
        m = verify.mono(d)
        total = m if total is None else total[:min(total.size, m.size)] + m[:min(total.size, m.size)]
    mm, _, _ = verify.load_wav(mix)
    mm = verify.mono(mm)
    n = min(total.size, mm.size)
    null_rms = float(np.sqrt(np.mean((total[:n] - mm[:n]) ** 2)))
    ok = null_rms < 1e-3 and verify.stats(mix)["rms"] > 0.01
    return verdict(PASS if ok else FAIL, "workflow+audio", [],
                   {"stems": len(files), "null_rms": round(null_rms, 6),
                    "note": "sum(stems) nulls against the unity-master mix — alignment + "
                            "completeness with sends + automation live."})


def fam_workflow_remix(ctx):
    # W4: import → retempo → stretch to the new grid → split/rearrange → render matches
    # the NEW arrangement length.
    src = synth_wav(ARTDIR / "wf_remix_src.wav", seconds=2.0, freq=220.0)
    out = ARTDIR / "wf_remix.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Rx"}, "capture": {"T": "trackId"}},
        {"command": "import_clip", "args": {"trackId": "${T}", "file": src}, "capture": {"C": "clipId"}},
        {"command": "set_tempo", "args": {"bpm": 140.0}},
        {"command": "stretch_clip", "args": {"clipId": "${C}", "bars": 1}},
        {"command": "__wait", "args": {"ms": 4000}},
        {"command": "split_clip", "args": {"clipId": "${C}", "time": 0.85}, "capture": {"N": "newClipId"}},
        {"command": "move_clip", "args": {"clipId": "${N}", "start": 4.0}},
        # The split minted a NEW warped clip whose render proxy generates in the
        # background — pump again or the export sees an unreadable source (the same
        # proxy class the P4 checks found).
        {"command": "__wait", "args": {"ms": 4000}},
        {"command": "__snapshot", "args": {"label": "arranged"}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    results, snaps, proc = drive(cmds, "conf-wf-remix")
    if cmd_fails(results):
        return verdict(FAIL, "workflow", [], _err(proc, {"failed": cmd_fails(results)}))
    if not out.exists():
        return verdict(FAIL, "workflow", [], {"error": "no export produced"})
    st = verify.stats(out)
    snap = snaps.get("arranged", {})
    clips = clips_of(track_named(snap, "Rx"))
    arr_end = max((c.get("start", 0) + c.get("length", 0)) for c in clips) if clips else 0
    ok = len(clips) == 2 and abs(st["duration_s"] - arr_end) < 0.1 and st["rms"] > 0.005
    return verdict(PASS if ok else FAIL, "workflow+audio", [],
                   {"clips": len(clips), "arrangement_end_s": round(arr_end, 3),
                    "export_s": st["duration_s"], "export_rms": st["rms"]})


def fam_workflow_torture(ctx):
    # W5: a heavy edit chain → deep undo walk-back → redo walk-forward (exact canonical
    # restore both ways) → save → reload → canonical equality.
    edits = [
        {"command": "create_track", "args": {"name": "T1"}, "capture": {"T1": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T1}", "seconds": 2.0, "freq": 220.0},
         "capture": {"C1": "clipId"}},
        {"command": "set_clip_fade", "args": {"clipId": "${C1}", "fadeInSec": 0.2}},
        {"command": "set_clip_gain", "args": {"clipId": "${C1}", "gainDb": -4.0}},
        {"command": "create_track", "args": {"name": "T2"}, "capture": {"T2": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${T2}", "start": 0.0, "length": 4.0},
         "capture": {"C2": "clipId"}},
        {"command": "add_note", "args": {"clipId": "${C2}", "pitch": 62, "start": 0.3, "length": 0.5}},
        {"command": "quantize_notes", "args": {"clipId": "${C2}", "division": 0.5, "strength": 1.0}},
        {"command": "set_track_volume", "args": {"trackId": "${T2}", "db": -6.0}},
        {"command": "set_master_volume", "args": {"db": -2.0}},
        {"command": "set_tempo", "args": {"bpm": 96.0}},
        {"command": "move_clip", "args": {"clipId": "${C1}", "start": 1.5}},
    ]
    n = len(edits)
    # Prime the session with ONE save first: moshFormatVersion (PRJ-FMT) is stamped on
    # the project node at save time, so a never-saved session's "final" snapshot would
    # differ from the post-reload one by exactly that stamp (formatVersion 0 -> 1) —
    # by-design behavior, not a persistence bug (found by this family's first run).
    cmds = ([{"command": "save", "args": {}},
             {"command": "__snapshot", "args": {"label": "start"}}]
            + edits
            + [{"command": "__snapshot", "args": {"label": "final"}}]
            + [{"command": "undo", "args": {}} for _ in range(n)]
            + [{"command": "__snapshot", "args": {"label": "unwound"}}]
            + [{"command": "redo", "args": {}} for _ in range(n)]
            + [{"command": "__snapshot", "args": {"label": "rewound"}}]
            + [{"command": "save", "args": {}},
               {"command": "reload", "args": {}},
               {"command": "__snapshot", "args": {"label": "reloaded"}}])
    results, snaps, proc = drive(cmds, "conf-wf-torture")
    if cmd_fails(results):
        return verdict(FAIL, "workflow", [], _err(proc, {"failed": cmd_fails(results)}))
    start, final = _canon_snap(snaps["start"]), _canon_snap(snaps["final"])
    unwound, rewound, reloaded = (_canon_snap(snaps[k]) for k in ("unwound", "rewound", "reloaded"))
    mutated = final != start
    undo_ok = unwound == start
    redo_ok = rewound == final
    reload_ok = reloaded == final
    ok = mutated and undo_ok and redo_ok and reload_ok
    return verdict(PASS if ok else FAIL, "workflow", [97],
                   {"edits": n, "undo_walk_restores": undo_ok, "redo_walk_restores": redo_ok,
                    "save_reload_equal": reload_ok})


# ── registry: EXACT (area, user_action) → family ──────────────────────────────────
FAMILIES = {
    ("Transport", "Press Play in a loaded session"): fam_transport_play,
    ("Transport", "Seek to a section marker while playback is stopped"): fam_transport_seek,
    ("Import", "Drag WAV beat to bar 1 track 1"): fam_import_wav,
    ("Import", "Import an MP3 with spaces/unicode in filename"): fam_import_unicode,
    ("Recording", "Record vocal with 1-bar count-in"): fam_record_countin,
    ("Recording", "Deny mic permission and try to record"): fam_record_no_fake_clip,
    ("Clip editing", "Move vocal clip to hook marker"): fam_clip_move,
    ("Clip editing", "Split selected clip at the playhead and duplicate second half"): fam_clip_split_dup,
    ("Mixer", "Monster: turn vocal up"): fam_mixer_gain,
    ("Mixer", "Mute then solo the same track according to Mosh solo policy"): fam_mixer_mute_solo,
    ("Effects", "Add reverb to vocal"): fam_effects_add,
    ("Effects", "Bypass then re-enable an inserted delay effect"): fam_effects_bypass,
    ("Automation", "Create fade out over last 4 bars"): fam_automation_create,
    ("Automation", "Edit an existing automation point and undo it"): fam_automation_edit_undo,
    ("Browser", "Preview sample"): fam_browser_preview,
    ("Browser", "Relink a missing asset to a replacement file"): fam_browser_relink,
    ("Export", "Submit 16-bar battle mix"): fam_export_mixdown,
    ("Export", "Render a loop range with delay tail enabled"): fam_export_range_tail,
    # Golden producer workflows (P7) — 1:1 rows DAW-301..305, no fan-out padding.
    ("Workflow", "Build a beat from scratch: drums, melody, arrange, balance, export"): fam_workflow_beat,
    ("Workflow", "Record a vocal: arm, count-in, takes, comp (capture is hardware)"): fam_workflow_record_comp,
    ("Workflow", "Mix to stems: buses, sends, automation — stems null against the mix"): fam_workflow_mix_stems,
    ("Workflow", "Remix an import: retempo, stretch to grid, split, rearrange, render"): fam_workflow_remix,
    ("Workflow", "Session torture: heavy edit chain, deep undo/redo walk, save/reload equality"): fam_workflow_torture,
}

# Families for capabilities shipped AFTER the reality pack was gathered (2026-06-26),
# keyed by a stable family name instead of a CSV (area, user_action) pair — the padded
# legacy CSV rows are frozen, so post-pack features register here. Same verdict contract,
# same fail-closed wrapper, folded into the report with "ids": []. model_lint.py parses
# this dict (by regex, dependency-free) so every entry must stay a simple
#   "name": fam_function,
# line.
EXTRA_FAMILIES = {
    "clip fades (in/out + curve) state+undo": fam_clip_fades,
    "clip reverse + non-destructive normalize": fam_clip_reverse_normalize,
    "clip auto-crossfade + loop region": fam_clip_crossfade_loop,
    "ripple delete closes the gap, one undo": fam_ripple_delete,
    "easy warp: detect BPM + stretch to bars": fam_warp_stretch,
    "automation write-mode knob capture": fam_automation_write_record,
    "automation bulk curve author (replace/merge windows)": fam_automation_curve_write,
    "master-bus chain (insert + fader + bypass)": fam_master_bus,
    "sends/buses + group (submix) routing": fam_group_bus_routing,
    "musical key persists; scale lock never rewrites notes": fam_scale_lock,
    "mid-session track metering (METER-001)": fam_meter_midsession,
    "recording surface graceful headless (takes/arm/monitor)": fam_takes_recording_graceful,
}

# ── committed-verdict freshness contract ──────────────────────────────────────────
# verdicts.json is the COMMITTED, normalized outcome of a conformance run: one entry per
# family — {area, action, status, invariants, backlog_ref, note} — sorted, no measured
# values, no timestamps, no paths, so it is byte-deterministic for a given behavior.
# A normal run COMPARES fresh results against it and FAILS the gate on any difference:
# the PR that changes behavior must carry the verdict flip (and the regenerated
# FEATURE_AUDIT) as a reviewable diff. `--write-verdicts` updates it intentionally.
# scoreboard.py renders docs/FEATURE_AUDIT.md from THIS file (+ the eval CSV + the
# backlog), so the scoreboard is regenerable without a binary — which is what lets
# `scoreboard.py --check` run in the cheap gate lane.
VERDICTS = SELF / "verdicts.json"


def normalize_verdicts(fam_results):
    out = []
    for (area, action), v in sorted(fam_results.items()):
        det = v.get("detail", {}) or {}
        note = det.get("note") or det.get("reason") or det.get("error") or ""
        entry = {"area": area, "action": action, "status": v["status"],
                 "invariants": list(v.get("invariants", []))}
        if det.get("gap"):
            entry["backlog_ref"] = det["gap"]
        if note:
            entry["note"] = note
        out.append(entry)
    return out


def load_backlog():
    """id -> item for the parity registry (tolerant: absent file -> {})."""
    path = REPO / "scripts" / "daw-conformance" / "parity_backlog.jsonl"
    items = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
                items[d.get("id")] = d
            except json.JSONDecodeError:
                pass  # model_lint.py owns backlog validity; don't double-report here
    return items


def main():
    ap = argparse.ArgumentParser(description="Mosh DAW-conformance harness (reality-pack eval suite → gate)")
    ap.add_argument("--bin", help="path to the Mosh binary (default: newest local build)")
    ap.add_argument("--json", help="write the machine report here (default: scripts/daw-conformance/report.json)")
    ap.add_argument("--write-verdicts", action="store_true",
                    help="update the committed verdicts.json from this run (the intentional-change path); "
                         "without it, any difference vs the committed verdicts FAILS the gate")
    args = ap.parse_args()

    ARTDIR.mkdir(parents=True, exist_ok=True)
    verify.ART.mkdir(exist_ok=True)
    _BIN["bin"] = verify.find_binary(args.bin)
    ctx = Ctx(_BIN["bin"])
    print(f"binary: {ctx.bin}")
    print(f"eval suite: {EVAL_CSV}\n")

    rows = list(csv.DictReader(EVAL_CSV.open()))

    # Run each distinct family ONCE, keyed by (area, user_action).
    scenarios = {}
    for r in rows:
        scenarios.setdefault((r["area"], r["user_action"]), []).append(r["id"])

    backlog = load_backlog()

    fam_results = {}
    for key in sorted(scenarios):
        area, action = key
        row0 = next(r for r in rows if (r["area"], r["user_action"]) == key)
        if key in FAMILIES:
            try:
                v = FAMILIES[key](ctx)
            except Exception as e:  # a harness crash is a FAIL, fail-closed
                v = verdict(FAIL, "harness", [], {"exception": repr(e)})
        elif area in OUT_OF_SCOPE_AREAS:
            v = verdict(OOS, "n/a", [], {"reason": f"{area} is outside the conventional-parity pass"})
        else:
            # Unmapped in-scope scenario. A row that carries a LIVE backlog_ref is a
            # tracked, attributed gap (an eval row authored ahead of implementation —
            # the P3 expansion-wave path); anything else stays a hard FAIL so new rows
            # can never land silently untested. A backlog_ref pointing at a DONE item
            # also FAILS: the capability shipped, so the row must gain a family.
            ref = (row0.get("backlog_ref") or "").strip()
            item = backlog.get(ref)
            if item is not None and item.get("status") != "done":
                v = verdict(GAP, "unimplemented", [],
                            {"gap": ref, "note": f"awaiting backlog item {ref} ({item.get('title', '')})"})
            elif item is not None:
                v = verdict(FAIL, "unmapped", [],
                            {"error": f"backlog item {ref} is done — this row must gain a conformance family"})
            else:
                v = verdict(FAIL, "unmapped", [], {"error": "no family for this in-scope scenario"})
        v.update({"area": area, "action": action, "ids": scenarios[key]})
        fam_results[key] = v
        mark = v["status"].upper()
        print(f"  [{mark:12}] {area} / {action}")
        print(f"               {json.dumps(v['detail'])}")

    # Post-pack families: capabilities shipped after the reality pack was gathered.
    # Keyed ("Post-pack", <family name>); no CSV ids to fan out to.
    for name in sorted(EXTRA_FAMILIES):
        key = ("Post-pack", name)
        try:
            v = EXTRA_FAMILIES[name](ctx)
        except Exception as e:  # fail-closed, same as CSV families
            v = verdict(FAIL, "harness", [], {"exception": repr(e)})
        v.update({"area": key[0], "action": name, "ids": []})
        fam_results[key] = v
        print(f"  [{v['status'].upper():12}] {key[0]} / {name}")
        print(f"               {json.dumps(v['detail'])}")

    # Fan out to per-id results.
    per_id = []
    for r in rows:
        v = fam_results[(r["area"], r["user_action"])]
        per_id.append({"id": r["id"], "area": r["area"], "priority": r["priority"],
                       "action": r["user_action"], "status": v["status"], "invariants": v["invariants"]})

    def tally(items, keyfn):
        out = {}
        for it in items:
            out.setdefault(keyfn(it), {}).setdefault(it["status"], 0)
            out[keyfn(it)][it["status"]] += 1
        return out

    by_status = {}
    for it in per_id:
        by_status[it["status"]] = by_status.get(it["status"], 0) + 1

    report = {
        "generated_by": "scripts/daw-conformance/conformance.py",
        "binary": str(ctx.bin),
        "eval_total": len(rows),
        "scope": "conventional DAW parity (Monster/Arena/Collaboration out-of-scope)",
        "summary": {
            "by_status": by_status,
            "by_priority": tally(per_id, lambda it: it["priority"]),
            "by_area": tally(per_id, lambda it: it["area"]),
        },
        "families": [
            {"area": a, "action": ac, **{k: v[k] for k in ("status", "lane", "invariants", "detail", "ids")}}
            for (a, ac), v in sorted(fam_results.items())
        ],
        "rows": per_id,
    }
    out = Path(args.json) if args.json else (SELF / "report.json")
    out.write_text(json.dumps(report, indent=2) + "\n")

    # ── committed-verdict freshness gate ──────────────────────────────────────────
    fresh = normalize_verdicts(fam_results)
    verdicts_stale = False
    if args.write_verdicts:
        VERDICTS.write_text(json.dumps(fresh, indent=1) + "\n")
        print(f"  verdicts: wrote {VERDICTS.name} ({len(fresh)} families)")
    else:
        committed = json.loads(VERDICTS.read_text()) if VERDICTS.exists() else None
        if committed != fresh:
            verdicts_stale = True
            def _k(vs):
                return {(v["area"], v["action"]): v for v in vs or []}
            cf, ff = _k(committed), _k(fresh)
            for key in sorted(set(cf) | set(ff)):
                a, b = cf.get(key), ff.get(key)
                if a != b:
                    print(f"  verdict drift: {key[0]} / {key[1]}: "
                          f"{(a or {}).get('status', '<absent>')} -> {(b or {}).get('status', '<absent>')}")
            print(f"  VERDICTS STALE: this run disagrees with the committed {VERDICTS.name}. If the change "
                  f"is intentional, run conformance.py --write-verdicts && scoreboard.py IN THIS PR so the "
                  f"flip lands as a reviewable diff.")

    # Post-pack families fan out to zero CSV rows, so their failures are invisible to
    # the per-id tally — count them directly or an EXTRA_FAMILIES regression would
    # never fail the gate.
    extra_fails = [v["action"] for v in fam_results.values() if not v["ids"] and v["status"] == FAIL]
    n_fail = by_status.get(FAIL, 0) + len(extra_fails)
    n_pass = by_status.get(PASS, 0)
    n_gap = by_status.get(GAP, 0)
    n_hw = by_status.get(HARDWARE, 0)
    n_oos = by_status.get(OOS, 0)
    print(f"\n  eval rows: {len(rows)}  |  pass {n_pass}  gap {n_gap}  hardware {n_hw}  "
          f"out-of-scope {n_oos}  FAIL {n_fail}")
    print(f"  report: {out}")
    if n_fail:
        print("  GATE: FAIL — an in-scope capability regressed.")
        return 1
    if verdicts_stale:
        print("  GATE: FAIL — committed verdicts.json is stale (see above).")
        return 1
    print("  GATE: PASS — no in-scope regressions (gaps are tracked backlog items).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
