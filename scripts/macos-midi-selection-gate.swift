import AppKit
import ApplicationServices
import CryptoKit
import Foundation

struct NoteState: Codable, Equatable {
    let title: String
    let selected: Bool
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct SelectionReport: Codable {
    let ok: Bool
    let pid: Int32
    let selectedAfterGroup: Int
    let selectedAfterCollapse: Int
    let selectedAfterMove: Int
    let changedNotes: Int
    let undoRestored: Bool
    let beforeFingerprint: String
    let selectedFingerprint: String
    let before: [NoteState]
    let moved: [NoteState]
    let restored: [NoteState]
}

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}

func pointValue(_ value: CFTypeRef?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func sizeValue(_ value: CFTypeRef?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func boolValue(_ value: CFTypeRef?) -> Bool {
    if let number = value as? NSNumber { return number.boolValue }
    if let string = value as? String { return string == "true" || string == "1" }
    return false
}

func notes(pid: Int32) -> [NoteState] {
    let root = AXUIElementCreateApplication(pid)
    var result: [NoteState] = []
    var visited = 0
    func walk(_ element: AXUIElement) {
        guard visited < 4000 else { return }
        visited += 1
        let title = attribute(element, kAXTitleAttribute as CFString) as? String ?? ""
        if title.contains(" note start "),
           let position = pointValue(attribute(element, kAXPositionAttribute as CFString)),
           let size = sizeValue(attribute(element, kAXSizeAttribute as CFString)),
           size.width >= 6,
           size.height > 0 {
            result.append(NoteState(
                title: title,
                selected: boolValue(attribute(element, kAXValueAttribute as CFString)),
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height
            ))
        }
        let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
        children.forEach(walk)
    }
    walk(root)
    return result.filter { state in
        NSScreen.screens.contains { screen in
            screen.frame.intersects(CGRect(x: state.x, y: state.y, width: state.width, height: state.height))
        }
    }.sorted { lhs, rhs in
        lhs.x == rhs.x ? lhs.y < rhs.y : lhs.x < rhs.x
    }
}

func postMouse(_ type: CGEventType, at point: CGPoint, flags: CGEventFlags = []) {
    let source = CGEventSource(stateID: .hidSystemState)
    let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
    event?.flags = flags
    event?.post(tap: .cghidEventTap)
}

func click(_ note: NoteState, flags: CGEventFlags = []) {
    let point = CGPoint(x: note.x + note.width / 2, y: note.y + note.height / 2)
    postMouse(.mouseMoved, at: point, flags: flags)
    postMouse(.leftMouseDown, at: point, flags: flags)
    postMouse(.leftMouseUp, at: point, flags: flags)
    RunLoop.current.run(until: Date().addingTimeInterval(0.25))
}

func drag(_ note: NoteState, deltaX: Double) {
    let start = CGPoint(x: note.x + note.width / 2, y: note.y + note.height / 2)
    let end = CGPoint(x: start.x + deltaX, y: start.y)
    postMouse(.mouseMoved, at: start)
    postMouse(.leftMouseDown, at: start)
    for step in 1...10 {
        let t = Double(step) / 10
        postMouse(.leftMouseDragged, at: CGPoint(x: start.x + deltaX * t, y: start.y))
        RunLoop.current.run(until: Date().addingTimeInterval(0.015))
    }
    postMouse(.leftMouseUp, at: end)
    RunLoop.current.run(until: Date().addingTimeInterval(0.6))
}

func commandZ() {
    let source = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: source, virtualKey: 6, keyDown: true)
    let up = CGEvent(keyboardEventSource: source, virtualKey: 6, keyDown: false)
    down?.flags = .maskCommand
    up?.flags = .maskCommand
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
    RunLoop.current.run(until: Date().addingTimeInterval(0.6))
}

func fingerprint(pid: Int32) -> String {
    let window = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    let id = window?.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == pid })?[kCGWindowNumber as String] as? CGWindowID
    guard let id else { return "" }
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("mosh-midi-selection-\(UUID().uuidString).png")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-l", String(id), url.path]
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        return ""
    }
    defer { try? FileManager.default.removeItem(at: url) }
    guard process.terminationStatus == 0,
          let data = try? Data(contentsOf: url) else { return "" }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func changedCount(_ before: [NoteState], _ after: [NoteState]) -> Int {
    let lhs = before.map(\.title)
    let rhs = after.map(\.title)
    let removed = lhs.filter { title in !rhs.contains(title) }.count
    let added = rhs.filter { title in !lhs.contains(title) }.count
    return max(removed, added)
}

guard CommandLine.arguments.count >= 2,
      let pid = Int32(CommandLine.arguments[1]),
      let app = NSRunningApplication(processIdentifier: pid) else {
    fputs("usage: macos-midi-selection-gate.swift PID [OUTPUT_JSON]\n", stderr)
    exit(2)
}

let outputPath = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : nil
_ = app.activate(options: [.activateAllWindows])
RunLoop.current.run(until: Date().addingTimeInterval(0.4))
let before = notes(pid: pid)
guard before.count >= 3 else {
    fputs("no three visible MIDI note accessibility frames found\n", stderr)
    exit(3)
}
let target = before[0]
let companions = Array(before.dropFirst().prefix(2))
let laterX = before.filter { $0.x > target.x + 4 }.map(\.x).min()
let deltaX = laterX.map { max(24, $0 - target.x + max(12, target.width)) }
    ?? max(36, target.width + 24)
let beforeFingerprint = fingerprint(pid: pid)
click(target)
companions.forEach { click($0, flags: .maskShift) }
let selectedAfterGroup = notes(pid: pid).filter(\.selected).count
click(target)
let collapsed = notes(pid: pid)
let selectedAfterCollapse = collapsed.filter(\.selected).count
guard let currentTarget = collapsed.first(where: { $0.title == target.title }) else {
    fputs("selected target disappeared before drag\n", stderr)
    exit(5)
}
let selectedFingerprint = fingerprint(pid: pid)
drag(currentTarget, deltaX: deltaX)
let moved = notes(pid: pid)
let selectedAfterMove = moved.filter(\.selected).count
let changedNotes = changedCount(before, moved)
commandZ()
let restored = notes(pid: pid)
let undoRestored = restored.map(\.title).sorted() == before.map(\.title).sorted()
let report = SelectionReport(
    ok: selectedAfterGroup == 3
        && selectedAfterCollapse == 1
        && selectedAfterMove == 1
        && changedNotes == 1
        && undoRestored
        && !beforeFingerprint.isEmpty
        && beforeFingerprint != selectedFingerprint,
    pid: pid,
    selectedAfterGroup: selectedAfterGroup,
    selectedAfterCollapse: selectedAfterCollapse,
    selectedAfterMove: selectedAfterMove,
    changedNotes: changedNotes,
    undoRestored: undoRestored,
    beforeFingerprint: beforeFingerprint,
    selectedFingerprint: selectedFingerprint,
    before: before,
    moved: moved,
    restored: restored
)
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let data = try encoder.encode(report)
if let outputPath { try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic) }
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
exit(report.ok ? 0 : 1)
