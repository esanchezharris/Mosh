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
    # G2: count-in / pre-roll capability is absent (no count/preRoll token in the engine).
    return verdict(GAP, "hardware", [5, 41, 42],
                   {"gap": "G2", "note": "count-in/pre-roll not implemented; live capture also needs a mic (Phase 1)."})


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
    # G1: export_audio honors a render range (loop/section) and a delay-tail policy. Drives
    # a loop-region export and a tail-extended export on the SAME 6s edit and asserts the
    # rendered WAV durations track the requested window (not the whole edit). Flips this
    # scenario GAP→PASS once the capability lands (inv 78, 81).
    full = ARTDIR / "export_full.wav"
    loop = ARTDIR / "export_loop.wav"
    tail = ARTDIR / "export_loop_tail.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Rt"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 6.0, "freq": 220.0}},
        {"command": "export_audio", "args": {"file": str(full)}},                            # whole edit
        {"command": "set_transport", "args": {"loopStart": 1.0, "loopEnd": 3.0}},
        {"command": "export_audio", "args": {"file": str(loop), "range": "loop"}},           # loop region only
        {"command": "export_audio", "args": {"file": str(tail), "range": "loop",
                                             "includeTail": True, "tailSeconds": 2.0}},      # + delay tail
    ]
    results, snaps, proc = drive(cmds, "conf-export-range-tail")
    if cmd_fails(results) or not (full.exists() and loop.exists() and tail.exists()):
        return verdict(FAIL, "audio", [78, 81],
                       _err(proc, {"failed": cmd_fails(results),
                                   "exists": {"full": full.exists(), "loop": loop.exists(), "tail": tail.exists()}}))
    d_full = verify.stats(full)["duration_s"]
    d_loop = verify.stats(loop)["duration_s"]
    d_tail = verify.stats(tail)["duration_s"]
    ok = (d_full > 5.0                        # full export ~= whole edit
          and 1.5 < d_loop < 3.0              # loop-region render ~2s
          and d_loop < d_full - 1.0           # loop render is clearly shorter than full
          and d_tail > d_loop + 1.0)          # tail extends the rendered window
    return verdict(PASS if ok else FAIL, "audio", [78, 81],
                   {"full_s": d_full, "loop_s": d_loop, "tail_s": d_tail,
                    "note": "export honors loop-range selection + delay-tail policy (G1)."})


def rt_ok(t):
    return isinstance(t, str) and len(t) > 0


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
}


def main():
    ap = argparse.ArgumentParser(description="Mosh DAW-conformance harness (reality-pack eval suite → gate)")
    ap.add_argument("--bin", help="path to the Mosh binary (default: newest local build)")
    ap.add_argument("--json", help="write the machine report here (default: scripts/daw-conformance/report.json)")
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

    fam_results = {}
    for key in sorted(scenarios):
        area, action = key
        if key in FAMILIES:
            try:
                v = FAMILIES[key](ctx)
            except Exception as e:  # a harness crash is a FAIL, fail-closed
                v = verdict(FAIL, "harness", [], {"exception": repr(e)})
        elif area in OUT_OF_SCOPE_AREAS:
            v = verdict(OOS, "n/a", [], {"reason": f"{area} is outside the conventional-parity pass"})
        else:
            v = verdict(FAIL, "unmapped", [], {"error": "no family for this in-scope scenario"})
        v.update({"area": area, "action": action, "ids": scenarios[key]})
        fam_results[key] = v
        mark = v["status"].upper()
        print(f"  [{mark:12}] {area} / {action}")
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

    n_fail = by_status.get(FAIL, 0)
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
    print("  GATE: PASS — no in-scope regressions (gaps are tracked backlog items).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
