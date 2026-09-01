import AppKit
import ApplicationServices
import CryptoKit
import Foundation

struct CursorFingerprint: Codable, Equatable {
    let sha256: String
    let hotX: Double
    let hotY: Double
    let width: Double
    let height: Double
}

struct CursorSample: Codable {
    let zoomLevel: Int
    let repetition: Int
    let target: String
    let actual: CursorFingerprint
    let expected: CursorFingerprint
    let ok: Bool
}

struct CursorReport: Codable {
    let ok: Bool
    let pid: Int32
    let note: String
    let gridFrames: [NoteFrame]
    let noteFrames: [NoteFrame]
    let samples: [CursorSample]
}

struct NoteFrame: Codable {
    let zoomLevel: Int
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct AxFrame {
    let title: String
    let rect: CGRect
}

struct AxSnapshot {
    let notes: [AxFrame]
    let grids: [CGRect]
}

func axAttribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}

func axPoint(_ value: CFTypeRef?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func axSize(_ value: CFTypeRef?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func axSnapshot(pid: Int32) -> AxSnapshot {
    let root = AXUIElementCreateApplication(pid)
    var notes: [AxFrame] = []
    var grids: [CGRect] = []
    var visited = 0

    func walk(_ element: AXUIElement) {
        guard visited < 3000 else { return }
        visited += 1
        let title = axAttribute(element, kAXTitleAttribute as CFString) as? String ?? ""
        let description = axAttribute(element, kAXDescriptionAttribute as CFString) as? String ?? ""
        if title == "Piano roll grid" || description == "Piano roll grid",
           let point = axPoint(axAttribute(element, kAXPositionAttribute as CFString)),
           let size = axSize(axAttribute(element, kAXSizeAttribute as CFString)) {
            grids.append(CGRect(origin: point, size: size))
        }
        if title.contains(" note start "),
           let point = axPoint(axAttribute(element, kAXPositionAttribute as CFString)),
           let size = axSize(axAttribute(element, kAXSizeAttribute as CFString)),
           size.width >= 6,
           size.height > 0 {
            notes.append(AxFrame(title: title, rect: CGRect(origin: point, size: size)))
        }

        let children = axAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
        for child in children { walk(child) }
    }

    walk(root)
    let visible = notes.filter { frame in
        let midpoint = CGPoint(x: frame.rect.midX, y: frame.rect.midY)
        return NSScreen.screens.contains { $0.frame.intersects(frame.rect) }
            && (grids.isEmpty || grids.contains { $0.contains(midpoint) })
    }
    return AxSnapshot(notes: visible, grids: grids)
}

func cursorFingerprint(_ cursor: NSCursor) -> CursorFingerprint {
    let data = cursor.image.tiffRepresentation ?? Data()
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    return CursorFingerprint(
        sha256: digest,
        hotX: cursor.hotSpot.x,
        hotY: cursor.hotSpot.y,
        width: cursor.image.size.width,
        height: cursor.image.size.height
    )
}

func stableCurrentCursor(timeout: TimeInterval = 1.0) -> CursorFingerprint {
    let deadline = Date().addingTimeInterval(timeout)
    var previous: CursorFingerprint?
    var stableCount = 0

    while Date() < deadline {
        let current = cursorFingerprint(NSCursor.currentSystem ?? NSCursor.arrow)
        stableCount = current == previous ? stableCount + 1 : 0
        if stableCount >= 2 { return current }
        previous = current
        RunLoop.current.run(until: Date().addingTimeInterval(0.03))
    }

    return cursorFingerprint(NSCursor.currentSystem ?? NSCursor.arrow)
}

func requireMoshFrontmost(_ app: NSRunningApplication, phase: String) {
    guard !app.isTerminated,
          app.bundleIdentifier == "studio.mosh.app",
          NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
        fputs("target Mosh process lost focus before \(phase)\n", stderr)
        exit(5)
    }
}

func moveMouse(to point: CGPoint, app: NSRunningApplication) {
    requireMoshFrontmost(app, phase: "cursor move")
    let source = CGEventSource(stateID: .hidSystemState)
    let event = CGEvent(
        mouseEventSource: source,
        mouseType: .mouseMoved,
        mouseCursorPosition: point,
        mouseButton: .left
    )
    event?.post(tap: .cghidEventTap)
}

func focusWindow(pid: Int32, app: NSRunningApplication) {
    let root = AXUIElementCreateApplication(pid)
    guard let window = (axAttribute(root, kAXWindowsAttribute as CFString) as? [AXUIElement])?.first,
          let point = axPoint(axAttribute(window, kAXPositionAttribute as CFString)),
          let size = axSize(axAttribute(window, kAXSizeAttribute as CFString)) else { return }
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    requireMoshFrontmost(app, phase: "window focus")
    let titleBarPoint = CGPoint(x: point.x + size.width / 2, y: point.y + 12)
    let source = CGEventSource(stateID: .hidSystemState)
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        CGEvent(
            mouseEventSource: source,
            mouseType: type,
            mouseCursorPosition: titleBarPoint,
            mouseButton: .left
        )?.post(tap: .cghidEventTap)
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.15))
}

func commandScroll(at point: CGPoint, delta: Int32, app: NSRunningApplication) {
    requireMoshFrontmost(app, phase: "zoom")
    let source = CGEventSource(stateID: .hidSystemState)
    let event = CGEvent(
        scrollWheelEvent2Source: source,
        units: .pixel,
        wheelCount: 1,
        wheel1: delta,
        wheel2: 0,
        wheel3: 0
    )
    event?.flags = .maskControl
    event?.location = point
    event?.post(tap: .cghidEventTap)
    RunLoop.current.run(until: Date().addingTimeInterval(0.35))
}

guard CommandLine.arguments.count >= 2,
      let pid = Int32(CommandLine.arguments[1]),
      let app = NSRunningApplication(processIdentifier: pid),
      app.bundleIdentifier == "studio.mosh.app" else {
    fputs("usage: macos-midi-cursor-gate.swift PID [OUTPUT_JSON]\n", stderr)
    exit(2)
}

let outputPath = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : nil
_ = app.activate(options: [.activateAllWindows])
RunLoop.current.run(until: Date().addingTimeInterval(0.35))
requireMoshFrontmost(app, phase: "initial focus")
focusWindow(pid: pid, app: app)
requireMoshFrontmost(app, phase: "initial cursor check")

let expected: [String: CursorFingerprint] = [
    "center": cursorFingerprint(NSCursor.openHand),
    "left-edge": cursorFingerprint(NSCursor.resizeLeftRight),
    "right-edge": cursorFingerprint(NSCursor.resizeLeftRight),
]
let zoomDeltas: [Int32] = [0, -120, 240]
var samples: [CursorSample] = []
var gridFrames: [NoteFrame] = []
var noteFrames: [NoteFrame] = []
var noteTitle = ""
var lastPoint = CGPoint.zero

for (zoomLevel, delta) in zoomDeltas.enumerated() {
    if delta != 0 { commandScroll(at: lastPoint, delta: delta, app: app) }
    let snapshot = axSnapshot(pid: pid)
    gridFrames.append(contentsOf: snapshot.grids.map { rect in
        NoteFrame(
            zoomLevel: zoomLevel + 1,
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height
        )
    })
    guard let note = snapshot.notes.max(by: { $0.rect.width < $1.rect.width }) else {
        fputs("no visible MIDI note accessibility frame found\n", stderr)
        exit(3)
    }
    noteTitle = note.title
    noteFrames.append(NoteFrame(
        zoomLevel: zoomLevel + 1,
        x: note.rect.origin.x,
        y: note.rect.origin.y,
        width: note.rect.size.width,
        height: note.rect.size.height
    ))
    let y = note.rect.midY
    let points: [(String, CGPoint)] = [
        ("center", CGPoint(x: note.rect.midX, y: y)),
        ("left-edge", CGPoint(x: note.rect.minX + 2, y: y)),
        ("right-edge", CGPoint(x: note.rect.maxX - 2, y: y)),
    ]
    let blank = CGPoint(x: note.rect.maxX + 30, y: y)
    lastPoint = points[0].1

    for repetition in 1...3 {
        for (target, point) in points {
            moveMouse(to: blank, app: app)
            _ = stableCurrentCursor()
            moveMouse(to: point, app: app)
            let actual = stableCurrentCursor()
            guard let targetExpected = expected[target] else { exit(4) }
            samples.append(CursorSample(
                zoomLevel: zoomLevel + 1,
                repetition: repetition,
                target: target,
                actual: actual,
                expected: targetExpected,
                ok: actual == targetExpected
            ))
        }
    }
}

commandScroll(at: lastPoint, delta: -120, app: app)
let report = CursorReport(
    ok: samples.allSatisfy(\.ok),
    pid: pid,
    note: noteTitle,
    gridFrames: gridFrames,
    noteFrames: noteFrames,
    samples: samples
)
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let reportData = try encoder.encode(report)
if let outputPath { try reportData.write(to: URL(fileURLWithPath: outputPath), options: .atomic) }
FileHandle.standardOutput.write(reportData)
FileHandle.standardOutput.write(Data("\n".utf8))
exit(report.ok ? 0 : 1)
