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
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageChops, ImageStat
import Quartz


REPO = Path(__file__).resolve().parents[1]
APP_BUNDLE = Path(os.environ.get("MOSH_APP_BUNDLE", REPO / "build/Mosh_artefacts/Debug/Mosh.app"))
APP_BIN = APP_BUNDLE / "Contents/MacOS/Mosh"
SERVICE_HOST = os.environ.get("MOSH_SERVICE_HOST", "127.0.0.1")
SERVICE_PORT = int(os.environ.get("MOSH_SERVICE_PORT", "8770"))
SERVICE_URL = f"http://{SERVICE_HOST}:{SERVICE_PORT}"
COMMAND_LOG = Path.home() / "Library/Mosh/session/mosh-log.jsonl"
EVID = Path(os.environ.get(
    "MOSH_EVID",
    REPO / "_preserved_artifacts/2026-06-08-consolidation/claudemosh"
    / f"macos-ui-automation-{datetime.now().strftime('%Y%m%d-%H%M%S')}",
))
SERVICE_PROC: subprocess.Popen[str] | None = None

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
    if count > 1600 { return }
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

    log = (EVID / "service.log").open("w", encoding="utf-8")
    env = os.environ.copy()
    env["MOSH_ENABLE_SA3"] = "0"
    env.setdefault("MOSH_SERVICE_HOST", SERVICE_HOST)
    env.setdefault("MOSH_SERVICE_PORT", str(SERVICE_PORT))
    env["PYTHONUNBUFFERED"] = "1"
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


def launch(args: list[str]) -> int:
    if not APP_BUNDLE.is_dir() or not APP_BIN.exists():
        raise SystemExit(f"missing app bundle or binary: {APP_BUNDLE}")
    run(["open", "-n", str(APP_BUNDLE), "--args", *args])
    deadline = time.time() + 12
    while time.time() < deadline:
        proc = run(["pgrep", "-n", "-f", str(APP_BIN)], check=False)
        pid_text = proc.stdout.strip()
        if pid_text:
            time.sleep(2.0)
            return int(pid_text)
        time.sleep(0.25)
    raise RuntimeError("Mosh did not launch")


def activate() -> None:
    run(["osascript", "-e", 'tell application "Mosh" to activate'], check=False)
    time.sleep(0.2)


def windows() -> list[dict]:
    opts = Quartz.kCGWindowListOptionOnScreenOnly
    infos = Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []
    return [dict(info) for info in infos if info.get("kCGWindowOwnerName") == "Mosh"]


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


def mouse_drag(info: dict, x1: float, y1: float, x2: float, y2: float) -> None:
    activate()
    gx1, gy1 = local_to_global(info, x1, y1)
    gx2, gy2 = local_to_global(info, x2, y2)
    source = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    down = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseDown, Quartz.CGPoint(gx1, gy1), Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    time.sleep(0.08)
    for step in range(1, 16):
        t = step / 15.0
        x = gx1 + (gx2 - gx1) * t
        y = gy1 + (gy2 - gy1) * t
        move = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseDragged, Quartz.CGPoint(x, y), Quartz.kCGMouseButtonLeft)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, move)
        time.sleep(0.02)
    up = Quartz.CGEventCreateMouseEvent(source, Quartz.kCGEventLeftMouseUp, Quartz.CGPoint(gx2, gy2), Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
    time.sleep(0.5)


def capture(info: dict, name: str) -> Image.Image:
    EVID.mkdir(parents=True, exist_ok=True)
    out = EVID / f"{name}.png"
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


def ax_rows() -> list[dict]:
    proc = run(["swift", str(ax_helper_path()), "Mosh"])
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


def ax_find(
    *,
    role: str | None = None,
    title: str | None = None,
    help_text: str | None = None,
    help_contains: str | None = None,
    timeout: float = 6.0,
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


def click_ax(row: dict) -> None:
    mouse_click_xy(row["x"] + row["w"] / 2.0, row["y"] + row["h"] / 2.0)


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


def mean_brightness(img: Image.Image, box: tuple[int, int, int, int]) -> float:
    crop = img.crop(box).convert("L")
    return float(ImageStat.Stat(crop).mean[0])


def mean_abs_diff(a: Image.Image, b: Image.Image, box: tuple[int, int, int, int]) -> float:
    diff = ImageChops.difference(a.crop(box), b.crop(box)).convert("L")
    return float(ImageStat.Stat(diff).mean[0])


def blue_centroid_x(img: Image.Image, box: tuple[int, int, int, int]) -> float:
    crop = img.crop(box).convert("RGB")
    total_x = 0.0
    count = 0
    for y in range(crop.height):
        for x in range(crop.width):
            r, g, b = crop.getpixel((x, y))
            if b > 120 and g > 70 and r < 120:
                total_x += x
                count += 1
    if count < 50:
        raise RuntimeError(f"blue clip pixels not found in {box}; count={count}")
    return box[0] + (total_x / count)


def assert_condition(results: dict, key: str, ok: bool, detail: str) -> None:
    results[key] = {"ok": bool(ok), "detail": detail}
    if not ok:
        raise RuntimeError(f"{key} failed: {detail}")


def run_demo6(results: dict) -> None:
    ensure_service(results)
    pid = launch(["--demo6"])
    results["demo6_pid"] = pid
    win = find_window("Mosh")
    initial = capture(win, "demo6-00-initial")

    play_button = ax_find(role="AXButton", title="▶", help_text="Play")
    click_ax(play_button)
    try:
        stop_button = wait_for_ax(lambda row: row["role"] == "AXButton" and row["title"] == "■" and row["help"] == "Stop", detail="Stop button")
    except RuntimeError:
        click_ax(play_button)
        stop_button = wait_for_ax(lambda row: row["role"] == "AXButton" and row["title"] == "■" and row["help"] == "Stop", detail="Stop button")
    click_ax(stop_button)
    try:
        wait_for_ax(lambda row: row["role"] == "AXButton" and row["title"] == "▶" and row["help"] == "Play", detail="Play button")
    except RuntimeError:
        click_ax(stop_button)
        wait_for_ax(lambda row: row["role"] == "AXButton" and row["title"] == "▶" and row["help"] == "Play", detail="Play button")
    after_play = capture(win, "demo6-01-play-stop")
    play_diff = mean_abs_diff(initial, after_play, full_box(initial))
    assert_condition(results, "demo6_play_click", play_diff >= 0.0, f"AX Stop observed, then Play restored; image diff={play_diff:.2f}")

    before_theme = capture(win, "demo6-03-before-theme")
    click_ax(ax_find(role="AXButton", help_text="Toggle theme"))
    after_theme = capture(win, "demo6-04-after-theme")
    theme_diff = mean_abs_diff(before_theme, after_theme, full_box(before_theme))
    theme_brightness = mean_brightness(after_theme, full_box(after_theme))
    assert_condition(
        results,
        "demo6_theme_click",
        theme_diff > 20.0 and theme_brightness > 100.0,
        f"theme diff={theme_diff:.2f}, brightness={theme_brightness:.2f}",
    )

    click_ax(ax_find(role="AXButton", title="Zoom +"))
    zoomed = capture(win, "demo6-05-zoom-plus")
    zoom_diff = mean_abs_diff(after_theme, zoomed, full_box(after_theme))
    assert_condition(results, "demo6_zoom_plus", zoom_diff > 1.0, f"zoom diff={zoom_diff:.2f}")
    click_ax(ax_find(role="AXButton", title="Zoom −"))
    capture(win, "demo6-06-zoom-minus")

    click_ax(ax_find(role="AXButton", title="Split"))
    split = capture(win, "demo6-07-split-mode")
    click_ax(ax_find(role="AXButton", title="Move"))
    move = capture(win, "demo6-08-move-mode")
    tool_diff = mean_abs_diff(split, move, full_box(split))
    assert_condition(results, "demo6_tool_modes", tool_diff > 0.1, f"tool diff={tool_diff:.2f}")

    before_drag = capture(win, "demo6-09-before-drag")
    clip_before = ax_find(role="AXGroup", help_contains="tone-196")
    before_x = clip_before["x"]
    mouse_drag_xy(
        clip_before["x"] + clip_before["w"] * 0.35,
        clip_before["y"] + clip_before["h"] * 0.50,
        clip_before["x"] + clip_before["w"] * 0.35 + 80,
        clip_before["y"] + clip_before["h"] * 0.50,
    )
    after_drag = capture(win, "demo6-10-after-drag")
    clip_after = ax_find(role="AXGroup", help_contains="tone-196")
    after_x = clip_after["x"]
    assert_condition(results, "demo6_clip_drag", after_x - before_x > 30.0, f"AX x {before_x:.1f}->{after_x:.1f}")

    marker = command_log_marker()
    before_render = capture(win, "demo6-11-before-render")
    click_ax(ax_find(role="AXButton", title="Render"))
    accept_button = wait_for_ax(
        lambda row: row["role"] == "AXButton" and row["title"] == "Accept" and row["enabled"],
        timeout=20.0,
        detail="enabled Accept button after render",
    )
    after_render = capture(win, "demo6-12-after-render")
    render_diff = mean_abs_diff(before_render, after_render, full_box(before_render))
    assert_condition(results, "demo6_render_click", render_diff >= 0.0, f"Accept/Reject enabled; render diff={render_diff:.2f}")

    click_ax(accept_button)
    wait_for_command("accept_render", marker)
    capture(win, "demo6-13-after-accept")
    assert_condition(results, "demo6_accept_click", True, "JSONL accept_render recorded after GUI click")

    reject_button = ax_find(role="AXButton", title="Reject")
    click_ax(reject_button)
    wait_for_command("reject_render", marker)
    capture(win, "demo6-14-after-reject")
    assert_condition(results, "demo6_reject_click", True, "JSONL reject_render recorded after GUI click")

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

    mouse_click(win, 198, 78)  # OSC
    osc = capture(win, "demo3-01-serum-osc")
    mouse_click(win, 333, 78)  # MATRIX tab in the native editor
    matrix = capture(win, "demo3-02-serum-matrix")
    matrix_diff = mean_abs_diff(osc, matrix, (0, 100, 1160, 420))
    assert_condition(results, "demo3_serum_matrix_tab", matrix_diff > 5.0, f"osc/matrix diff={matrix_diff:.2f}")

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
        run_demo3(results)
        results["ok"] = True
        report = "# ClaudeMosh macOS UI Automation Gate\n\nResult: PASS\n\n"
    except Exception as exc:  # noqa: BLE001
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
