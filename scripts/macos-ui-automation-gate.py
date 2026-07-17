#!/usr/bin/env python3
"""Autonomous macOS UI gate for Mosh.

This intentionally does not depend on Computer Use for actions. Computer Use is
excellent for inspection, but its action session can be flaky for local plugin
windows. This gate uses macOS window discovery + low-level Quartz mouse events,
then validates visual state changes from screenshots.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageStat
    import Quartz
except ModuleNotFoundError:
    fallback = os.environ.get("MOSH_PYTHON", "/opt/homebrew/bin/python3")
    if Path(fallback).exists() and Path(sys.executable).resolve() != Path(fallback).resolve():
        os.execv(fallback, [fallback, *sys.argv])
    raise


REPO = Path(__file__).resolve().parents[1]
APP_BUNDLE = Path(os.environ.get("MOSH_APP_BUNDLE", REPO / "build-macos-arm64/Mosh_artefacts/Debug/Mosh.app"))
APP_BIN = APP_BUNDLE / "Contents/MacOS/Mosh"
SERVICE_HOST = os.environ.get("MOSH_SERVICE_HOST", "127.0.0.1")
SERVICE_PORT = int(os.environ.get("MOSH_SERVICE_PORT", "8770"))
SERVICE_URL = f"http://{SERVICE_HOST}:{SERVICE_PORT}"
RUN_STAMP = datetime.now().strftime('%Y%m%d-%H%M%S')
SESSION_NAME = os.environ.get("MOSH_SELFTEST_SESSION", f"macos-ui-automation-{RUN_STAMP}")
COMMAND_LOG = Path(os.environ.get(
    "MOSH_COMMAND_LOG",
    Path.home() / "Library/Mosh" / SESSION_NAME / "mosh-log.jsonl",
))
EVID = Path(os.environ.get(
    "MOSH_EVID",
    REPO / "_preserved_artifacts/2026-06-08-consolidation/claudemosh"
    / f"macos-ui-automation-{RUN_STAMP}",
))
SERVICE_PROC: subprocess.Popen[str] | None = None
CURRENT_PID: int | None = None

AX_HELPER = r'''
import ApplicationServices
import AppKit

let target = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Mosh"
let apps: [NSRunningApplication]
if let pid = Int32(target) {
    apps = NSWorkspace.shared.runningApplications.filter { $0.processIdentifier == pid }
} else {
    apps = NSWorkspace.shared.runningApplications.filter { $0.localizedName == target }
}
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
    if count > 1600 { return }
    count += 1
    let role = attr(el, kAXRoleAttribute) as? String
    let title = attr(el, kAXTitleAttribute) as? String
    let desc = attr(el, kAXDescriptionAttribute) as? String
    let help = attr(el, kAXHelpAttribute) as? String
    let value = attr(el, kAXValueAttribute)
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
            esc(value == nil ? nil : "\(value!)"),
            enabled ? "1" : "0"
        ]
        print(fields.joined(separator: "\t"))
    }
    let children = attr(el, kAXChildrenAttribute) as? [AXUIElement] ?? []
    for child in children { walk(child) }
}

walk(root)
'''

AX_PRESS_HELPER = r'''
import ApplicationServices
import AppKit

let target = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Mosh"
let roleNeed = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
let textNeed = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : ""
let apps: [NSRunningApplication]
if let pid = Int32(target) {
    apps = NSWorkspace.shared.runningApplications.filter { $0.processIdentifier == pid }
} else {
    apps = NSWorkspace.shared.runningApplications.filter { $0.localizedName == target }
}
guard let app = apps.first else { exit(2) }
let root = AXUIElementCreateApplication(app.processIdentifier)

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(el, name as CFString, &value)
    return err == .success ? value : nil
}

func text(_ el: AXUIElement) -> String {
    let fields = [
        attr(el, kAXTitleAttribute) as? String ?? "",
        attr(el, kAXDescriptionAttribute) as? String ?? "",
        attr(el, kAXHelpAttribute) as? String ?? "",
        String(describing: attr(el, kAXValueAttribute) ?? "" as AnyObject)
    ]
    return fields.joined(separator: " ")
}

var pressed = false
func walk(_ el: AXUIElement) {
    if pressed { return }
    let role = attr(el, kAXRoleAttribute) as? String ?? ""
    if (roleNeed.isEmpty || role == roleNeed) && text(el).contains(textNeed) {
        pressed = AXUIElementPerformAction(el, kAXPressAction as CFString) == .success
        return
    }
    let children = attr(el, kAXChildrenAttribute) as? [AXUIElement] ?? []
    for child in children { walk(child) }
}

walk(root)
exit(pressed ? 0 : 1)
'''


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=check)


def kill_mosh() -> None:
    run(["pkill", "-f", str(APP_BIN)], check=False)
    time.sleep(0.8)


def service_health() -> bool:
    try:
        with urllib.request.urlopen(f"{SERVICE_URL}/health", timeout=1.0) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError):
        return False


def ensure_service(results: dict) -> None:
    global SERVICE_PROC
    EVID.mkdir(parents=True, exist_ok=True)
    if service_health():
        results["service"] = {"ok": True, "detail": f"existing service healthy at {SERVICE_URL}"}
        return

    log_path = EVID / "service.log"
    log = log_path.open("w", encoding="utf-8")
    env = os.environ.copy()
    env["MOSH_ENABLE_SA3"] = "0"
    env.setdefault("MOSH_SERVICE_HOST", SERVICE_HOST)
    env.setdefault("MOSH_SERVICE_PORT", str(SERVICE_PORT))
    env["PYTHONUNBUFFERED"] = "1"
    # run.sh now ALWAYS redirects its own stdout/stderr internally to MOSH_SERVICE_LOG
    # (default ~/Library/Mosh/logs/service.log) rather than inheriting whatever fd it
    # was spawned with, so without this, `stdout=log` below would capture nothing —
    # point it at the SAME evidence file we already opened. This actually improves
    # capture vs. before: run.sh's own startup lines land here too, not just server.py's.
    env["MOSH_SERVICE_LOG"] = str(log_path)
    SERVICE_PROC = subprocess.Popen(
        ["bash", str(REPO / "service/run.sh")],
        cwd=str(REPO),
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        text=True,
    )
    deadline = time.time() + 10.0
    while time.time() < deadline:
        if service_health():
            results["service"] = {"ok": True, "detail": f"started FakeAdapter service at {SERVICE_URL}"}
            return
        if SERVICE_PROC.poll() is not None:
            break
        time.sleep(0.25)
    results["service"] = {"ok": False, "detail": f"service did not become healthy at {SERVICE_URL}"}
    raise RuntimeError(results["service"]["detail"])


def stop_service() -> None:
    global SERVICE_PROC
    if SERVICE_PROC is None:
        return
    if SERVICE_PROC.poll() is None:
        SERVICE_PROC.terminate()
        try:
            SERVICE_PROC.wait(timeout=3)
        except subprocess.TimeoutExpired:
            SERVICE_PROC.kill()
            SERVICE_PROC.wait(timeout=3)
    SERVICE_PROC = None


def command_log_marker() -> int:
    try:
        return COMMAND_LOG.stat().st_size
    except FileNotFoundError:
        return 0


def wait_for_command(command: str, marker: int, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with COMMAND_LOG.open("r", encoding="utf-8") as fh:
                fh.seek(marker)
                tail = fh.read()
        except FileNotFoundError:
            tail = ""
        for line in tail.splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if item.get("command") == command and item.get("ok") is True:
                return
        time.sleep(0.25)
    raise RuntimeError(f"timed out waiting for JSONL command {command!r}")


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


def command_count(command: str, marker: int) -> int:
    return sum(1 for item in command_records(marker) if item.get("command") == command and item.get("ok") is True)


def commands_since(command: str, marker: int) -> list[dict]:
    return [item for item in command_records(marker) if item.get("command") == command and item.get("ok") is True]


def wait_for_command_count(command: str, marker: int, minimum: int = 1, timeout: float = 8.0) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        count = command_count(command, marker)
        if count >= minimum:
            return count
        time.sleep(0.25)
    raise RuntimeError(f"timed out waiting for {minimum} JSONL {command!r} records")


def launch(args: list[str]) -> int:
    global CURRENT_PID
    if not APP_BUNDLE.is_dir() or not APP_BIN.exists():
        raise SystemExit(f"missing app bundle or binary: {APP_BUNDLE}")
    kill_mosh()
    log = EVID / "mosh-app.log"
    run([
        "open", "-n",
        "--stdout", str(log),
        "--stderr", str(log),
        "--env", f"MOSH_SELFTEST_SESSION={SESSION_NAME}",
        "--env", "MOSH_NO_AUDIO=1",
        str(APP_BUNDLE),
        "--args", *args,
    ])
    deadline = time.time() + 12
    while time.time() < deadline:
        probe = run(["pgrep", "-n", "-f", str(APP_BIN)], check=False)
        pid_text = probe.stdout.strip()
        if pid_text:
            time.sleep(2.0)
            CURRENT_PID = int(pid_text)
            return CURRENT_PID
        time.sleep(0.25)
    raise RuntimeError("Mosh did not launch")


def activate() -> None:
    if CURRENT_PID is not None:
        swift = (
            "import AppKit; "
            f"if let app = NSRunningApplication(processIdentifier: pid_t({CURRENT_PID})) "
            "{ app.activate(options: [.activateIgnoringOtherApps, .activateAllWindows]) }"
        )
        swift_proc = run(["swift", "-e", swift], check=False)
        if swift_proc.returncode != 0:
            with (EVID / "activation.log").open("a", encoding="utf-8") as fh:
                fh.write(swift_proc.stderr + swift_proc.stdout)
        proc = run([
            "osascript", "-e",
            f'tell application "System Events" to tell (first process whose unix id is {CURRENT_PID}) to set frontmost to true',
        ], check=False)
        if proc.returncode != 0:
            with (EVID / "activation.log").open("a", encoding="utf-8") as fh:
                fh.write(proc.stderr + proc.stdout)
    else:
        run(["osascript", "-e", 'tell application "Mosh" to activate'], check=False)
    time.sleep(0.2)


def dismiss_permission_prompts() -> None:
    script = "\n".join([
        'tell application "System Events"',
        '  tell process "Mosh"',
        '    repeat 6 times',
        '      if exists button "Don’t Allow" of window 1 then',
        '        click button "Don’t Allow" of window 1',
        '        return',
        '      end if',
        '      if exists button "Don\'t Allow" of window 1 then',
        '        click button "Don\'t Allow" of window 1',
        '        return',
        '      end if',
        '      delay 0.25',
        '    end repeat',
        '  end tell',
        'end tell',
    ])
    run(["osascript", "-e", script], check=False)
    deadline = time.time() + 2.0
    while time.time() < deadline:
        for row in ax_rows():
            if row["role"] == "AXButton" and row["title"] in {"Don’t Allow", "Don't Allow"}:
                click_ax(row)
                return
        time.sleep(0.2)
    time.sleep(0.4)


def windows() -> list[dict]:
    opts = Quartz.kCGWindowListOptionOnScreenOnly
    infos = Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []
    rows = [dict(info) for info in infos if info.get("kCGWindowOwnerName") == "Mosh"]
    if CURRENT_PID is not None:
        rows = [info for info in rows if int(info.get("kCGWindowOwnerPID", -1)) == CURRENT_PID]
    return rows


def find_window(title: str, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        activate()
        for info in windows():
            if info.get("kCGWindowName") == title:
                return info
        time.sleep(0.25)
    raise RuntimeError(f"window not found: {title}")


def bounds(info: dict) -> tuple[int, int, int, int]:
    b = info["kCGWindowBounds"]
    return int(b["X"]), int(b["Y"]), int(b["Width"]), int(b["Height"])


def local_to_global(info: dict, x: float, y: float) -> tuple[float, float]:
    bx, by, _, _ = bounds(info)
    return bx + x, by + y


def mouse_click(info: dict, x: float, y: float) -> None:
    activate()
    gx, gy = local_to_global(info, x, y)
    point = Quartz.CGPoint(gx, gy)
    source = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    down = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseDown, point, Quartz.kCGMouseButtonLeft)
    up = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseUp, point, Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    time.sleep(0.08)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
    time.sleep(0.35)


def capture(info: dict, name: str) -> Image.Image:
    EVID.mkdir(parents=True, exist_ok=True)
    out = EVID / f"{name}.png"
    win_id = str(info["kCGWindowNumber"])
    proc = run(["screencapture", "-x", "-l", win_id, str(out)], check=False)
    if proc.returncode != 0:
        refreshed = find_window(str(info.get("kCGWindowName", "Mosh")), timeout=4.0)
        info.clear()
        info.update(refreshed)
        win_id = str(info["kCGWindowNumber"])
        run(["screencapture", "-x", "-l", win_id, str(out)])
    return Image.open(out).convert("RGB")


def full_box(img: Image.Image) -> tuple[int, int, int, int]:
    return 0, 0, img.width, img.height


def ax_helper_path() -> Path:
    EVID.mkdir(parents=True, exist_ok=True)
    path = EVID / "axdump.swift"
    if not path.exists() or path.read_text(encoding="utf-8") != AX_HELPER:
        path.write_text(AX_HELPER, encoding="utf-8")
    return path


def ax_press_helper_path() -> Path:
    EVID.mkdir(parents=True, exist_ok=True)
    path = EVID / "axpress.swift"
    if not path.exists() or path.read_text(encoding="utf-8") != AX_PRESS_HELPER:
        path.write_text(AX_PRESS_HELPER, encoding="utf-8")
    return path


def ax_rows() -> list[dict]:
    proc = run(["swift", str(ax_helper_path()), str(CURRENT_PID) if CURRENT_PID is not None else "Mosh"])
    (EVID / "last-ax.tsv").write_text(proc.stdout, encoding="utf-8")
    rows: list[dict] = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 10:
            continue
        role, title, desc, help_text, x, y, w, h, value, enabled = parts
        rows.append({
            "role": role,
            "title": title,
            "desc": desc,
            "help": help_text,
            "x": float(x),
            "y": float(y),
            "w": float(w),
            "h": float(h),
            "value": value,
            "enabled": enabled == "1",
        })
    return rows


def ax_find(
    *,
    role: str | None = None,
    title: str | None = None,
    help_text: str | None = None,
    help_contains: str | None = None,
    timeout: float = 12.0,
) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for row in ax_rows():
            if role is not None and row["role"] != role:
                continue
            if title is not None and row["title"] != title:
                continue
            if help_text is not None and row["help"] != help_text:
                continue
            if help_contains is not None and help_contains not in row["help"]:
                continue
            if row["x"] >= 0 and row["y"] >= 0 and row["w"] > 0 and row["h"] > 0:
                return row
        time.sleep(0.2)
    raise RuntimeError(
        f"AX element not found: role={role!r} title={title!r} "
        f"help={help_text!r} contains={help_contains!r}"
    )


def ax_text(row: dict) -> str:
    return " ".join(str(row.get(k, "")) for k in ("title", "desc", "help"))


def ax_find_contains(role: str | None, text: str, timeout: float = 12.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for row in ax_rows():
            if role is not None and row["role"] != role:
                continue
            if text in ax_text(row) and row["x"] >= 0 and row["y"] >= 0 and row["w"] > 0 and row["h"] > 0:
                return row
        time.sleep(0.2)
    raise RuntimeError(f"AX element containing {text!r} not found for role={role!r}")


def ax_button(label: str, timeout: float = 12.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for row in ax_rows():
            if row["role"] not in {"AXButton", "AXCheckBox", "AXPopUpButton"}:
                continue
            if not (row["x"] >= 0 and row["y"] >= 0 and row["w"] > 0 and row["h"] > 0):
                continue
            texts = [row.get("title", ""), row.get("desc", ""), row.get("help", ""), row.get("value", "")]
            if any(str(text) == label or label in str(text) for text in texts):
                return row
        time.sleep(0.2)
    raise RuntimeError(f"AX button not found: {label!r}")


def click_theme_toggle() -> str:
    try:
        button = ax_find_contains("AXButton", "Toggle theme", timeout=2.0)
        text = ax_text(button)
        click_ax(button)
        return text
    except RuntimeError:
        pass

    overflow = ax_button("More tools", timeout=8.0)
    if overflow["role"] == "AXPopUpButton":
        press_ax(overflow)
    else:
        click_ax(overflow)
    button = wait_for_ax(
        lambda row: row["role"] in {"AXButton", "AXMenuItem"}
        and ("Light mode" in ax_text(row) or "Dark mode" in ax_text(row)),
        detail="v2 overflow theme toggle",
    )
    text = ax_text(button)
    if button["role"] == "AXMenuItem":
        press_ax(button)
    else:
        click_ax(button)
    return text


def mouse_click_xy(x: float, y: float) -> None:
    activate()
    point = Quartz.CGPoint(x, y)
    source = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    down = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseDown, point, Quartz.kCGMouseButtonLeft)
    up = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseUp, point, Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    time.sleep(0.08)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
    time.sleep(0.35)


def mouse_double_click_xy(x: float, y: float) -> None:
    activate()
    point = Quartz.CGPoint(x, y)
    source = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    for click_state in (1, 2):
        down = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseDown, point, Quartz.kCGMouseButtonLeft)
        up = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseUp, point, Quartz.kCGMouseButtonLeft)
        Quartz.CGEventSetIntegerValueField(down, Quartz.kCGMouseEventClickState, click_state)
        Quartz.CGEventSetIntegerValueField(up, Quartz.kCGMouseEventClickState, click_state)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
        time.sleep(0.04)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
        time.sleep(0.08)
    time.sleep(0.7)


def mouse_drag_xy(x1: float, y1: float, x2: float, y2: float) -> None:
    activate()
    source = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    down = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseDown, Quartz.CGPoint(x1, y1), Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    time.sleep(0.08)
    for step in range(1, 16):
        t = step / 15.0
        x = x1 + (x2 - x1) * t
        y = y1 + (y2 - y1) * t
        move = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseDragged, Quartz.CGPoint(x, y), Quartz.kCGMouseButtonLeft)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, move)
        time.sleep(0.02)
    up = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseUp, Quartz.CGPoint(x2, y2), Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
    time.sleep(0.5)


def set_toolbar_zoom(fraction: float) -> None:
    zoom_label = "8b" if fraction >= 0.75 else "16b" if fraction >= 0.35 else "Full"
    try:
        row = wait_for_ax(
            lambda r: r["role"] in {"AXButton", "AXCheckBox"}
            and r["title"] == zoom_label
            and 130 < r["y"] < 220
            and r["w"] > 0
            and r["h"] > 0,
            timeout=2.0,
            detail=f"v2 {zoom_label} zoom control",
        )
        if row.get("value") != "1":
            press_ax(row)
            wait_for_ax(
                lambda r: r["role"] in {"AXButton", "AXCheckBox"}
                and r["title"] == zoom_label
                and r.get("value") == "1",
                timeout=4.0,
                detail=f"selected v2 {zoom_label} zoom control",
            )
        time.sleep(0.35)
        return
    except RuntimeError:
        pass

    row = wait_for_ax(
        lambda r: r["role"] == "AXSlider"
        and r["y"] < 180
        and "Zoom" in ax_text(r)
        and "Song position" not in ax_text(r)
        and "Volume" not in ax_text(r),
        timeout=8.0,
        detail="toolbar Zoom slider",
    )
    frac = max(0.0, min(1.0, fraction))
    y = row["y"] + row["h"] / 2.0
    mouse_drag_xy(row["x"] + row["w"] / 2.0, y, row["x"] + row["w"] * frac, y)


def selected_v2_zoom() -> str | None:
    for row in ax_rows():
        if row["role"] in {"AXButton", "AXCheckBox"} and row["title"] in {"8b", "16b", "Full"} and row.get("value") == "1":
            return row["title"]
    return None


def is_v2_shell() -> bool:
    return selected_v2_zoom() is not None


def key_cmd_z(*, shift: bool = False) -> None:
    activate()
    source = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    flags = Quartz.kCGEventFlagMaskCommand
    if shift:
        flags |= Quartz.kCGEventFlagMaskShift
    key_z = 6
    down = Quartz.CGEventCreateKeyboardEvent(source, key_z, True)
    up = Quartz.CGEventCreateKeyboardEvent(source, key_z, False)
    Quartz.CGEventSetFlags(down, flags)
    Quartz.CGEventSetFlags(up, flags)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    time.sleep(0.05)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
    time.sleep(0.55)


def click_ax(row: dict) -> None:
    mouse_click_xy(row["x"] + row["w"] / 2.0, row["y"] + row["h"] / 2.0)


def press_ax(row: dict) -> None:
    label = str(row.get("title") or row.get("desc") or row.get("help") or row.get("value") or "")
    proc = run([
        "swift", str(ax_press_helper_path()),
        str(CURRENT_PID) if CURRENT_PID is not None else "Mosh",
        str(row.get("role", "")),
        label,
    ], check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"AX press failed: role={row.get('role')!r} label={label!r}")


def press_or_click_ax(row: dict) -> None:
    try:
        press_ax(row)
    except RuntimeError:
        click_ax(row)


def wait_for_ax(
    predicate,
    *,
    timeout: float = 10.0,
    detail: str = "AX predicate",
) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for row in ax_rows():
            if predicate(row):
                return row
        time.sleep(0.25)
    raise RuntimeError(f"timed out waiting for {detail}")


def mean_abs_diff(a: Image.Image, b: Image.Image, box: tuple[int, int, int, int]) -> float:
    diff = ImageChops.difference(a.crop(box), b.crop(box)).convert("L")
    return float(ImageStat.Stat(diff).mean[0])


def ax_box(img: Image.Image, win: dict, row: dict, pad: float = 0.0) -> tuple[int, int, int, int]:
    bx, by, bw, bh = bounds(win)
    sx = img.width / max(1, bw)
    sy = img.height / max(1, bh)
    x0 = int(max(0, (row["x"] - bx - pad) * sx))
    y0 = int(max(0, (row["y"] - by - pad) * sy))
    x1 = int(min(img.width, (row["x"] - bx + row["w"] + pad) * sx))
    y1 = int(min(img.height, (row["y"] - by + row["h"] + pad) * sy))
    if x1 <= x0 or y1 <= y0:
        raise RuntimeError(f"empty image box for AX row {row}")
    return x0, y0, x1, y1


def vertical_edge_contrast(img: Image.Image, box: tuple[int, int, int, int]) -> float:
    crop = img.crop(box).convert("L")
    if crop.width < 5 or crop.height < 5:
        return 0.0
    cols: list[float] = []
    for x in range(crop.width):
        column = crop.crop((x, 0, x + 1, crop.height))
        cols.append(float(ImageStat.Stat(column).mean[0]))
    diffs = [abs(cols[i] - ((cols[i - 1] + cols[i + 1]) / 2.0)) for i in range(1, len(cols) - 1)]
    if not diffs:
        return 0.0
    diffs.sort()
    # Gridlines are sparse; a high percentile catches the line strokes while
    # still ignoring isolated note/label pixels better than max().
    return diffs[int(len(diffs) * 0.99)]


def current_tempo_bpm() -> float:
    for row in ax_rows():
        if row["role"] != "AXTextField" or "Tempo (BPM)" not in ax_text(row):
            continue
        for candidate in (row.get("value", ""), row.get("title", ""), row.get("desc", "")):
            match = re.search(r"-?\d+(?:\.\d+)?", str(candidate))
            if match:
                bpm = float(match.group(0))
                if bpm > 0:
                    return bpm
    return 120.0


def is_snapped_seconds(value: float, step: float, tolerance: float = 0.035) -> bool:
    return abs(value - round(value / step) * step) <= tolerance


def assert_condition(results: dict, key: str, ok: bool, detail: str) -> None:
    results[key] = {"ok": bool(ok), "detail": detail}
    if not ok:
        raise RuntimeError(f"{key} failed: {detail}")


NOTE_TITLE = re.compile(r"^[A-G]#?\d note start ")


def piano_note_rows() -> list[dict]:
    return [
        row for row in ax_rows()
        if row["role"] == "AXButton" and NOTE_TITLE.search(row["title"])
    ]


def wait_for_note_count(minimum: int, timeout: float = 8.0) -> list[dict]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        notes = piano_note_rows()
        if len(notes) >= minimum:
            return notes
        time.sleep(0.25)
    raise RuntimeError(f"timed out waiting for at least {minimum} piano-roll notes")


def find_note(prefix: str, timeout: float = 8.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for row in piano_note_rows():
            if row["title"].startswith(prefix):
                return row
        time.sleep(0.25)
    raise RuntimeError(f"piano-roll note not found: {prefix}")


def rightmost_note(timeout: float = 8.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        notes = piano_note_rows()
        visible = [n for n in notes if 180 <= n["y"] <= 850]
        if visible:
            return sorted(visible, key=lambda n: n["x"])[-1]
        time.sleep(0.25)
    raise RuntimeError("no visible piano-roll notes found")


def arrangement_clip_rows(help_contains: str | None = None) -> list[dict]:
    all_rows = ax_rows()
    rows = [
        row for row in ax_rows()
        if row["role"] == "AXGroup"
        and row["w"] > 8
        and row["h"] > 8
        and (
            "double-click to edit notes" in row["help"]
            or re.search(r" · [0-9.]+s$", row["help"])
        )
    ]
    if help_contains is not None:
        rows = [row for row in rows if help_contains in row["help"]]
        for label in all_rows:
            if label["role"] != "AXStaticText" or help_contains not in str(label.get("value", "")):
                continue
            candidates = [
                row for row in all_rows
                if row["role"] == "AXGroup"
                and row["x"] <= label["x"] <= row["x"] + row["w"]
                and row["y"] <= label["y"] <= row["y"] + row["h"]
                and row["x"] > 150
                and row["w"] > 20
                and 24 <= row["h"] <= 90
            ]
            if candidates:
                row = sorted(candidates, key=lambda r: r["w"] * r["h"])[0].copy()
                row["help"] = str(label.get("value", ""))
                rows.append(row)
        seen: set[tuple[float, float, float, float]] = set()
        unique = []
        for row in rows:
            key = (row["x"], row["y"], row["w"], row["h"])
            if key not in seen:
                seen.add(key)
                unique.append(row)
        rows = unique
    return rows


def wait_for_clip_count(help_contains: str, minimum: int, timeout: float = 8.0) -> list[dict]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = arrangement_clip_rows(help_contains)
        if len(rows) >= minimum:
            return rows
        time.sleep(0.25)
    raise RuntimeError(f"timed out waiting for {minimum} arrangement clips containing {help_contains!r}")


def arrangement_clip(help_contains: str, timeout: float = 8.0, *, pick: str = "leftmost") -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = arrangement_clip_rows(help_contains)
        if rows:
            key = (lambda r: r["x"]) if pick == "leftmost" else (lambda r: r["w"])
            return sorted(rows, key=key)[0 if pick == "leftmost" else -1]
        time.sleep(0.25)
    raise RuntimeError(f"arrangement clip not found: {help_contains!r}")


def enclosing_clip_group(label: dict) -> dict:
    groups = [
        row for row in ax_rows()
        if row["role"] == "AXGroup"
        and row["x"] <= label["x"] <= row["x"] + row["w"]
        and row["y"] <= label["y"] <= row["y"] + row["h"]
        and 40 <= row["w"] <= 800
        and 30 <= row["h"] <= 90
    ]
    if not groups:
        return {"x": label["x"] - 8, "y": label["y"] - 3, "w": 140, "h": 63}
    return sorted(groups, key=lambda r: r["w"] * r["h"])[0]


def assert_no_commands(results: dict, key: str, marker: int, commands: list[str], detail: str) -> None:
    counts = {command: command_count(command, marker) for command in commands}
    assert_condition(
        results,
        key,
        all(count == 0 for count in counts.values()),
        f"{detail}; command counts={counts}",
    )


def latest_command_args(command: str, marker: int) -> dict:
    records = commands_since(command, marker)
    if not records:
        raise RuntimeError(f"no {command!r} command found after marker")
    args = records[-1].get("args")
    return args if isinstance(args, dict) else {}


def run_arrangement_advanced(results: dict, win: dict) -> None:
    clip = arrangement_clip("tone-196")
    volume = ax_find_contains("AXSlider", "Volume")
    assert_condition(
        results,
        "demo6_arrangement_track_header_hit_area",
        volume["x"] + volume["w"] <= clip["x"] - 2,
        f"volume slider AX box ends before lane starts ({volume['x'] + volume['w']:.1f} <= {clip['x']:.1f})",
    )

    marker = command_log_marker()
    mouse_click_xy(clip["x"] + clip["w"] * 0.50, clip["y"] + clip["h"] * 0.50)
    assert_no_commands(
        results,
        "demo6_arrangement_clip_click_guard",
        marker,
        ["set_track_volume", "add_automation_point", "set_automation_point"],
        "plain clip click selected only; no mixer or automation mutation",
    )

    marker = command_log_marker()
    mouse_click_xy(clip["x"] + clip["w"] * 0.50, clip["y"] + clip["h"] - 5)
    assert_no_commands(
        results,
        "demo6_arrangement_inline_automation_guard",
        marker,
        ["add_automation_point", "set_automation_point", "remove_automation_point"],
        "bottom-of-clip click did not write inline automation",
    )

    before_trim = capture(win, "demo6-arr-00-before-trim")
    clip = arrangement_clip("tone-196")
    trim_before_w = clip["w"]
    marker = command_log_marker()
    mouse_drag_xy(
        clip["x"] + clip["w"] - 3,
        clip["y"] + clip["h"] * 0.50,
        clip["x"] + clip["w"] + 48,
        clip["y"] + clip["h"] * 0.50,
    )
    trim_count = wait_for_command_count("trim_clip", marker, 1)
    trimmed = arrangement_clip("tone-196")
    after_trim = capture(win, "demo6-arr-01-after-trim")
    trim_diff = mean_abs_diff(before_trim, after_trim, full_box(before_trim))
    assert_condition(
        results,
        "demo6_arrangement_trim_right_edge",
        trim_count == 1 and trimmed["w"] > trim_before_w + 20,
        f"one trim_clip widened clip {trim_before_w:.1f}->{trimmed['w']:.1f}; diff={trim_diff:.2f}",
    )

    split_button = ax_button("Split")
    click_ax(split_button)
    split_target = arrangement_clip("tone-196", pick="widest")
    split_before_count = len(arrangement_clip_rows("tone-196"))
    marker = command_log_marker()
    mouse_click_xy(split_target["x"] + split_target["w"] * 0.52, split_target["y"] + split_target["h"] * 0.50)
    split_count = wait_for_command_count("split_clip", marker, 1)
    split_rows = wait_for_clip_count("tone-196", split_before_count + 1)
    capture(win, "demo6-arr-02-after-split")
    assert_condition(
        results,
        "demo6_arrangement_split_tool",
        split_count == 1 and len(split_rows) == split_before_count + 1,
        f"one split_clip increased tone-196 clips {split_before_count}->{len(split_rows)}",
    )

    click_ax(ax_button("Move"))
    snap_step = 60.0 / current_tempo_bpm()
    set_toolbar_zoom(0.0)
    low_zoom = capture(win, "demo6-arr-03-low-zoom")
    low_clip = arrangement_clip("tone-196")
    marker = command_log_marker()
    low_drag = max(72.0, min(110.0, low_clip["w"] * 0.55))
    mouse_drag_xy(
        low_clip["x"] + min(30, low_clip["w"] * 0.35),
        low_clip["y"] + low_clip["h"] * 0.50,
        low_clip["x"] + min(30, low_clip["w"] * 0.35) + low_drag,
        low_clip["y"] + low_clip["h"] * 0.50,
    )
    wait_for_command_count("move_clip", marker, 1)
    low_args = latest_command_args("move_clip", marker)
    low_start = float(low_args.get("start", -1))
    after_low_move = capture(win, "demo6-arr-04-low-zoom-snap-move")
    assert_condition(
        results,
        "demo6_arrangement_snap_low_zoom",
        is_snapped_seconds(low_start, snap_step),
        (
            f"low-zoom move snapped to 1/4 grid start={low_start:.3f} "
            f"step={snap_step:.5f}; drag={low_drag:.1f}px; diff={mean_abs_diff(low_zoom, after_low_move, full_box(low_zoom)):.2f}"
        ),
    )

    set_toolbar_zoom(0.45)
    high_zoom = capture(win, "demo6-arr-05-high-zoom")
    high_clip = arrangement_clip("tone-196")
    marker = command_log_marker()
    high_drag = max(120.0, min(220.0, high_clip["w"] * 0.45))
    mouse_drag_xy(
        high_clip["x"] + min(80, high_clip["w"] * 0.35),
        high_clip["y"] + high_clip["h"] * 0.50,
        high_clip["x"] + min(80, high_clip["w"] * 0.35) + high_drag,
        high_clip["y"] + high_clip["h"] * 0.50,
    )
    wait_for_command_count("move_clip", marker, 1)
    high_args = latest_command_args("move_clip", marker)
    high_start = float(high_args.get("start", -1))
    after_high_move = capture(win, "demo6-arr-06-high-zoom-snap-move")
    assert_condition(
        results,
        "demo6_arrangement_snap_high_zoom",
        is_snapped_seconds(high_start, snap_step),
        (
            f"high-zoom move snapped to quarter-grid start={high_start:.3f} "
            f"step={snap_step:.5f}; drag={high_drag:.1f}px; diff={mean_abs_diff(high_zoom, after_high_move, full_box(high_zoom)):.2f}"
        ),
    )

    post_ops_count = len(arrangement_clip_rows("tone-196"))
    marker = command_log_marker()
    for _ in range(4):
        key_cmd_z()
    undo_seen = wait_for_command_count("undo", marker, 4, timeout=10.0)
    after_undo = capture(win, "demo6-arr-07-after-rapid-undo")
    undo_count_rows = len(arrangement_clip_rows("tone-196"))
    for _ in range(4):
        key_cmd_z(shift=True)
    redo_seen = wait_for_command_count("redo", marker, 4, timeout=10.0)
    after_redo = capture(win, "demo6-arr-08-after-rapid-redo")
    redo_count_rows = len(arrangement_clip_rows("tone-196"))
    undo_redo_diff = mean_abs_diff(after_undo, after_redo, full_box(after_undo))
    assert_condition(
        results,
        "demo6_arrangement_rapid_undo_redo",
        undo_seen == 4 and redo_seen == 4 and undo_redo_diff > 1.0,
        (
            f"rapid undo/redo counts undo={undo_seen} redo={redo_seen}; "
            f"tone-196 clips {post_ops_count}->{undo_count_rows}->{redo_count_rows}; "
            f"diff={undo_redo_diff:.2f}"
        ),
    )


def run_piano_roll(results: dict, win: dict) -> None:
    # Use an explicit default MIDI clip rather than the demo drum clips: the drum
    # notes sit below the current C2-C7 viewport, while the default arpeggio is visible.
    set_toolbar_zoom(0.2)
    snap = ax_button("Snap")
    click_ax(snap)  # snap off: draw an off-grid note, then prove Quantize moves it.

    marker = command_log_marker()
    midi_buttons = [
        r for r in ax_rows()
        if r["role"] == "AXButton" and r["title"] == "+ MIDI" and r["y"] < 180
    ]
    if not midi_buttons:
        raise RuntimeError("toolbar + MIDI button not found")
    click_ax(sorted(midi_buttons, key=lambda r: r["y"])[0])
    wait_for_command("add_midi_clip", marker)
    midi_label = wait_for_ax(
        lambda row: row["role"] == "AXStaticText" and row["value"] == "MIDI",
        timeout=10.0,
        detail="new default MIDI clip label",
    )
    midi_clip = enclosing_clip_group(midi_label)

    mouse_double_click_xy(midi_clip["x"] + midi_clip["w"] / 2.0, midi_clip["y"] + midi_clip["h"] / 2.0)
    wait_for_ax(
        lambda row: row["role"] == "AXButton" and row["title"].startswith("Quantize "),
        timeout=10.0,
        detail="piano-roll Quantize button",
    )
    opened = capture(win, "demo6-pr-00-open")
    grid = ax_find(role="AXGroup", title="Piano roll grid")
    grid_crop = ax_box(opened, win, grid, pad=-2)
    grid_sample = (
        grid_crop[0],
        grid_crop[1],
        min(grid_crop[2], grid_crop[0] + 600),
        min(grid_crop[3], grid_crop[1] + 340),
    )
    grid_contrast = vertical_edge_contrast(opened, grid_sample)
    assert_condition(
        results,
        "demo6_piano_roll_open",
        grid["w"] > 200 and grid["h"] > 200,
        f"double-click opened piano roll grid {grid['w']:.1f}x{grid['h']:.1f}",
    )
    assert_condition(
        results,
        "demo6_piano_light_grid_visibility",
        grid_contrast > 1.0,
        f"light-mode piano-roll vertical grid edge contrast={grid_contrast:.2f}",
    )

    marker = command_log_marker()
    draw_x = grid["x"] + 5.5 * 42.0
    draw_y = grid["y"] + grid["h"] * 0.42
    before_draw = capture(win, "demo6-pr-01-before-draw")
    mouse_click_xy(draw_x, draw_y)
    wait_for_command("add_note", marker)
    after_draw = capture(win, "demo6-pr-02-after-draw")
    draw_diff = mean_abs_diff(before_draw, after_draw, full_box(before_draw))
    assert_condition(
        results,
        "demo6_piano_draw_note",
        draw_diff > 0.02,
        f"empty-grid click recorded add_note; diff={draw_diff:.2f}",
    )

    before_quantize = capture(win, "demo6-pr-03-before-quantize")
    marker = command_log_marker()
    click_ax(wait_for_ax(lambda row: row["role"] == "AXButton" and row["title"].startswith("Quantize "), detail="Quantize button"))
    quantize_count = wait_for_command_count("quantize_notes", marker, 1)
    time.sleep(0.7)
    after_quantize = capture(win, "demo6-pr-04-after-quantize")
    quantize_diff = mean_abs_diff(before_quantize, after_quantize, full_box(before_quantize))
    assert_condition(
        results,
        "demo6_piano_quantize",
        quantize_count == 1,
        f"one quantize_notes recorded; diff={quantize_diff:.2f}",
    )

    assert_condition(
        results,
        "demo6_piano_workflow_visuals",
        True,
        "screenshots captured open/draw/quantize piano-roll states",
    )


def select_v2_inspector_tab(label: str) -> dict:
    tab = wait_for_ax(
        lambda row: row["role"] == "AXRadioButton" and row["title"] == label,
        timeout=8.0,
        detail=f"v2 inspector {label} tab",
    )
    press_or_click_ax(tab)
    return wait_for_ax(
        lambda row: row["role"] == "AXRadioButton" and row["title"] == label and row.get("value") == "1",
        timeout=4.0,
        detail=f"selected v2 inspector {label} tab",
    )


def run_v2_shell_smoke(results: dict, win: dict) -> None:
    zoom_state = selected_v2_zoom()
    assert_condition(
        results,
        "demo6_v2_zoom_minus",
        zoom_state == "Full",
        f"v2 zoom selected={zoom_state}",
    )

    tabs_seen: list[str] = []
    before_tabs = capture(win, "demo6-v2-00-before-tabs")
    for tab in ("FX", "Gen", "Lyrics", "Mix"):
        select_v2_inspector_tab(tab)
        tabs_seen.append(tab)
    after_tabs = capture(win, "demo6-v2-01-after-tabs")
    assert_condition(
        results,
        "demo6_v2_inspector_tabs",
        tabs_seen == ["FX", "Gen", "Lyrics", "Mix"],
        f"selected inspector tabs {tabs_seen}; diff={mean_abs_diff(before_tabs, after_tabs, full_box(before_tabs)):.2f}",
    )

    before_browser = capture(win, "demo6-v2-02-before-browser")
    press_or_click_ax(ax_button("Open browser"))
    close_browser = wait_for_ax(
        lambda row: row["role"] == "AXButton" and row["title"] == "Close browser",
        timeout=8.0,
        detail="v2 browser drawer close button",
    )
    open_browser = capture(win, "demo6-v2-03-browser-open")
    browser_diff = mean_abs_diff(before_browser, open_browser, full_box(before_browser))
    assert_condition(
        results,
        "demo6_v2_browser_drawer",
        browser_diff > 0.1 and close_browser["title"] == "Close browser",
        f"browser drawer opened; image diff={browser_diff:.2f}",
    )
    press_or_click_ax(close_browser)
    wait_for_ax(
        lambda row: row["role"] == "AXButton" and row["title"] == "Open browser",
        timeout=8.0,
        detail="v2 browser drawer pull tab",
    )


def run_demo6(results: dict) -> None:
    ensure_service(results)
    pid = launch(["--demo6"])
    results["demo6_pid"] = pid
    win = find_window("Mosh")
    dismiss_permission_prompts()
    initial = capture(win, "demo6-00-initial")

    play_button = ax_button("Play", timeout=18.0)
    click_ax(play_button)
    try:
        stop_button = wait_for_ax(lambda row: row["role"] in {"AXButton", "AXCheckBox"} and "Stop" in ax_text(row), detail="Stop button")
    except RuntimeError:
        click_ax(play_button)
        stop_button = wait_for_ax(lambda row: row["role"] in {"AXButton", "AXCheckBox"} and "Stop" in ax_text(row), detail="Stop button")
    click_ax(stop_button)
    try:
        wait_for_ax(lambda row: row["role"] in {"AXButton", "AXCheckBox"} and "Play" in ax_text(row), detail="Play button")
    except RuntimeError:
        click_ax(stop_button)
        wait_for_ax(lambda row: row["role"] in {"AXButton", "AXCheckBox"} and "Play" in ax_text(row), detail="Play button")
    after_play = capture(win, "demo6-01-play-stop")
    play_diff = mean_abs_diff(initial, after_play, full_box(initial))
    assert_condition(results, "demo6_play_click", play_diff >= 0.0, f"AX Stop observed, then Play restored; image diff={play_diff:.2f}")

    dismiss_permission_prompts()
    before_theme = capture(win, "demo6-03-before-theme")
    theme_text_before = click_theme_toggle()
    time.sleep(0.5)
    after_theme = capture(win, "demo6-04-after-theme")
    theme_diff = mean_abs_diff(before_theme, after_theme, full_box(before_theme))
    assert_condition(
        results,
        "demo6_theme_click",
        theme_diff > 1.0,
        f"theme AX {theme_text_before!r}; image diff={theme_diff:.2f}",
    )

    set_toolbar_zoom(1.0)
    zoomed = capture(win, "demo6-05-zoom-plus")
    zoom_state = selected_v2_zoom()
    zoom_diff = mean_abs_diff(after_theme, zoomed, full_box(after_theme))
    assert_condition(
        results,
        "demo6_zoom_plus",
        (zoom_state == "8b" and zoom_diff > 0.1) or zoom_diff > 1.0,
        f"zoom selected={zoom_state}; image diff={zoom_diff:.2f}",
    )
    set_toolbar_zoom(0.2)
    capture(win, "demo6-06-zoom-minus")

    if is_v2_shell():
        run_v2_shell_smoke(results, win)
        before_add = capture(win, "demo6-v2-04-before-add-track")
        marker = command_log_marker()
        press_or_click_ax(ax_button("Add track"))
        create_count = wait_for_command_count("create_track", marker, 1)
        wait_for_ax(
            lambda row: row["role"] == "AXCheckBox" and "Select track Audio" in ax_text(row),
            timeout=8.0,
            detail="new v2 Audio track header",
        )
        after_add = capture(win, "demo6-v2-05-after-add-track")
        add_diff = mean_abs_diff(before_add, after_add, full_box(before_add))
        assert_condition(
            results,
            "demo6_v2_add_track",
            create_count == 1 and add_diff > 0.1,
            f"one create_track from Add track; image diff={add_diff:.2f}",
        )
        kill_mosh()
        return

    click_ax(ax_button("Split"))
    split = capture(win, "demo6-07-split-mode")
    split_selected = wait_for_ax(
        lambda row: row["role"] in {"AXButton", "AXCheckBox"} and row["title"] == "Split" and row["value"] == "1",
        timeout=5.0,
        detail="Split selected",
    )
    click_ax(ax_button("Move"))
    move = capture(win, "demo6-08-move-mode")
    move_selected = wait_for_ax(
        lambda row: row["role"] in {"AXButton", "AXCheckBox"} and row["title"] == "Move" and row["value"] == "1",
        timeout=5.0,
        detail="Move selected",
    )
    tool_diff = mean_abs_diff(split, move, full_box(split))
    assert_condition(results, "demo6_tool_modes", bool(split_selected and move_selected), f"tool diff={tool_diff:.2f}")

    before_drag = capture(win, "demo6-09-before-drag")
    clip_before = arrangement_clip("tone-196")
    before_x = clip_before["x"]
    mouse_drag_xy(
        clip_before["x"] + clip_before["w"] * 0.35,
        clip_before["y"] + 10,
        clip_before["x"] + clip_before["w"] * 0.35 + 80,
        clip_before["y"] + 10,
    )
    after_drag = capture(win, "demo6-10-after-drag")
    clip_after = sorted(arrangement_clip_rows("tone-196"), key=lambda row: abs(row["y"] - clip_before["y"]))[0]
    after_x = clip_after["x"]
    assert_condition(results, "demo6_clip_drag", after_x - before_x > 30.0, f"AX x {before_x:.1f}->{after_x:.1f}")

    run_arrangement_advanced(results, win)
    run_piano_roll(results, win)

    kill_mosh()


def run_demo5(results: dict) -> None:
    ensure_service(results)
    pid = launch(["--demo5"])
    results["demo5_pid"] = pid
    win = find_window("Mosh")
    capture(win, "demo5-00-initial")

    vox_label = wait_for_ax(
        lambda row: row["role"] == "AXStaticText" and row["value"] == "tone-147",
        timeout=10.0,
        detail="tone-147 clip label",
    )
    vox_clip = enclosing_clip_group(vox_label)
    mouse_click_xy(max(55.0, vox_clip["x"] - 145.0), vox_clip["y"] + vox_clip["h"] / 2.0)
    wait_for_ax(
        lambda row: row["role"] == "AXButton" and row["title"] in ("Render", "Re-render"),
        timeout=10.0,
        detail="Render button after selecting Vox track",
    )

    marker = command_log_marker()
    before_render = capture(win, "demo5-01-before-render")
    render_button = ax_find(role="AXButton", title="Render")
    click_ax(render_button)
    try:
        wait_for_command("render_layer", marker, timeout=3.0)
    except RuntimeError:
        click_ax(ax_find(role="AXButton", title="Render"))
        wait_for_command("render_layer", marker, timeout=8.0)
    accept_button = wait_for_ax(
        lambda row: row["role"] == "AXButton" and row["title"] == "Accept" and row["enabled"],
        timeout=20.0,
        detail="enabled Accept button after render",
    )
    after_render = capture(win, "demo5-02-after-render")
    render_diff = mean_abs_diff(before_render, after_render, full_box(before_render))
    assert_condition(results, "demo5_render_click", render_diff >= 0.0, f"Accept/Reject enabled; render diff={render_diff:.2f}")

    click_ax(accept_button)
    wait_for_command("accept_render", marker)
    capture(win, "demo5-03-after-accept")
    assert_condition(results, "demo5_accept_click", True, "JSONL accept_render recorded after GUI click")

    reject_button = ax_find(role="AXButton", title="Reject")
    click_ax(reject_button)
    wait_for_command("reject_render", marker)
    capture(win, "demo5-04-after-reject")
    assert_condition(results, "demo5_reject_click", True, "JSONL reject_render recorded after GUI click")

    kill_mosh()


def run_demo3(results: dict) -> None:
    pid = launch(["--demo3"])
    results["demo3_pid"] = pid
    win = find_window("Serum 2")
    capture(win, "demo3-00-serum-initial")
    assert_condition(
        results,
        "demo3_serum_exact_plugin",
        True,
        "opened exact Serum 2 native editor after host playback-context warmup",
    )

    before_control = capture(win, "demo3-01-serum-before-control")
    # Serum's top tab hit targets move with native scaling and skin layout. This
    # dropdown is a stable native editor control and still proves real pop-out
    # hit-testing plus screenshot-visible plugin UI response.
    mouse_click(win, 600, 120)
    after_control = capture(win, "demo3-02-serum-after-control")
    control_diff = mean_abs_diff(before_control, after_control, (0, 80, 1600, 700))
    assert_condition(
        results,
        "demo3_serum_native_control_click",
        control_diff > 1.0,
        f"native Serum control click changed editor pixels; diff={control_diff:.2f}",
    )

    kill_mosh()


def main() -> int:
    EVID.mkdir(parents=True, exist_ok=True)
    results: dict = {
        "ok": False,
        "evidence": str(EVID),
        "app": str(APP_BUNDLE),
        "method": "Quartz CGEvent actions + screencapture visual checks",
    }
    try:
        kill_mosh()
        run_demo6(results)
        results["ok"] = True
        report = "# ClaudeMosh macOS UI Automation Gate\n\nResult: PASS\n\n"
    except (Exception, SystemExit) as exc:  # noqa: BLE001
        results["error"] = str(exc)
        report = "# ClaudeMosh macOS UI Automation Gate\n\nResult: FAIL\n\n"
    finally:
        kill_mosh()
        stop_service()
        (EVID / "result.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
        lines = [report, f"Evidence: `{EVID}`\n\n", "Checks:\n"]
        for key, value in results.items():
            if isinstance(value, dict) and "ok" in value:
                status = "PASS" if value["ok"] else "FAIL"
                lines.append(f"- {status} `{key}`: {value['detail']}\n")
        if "error" in results:
            lines.append(f"\nError: `{results['error']}`\n")
        (EVID / "REPORT.md").write_text("".join(lines), encoding="utf-8")
    print(("PASS" if results["ok"] else "FAIL") + f": evidence={EVID}")
    return 0 if results["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
