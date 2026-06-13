#!/usr/bin/env python3
"""Focused Maolan contract UI gate.

Launches the native app with MOSH_ENGINE_BACKEND=maolan, opens the engine
contract popover, clicks the thin workflow surface, and validates the same
evidence files that the headless Maolan MoshOps routing gate expects.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    import Quartz
except ModuleNotFoundError:
    fallback = os.environ.get("MOSH_PYTHON", "/opt/homebrew/bin/python3")
    if Path(fallback).exists() and Path(sys.executable).resolve() != Path(fallback).resolve():
        os.execv(fallback, [fallback, *sys.argv])
    raise


REPO = Path(__file__).resolve().parents[1]
APP_BIN = Path(os.environ.get(
    "MOSH_APP_BIN",
    REPO / "build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh",
))
COMMAND_LOG = Path.home() / "Library/Mosh/session/mosh-log.jsonl"
EVID = Path(os.environ.get(
    "MOSH_EVID",
    REPO / "_preserved_artifacts" / f"{datetime.now().strftime('%Y-%m-%d')}-maolan-contract-ui"
    / datetime.now().strftime("%Y%m%d-%H%M%S"),
))

AX_HELPER = r'''
import ApplicationServices
import AppKit

let appName = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Mosh"
let apps = NSWorkspace.shared.runningApplications.filter { $0.localizedName == appName }
guard let app = apps.first else { exit(2) }
let root = AXUIElementCreateApplication(app.processIdentifier)

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(el, name as CFString, &value)
    return err == .success ? value : nil
}

func point(_ value: AnyObject?) -> CGPoint? {
    guard let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axv = value as! AXValue
    guard AXValueGetType(axv) == .cgPoint else { return nil }
    var p = CGPoint.zero
    AXValueGetValue(axv, .cgPoint, &p)
    return p
}

func size(_ value: AnyObject?) -> CGSize? {
    guard let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axv = value as! AXValue
    guard AXValueGetType(axv) == .cgSize else { return nil }
    var s = CGSize.zero
    AXValueGetValue(axv, .cgSize, &s)
    return s
}

func esc(_ value: String?) -> String {
    return (value ?? "").replacingOccurrences(of: "\t", with: " ")
}

var count = 0
func walk(_ el: AXUIElement) {
    if count > 1800 { return }
    count += 1
    let role = attr(el, kAXRoleAttribute) as? String
    let title = attr(el, kAXTitleAttribute) as? String
    let desc = attr(el, kAXDescriptionAttribute) as? String
    let help = attr(el, kAXHelpAttribute) as? String
    let enabled = (attr(el, kAXEnabledAttribute) as? Bool) ?? true
    let p = point(attr(el, kAXPositionAttribute))
    let s = size(attr(el, kAXSizeAttribute))
    if role != nil || title != nil || help != nil {
        let fields: [String] = [
            esc(role),
            esc(title),
            esc(desc),
            esc(help),
            String(Double(p?.x ?? -1)),
            String(Double(p?.y ?? -1)),
            String(Double(s?.width ?? -1)),
            String(Double(s?.height ?? -1)),
            enabled ? "1" : "0"
        ]
        print(fields.joined(separator: "\t"))
    }
    let children = attr(el, kAXChildrenAttribute) as? [AXUIElement] ?? []
    for child in children { walk(child) }
}

walk(root)
'''

AX_PRESSER = r'''
import ApplicationServices
import AppKit

let appName = CommandLine.arguments.count > 2 ? CommandLine.arguments[1] : "Mosh"
let needle = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
let apps = NSWorkspace.shared.runningApplications.filter { $0.localizedName == appName }
guard let app = apps.first else { exit(2) }
let root = AXUIElementCreateApplication(app.processIdentifier)

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(el, name as CFString, &value)
    return err == .success ? value : nil
}

func text(_ el: AXUIElement) -> String {
    let parts = [
        attr(el, kAXTitleAttribute) as? String ?? "",
        attr(el, kAXDescriptionAttribute) as? String ?? "",
        attr(el, kAXHelpAttribute) as? String ?? ""
    ]
    return parts.joined(separator: " ")
}

func walk(_ el: AXUIElement) -> Bool {
    let role = attr(el, kAXRoleAttribute) as? String ?? ""
    let enabled = (attr(el, kAXEnabledAttribute) as? Bool) ?? true
    if role == "AXButton" && enabled && text(el).contains(needle) {
        let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
        exit(err == .success ? 0 : 3)
    }
    let children = attr(el, kAXChildrenAttribute) as? [AXUIElement] ?? []
    for child in children {
        if walk(child) { return true }
    }
    return false
}

_ = walk(root)
exit(4)
'''


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=check)


def kill_mosh() -> None:
    run(["pkill", "-f", str(APP_BIN)], check=False)
    time.sleep(0.8)


def command_log_marker() -> int:
    try:
        return COMMAND_LOG.stat().st_size
    except FileNotFoundError:
        return 0


def command_records(marker: int) -> list[dict]:
    try:
        with COMMAND_LOG.open("r", encoding="utf-8") as fh:
            fh.seek(marker)
            tail = fh.read()
    except FileNotFoundError:
        return []

    records: list[dict] = []
    for line in tail.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            records.append(item)
    return records


def wait_for_command(command: str, marker: int, timeout: float = 180.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for item in command_records(marker):
            if item.get("command") == command and item.get("ok") is True:
                return
        time.sleep(0.5)
    raise RuntimeError(f"timed out waiting for MoshOps command {command!r}")


def windows() -> list[dict]:
    infos = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID) or []
    return [dict(info) for info in infos if info.get("kCGWindowOwnerName") == "Mosh"]


def wait_for_window(timeout: float = 14.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        wins = windows()
        if wins:
            return wins[0]
        time.sleep(0.25)
    raise RuntimeError("Mosh window not found")


def activate() -> None:
    run(["osascript", "-e", 'tell application "Mosh" to activate'], check=False)
    time.sleep(0.25)


def ax_helper_path() -> Path:
    EVID.mkdir(parents=True, exist_ok=True)
    path = EVID / "axdump.swift"
    if not path.exists() or path.read_text(encoding="utf-8") != AX_HELPER:
        path.write_text(AX_HELPER, encoding="utf-8")
    return path


def ax_presser_path() -> Path:
    EVID.mkdir(parents=True, exist_ok=True)
    path = EVID / "axpress.swift"
    if not path.exists() or path.read_text(encoding="utf-8") != AX_PRESSER:
        path.write_text(AX_PRESSER, encoding="utf-8")
    return path


def ax_rows() -> list[dict]:
    proc = run(["swift", str(ax_helper_path()), "Mosh"])
    (EVID / "last-ax.tsv").write_text(proc.stdout, encoding="utf-8")
    rows: list[dict] = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 9:
            continue
        role, title, desc, help_text, x, y, w, h, enabled = parts
        rows.append({
            "role": role,
            "title": title,
            "desc": desc,
            "help": help_text,
            "x": float(x),
            "y": float(y),
            "w": float(w),
            "h": float(h),
            "enabled": enabled == "1",
        })
    return rows


def ax_text(row: dict) -> str:
    return " ".join(str(row.get(k, "")) for k in ("title", "desc", "help"))


def ax_find_button(text: str, timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for row in ax_rows():
            if row["role"] == "AXButton" and text in ax_text(row) and row["w"] > 0 and row["h"] > 0:
                return row
        time.sleep(0.25)
    raise RuntimeError(f"AX button not found: {text}")


def mouse_click_xy(x: float, y: float) -> None:
    activate()
    point = Quartz.CGPoint(x, y)
    source = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    down = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseDown, point, Quartz.kCGMouseButtonLeft)
    up = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseUp, point, Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    time.sleep(0.08)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
    time.sleep(0.5)


def click_ax(row: dict) -> None:
    mouse_click_xy(row["x"] + row["w"] / 2.0, row["y"] + row["h"] / 2.0)


def ax_press_button(text: str) -> None:
    activate()
    proc = run(["swift", str(ax_presser_path()), "Mosh", text], check=False)
    if proc.returncode != 0:
        # Keep a coordinate fallback because WebView AXPress availability can vary
        # by macOS/WebKit build.
        click_ax(ax_find_button(text))
    time.sleep(0.5)


def capture(name: str) -> str:
    win = wait_for_window()
    out = EVID / f"{name}.png"
    run(["screencapture", "-x", "-l", str(win["kCGWindowNumber"]), str(out)])
    return str(out)


def validate_artifacts(marker: int) -> dict:
    backend_log = EVID / "command-log.jsonl"
    timing = EVID / "timing.csv"
    render = EVID / "render-smoke" / "maolan-render-smoke.wav"
    stats = EVID / "render-smoke" / "maolan-render-smoke-stats.json"
    playback_stats = EVID / "playback-smoke" / "maolan-play-session-smoke-stats.json"
    maolan_session = EVID / "render-smoke" / "maolan-session" / "main.json"
    session = EVID / "session-graph.json"
    restored = EVID / "restored-session-graph.json"

    required = [backend_log, timing, render, stats, playback_stats, maolan_session, session, restored]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError("missing required UI gate artifacts: " + ", ".join(missing))
    if render.stat().st_size <= 0:
        raise RuntimeError(f"render WAV is empty: {render}")
    playback = json.loads(playback_stats.read_text(encoding="utf-8"))
    if playback.get("playback_source") != "maolan-session-playback":
        raise RuntimeError(f"playback stats did not use Maolan session playback: {playback.get('playback_source')}")
    if playback.get("play_started") is not True:
        raise RuntimeError("playback stats do not confirm play start")
    if playback.get("stop_confirmed") is not True:
        raise RuntimeError("playback stats do not confirm stop")
    if int(playback.get("transport_sample") or 0) <= 0:
        raise RuntimeError("playback stats do not report transport movement")
    if int(playback.get("vst3_instances") or 0) < 1:
        raise RuntimeError("playback stats do not report a restored VST3 instance")
    if int(playback.get("workers_ready") or 0) < int(playback.get("workers_total") or 1):
        raise RuntimeError("playback stats report incomplete Maolan worker readiness")
    during_play = playback.get("during_play") or {}
    stopped = playback.get("stopped") or {}
    if during_play.get("playing") is not True:
        raise RuntimeError("playback stats do not show transport playing during probe")
    if stopped.get("playing") is not False:
        raise RuntimeError("playback stats do not show stopped transport after probe")

    moshops_records = command_records(marker)
    moshops_commands = [item.get("command") for item in moshops_records if item.get("ok") is True]
    for command in (
        "new_project",
        "set_audio_device",
        "rescan_plugins",
        "create_track",
        "load_plugin",
        "add_test_tone_clip",
        "split_clip",
        "set_transport",
        "export_audio",
        "save",
        "reload",
    ):
        if command not in moshops_commands:
            raise RuntimeError(f"MoshOps log missing {command}: {moshops_commands}")

    backend_ops = []
    for line in backend_log.read_text(encoding="utf-8").splitlines():
        if line.strip():
            backend_ops.append(json.loads(line).get("operation"))
    for operation in (
        "createSession",
        "selectAudioDevice",
        "scanPlugins",
        "createTrack",
        "loadPlugin",
        "addClip",
        "splitClip",
        "setTransport",
        "renderExport",
        "saveSessionGraph",
        "restoreSessionGraph",
    ):
        if operation not in backend_ops:
            raise RuntimeError(f"backend log missing {operation}: {backend_ops}")

    render_stats = json.loads(stats.read_text(encoding="utf-8"))
    if not render_stats.get("session_dir"):
        raise RuntimeError("render stats do not prove Maolan session export")
    if render_stats.get("render_source") != "maolan-offline-bounce":
        raise RuntimeError(f"render stats did not use Maolan offline bounce: {render_stats.get('render_source')}")
    if render_stats.get("plugin_graph_applied") is not True:
        raise RuntimeError("render stats do not prove plugin graph application")
    if int(render_stats.get("vst3_instances") or 0) < 1:
        raise RuntimeError("render stats do not report a restored VST3 instance")
    if int(render_stats.get("workers_ready") or 0) < int(render_stats.get("workers_total") or 1):
        raise RuntimeError("render stats report incomplete Maolan worker readiness")
    bounced_tracks = render_stats.get("bounced_tracks") or []
    if not bounced_tracks:
        raise RuntimeError("render stats do not include bounced track artifacts")
    for bounced in bounced_tracks:
        path = Path(bounced.get("path") or "")
        if not path.exists() or path.stat().st_size <= 44:
            raise RuntimeError(f"bounced track WAV missing or empty: {path}")
    maolan_data = json.loads(maolan_session.read_text(encoding="utf-8"))
    graphs = maolan_data.get("graphs") or {}
    if not graphs:
        raise RuntimeError("Maolan session JSON is missing native plugin graphs")
    graph_values = list(graphs.values())
    plugins = [plugin for graph in graph_values for plugin in (graph.get("plugins") or [])]
    if not any(
        plugin.get("format") == "VST3" and "JamPilotTestGain.vst3" in (plugin.get("uri") or "")
        for plugin in plugins
    ):
        raise RuntimeError("Maolan session JSON does not include JamPilotTestGain.vst3 as a VST3 graph plugin")

    def node_type(node: object) -> object:
        if isinstance(node, dict):
            return node.get("type")
        if node == "TrackInput":
            return "track_input"
        if node == "TrackOutput":
            return "track_output"
        return node

    if not any(
        node_type(conn.get("from_node")) == "vst3_plugin" or node_type(conn.get("to_node")) == "vst3_plugin"
        for graph in graph_values
        for conn in (graph.get("connections") or [])
    ):
        raise RuntimeError("Maolan session JSON does not connect the VST3 plugin graph")
    session_graph = json.loads(session.read_text(encoding="utf-8"))
    tracks = session_graph.get("tracks") or []
    if len(tracks) != 1:
        raise RuntimeError(f"UI session graph expected one track, got {len(tracks)}")
    clips = tracks[0].get("clips") or []
    if len(clips) != 2:
        raise RuntimeError(f"UI session graph expected two clips after split, got {len(clips)}")
    clips_by_id = {clip.get("id"): clip for clip in clips}
    expected_clips = {
        "maolan-ui-tone-1": {"startSeconds": 0.0, "lengthSeconds": 0.5, "offsetSeconds": 0.0},
        "maolan-ui-tone-1-split": {"startSeconds": 0.5, "lengthSeconds": 0.5, "offsetSeconds": 0.5},
    }
    for clip_id, expected in expected_clips.items():
        clip = clips_by_id.get(clip_id)
        if clip is None:
            raise RuntimeError(f"UI session graph missing split clip: {clip_id}")
        for key, value in expected.items():
            if abs(float(clip.get(key, 0.0)) - value) > 0.01:
                raise RuntimeError(f"UI session graph did not preserve {clip_id} {key}: {clip.get(key)}")
    return {
        "backend_command_log": str(backend_log),
        "timing_csv": str(timing),
        "render_wav": str(render),
        "render_stats": str(stats),
        "playback_stats": str(playback_stats),
        "maolan_session_json": str(maolan_session),
        "session_graph": str(session),
        "restored_session_graph": str(restored),
        "backend_operations": backend_ops,
        "moshops_commands": moshops_commands,
        "render": {
            "bytes": render_stats.get("bytes"),
            "duration_seconds": render_stats.get("duration_seconds"),
            "peak": render_stats.get("peak"),
            "rms": render_stats.get("rms"),
            "sample_rate": render_stats.get("sample_rate"),
            "frames": render_stats.get("frames"),
        },
        "playback": playback,
    }


def main() -> int:
    if not APP_BIN.exists():
        raise SystemExit(f"missing Mosh app binary: {APP_BIN}")

    EVID.mkdir(parents=True, exist_ok=True)
    kill_mosh()
    marker = command_log_marker()
    env = os.environ.copy()
    env["MOSH_ENGINE_BACKEND"] = "maolan"
    env["MOSH_REPO_ROOT"] = str(REPO)
    env["MOSH_ENGINE_CONTRACT_OUTPUT_DIR"] = str(EVID)
    env.setdefault("MOSH_NO_AUDIO", "1")

    stdout = (EVID / "app.stdout.log").open("w", encoding="utf-8")
    stderr = (EVID / "app.stderr.log").open("w", encoding="utf-8")
    proc = subprocess.Popen([str(APP_BIN), "-ApplePersistenceIgnoreState", "YES"],
                            cwd=str(REPO), env=env, stdout=stdout, stderr=stderr, text=True)

    try:
        wait_for_window()
        capture("01-launched")
        ax_press_button("Engine")
        time.sleep(0.8)
        capture("02-engine-panel")
        ax_press_button("Run workflow")
        wait_for_command("reload", marker)
        time.sleep(0.8)
        capture("03-workflow-complete")
        artifacts = validate_artifacts(marker)
        summary = {
            "status": "PASS",
            "gate": "maolan-contract-ui",
            "artifact_dir": str(EVID),
            "screenshots": {
                "launched": str(EVID / "01-launched.png"),
                "engine_panel": str(EVID / "02-engine-panel.png"),
                "workflow_complete": str(EVID / "03-workflow-complete.png"),
            },
            "artifacts": artifacts,
        }
        (EVID / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"MOSH Maolan contract UI: PASS evidence={EVID}")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)
        stdout.close()
        stderr.close()
        kill_mosh()


if __name__ == "__main__":
    raise SystemExit(main())
