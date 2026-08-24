import Foundation

public struct SessionPaths: Sendable, Equatable {
    public let root: URL
    public let media: URL
    public let setSnapshots: URL
    public let manifest: URL
    public let events: URL

    public init(root: URL) {
        self.root = root
        media = root.appending(path: "media", directoryHint: .isDirectory)
        setSnapshots = root.appending(path: "sets", directoryHint: .isDirectory)
        manifest = root.appending(path: "manifest.json")
        events = root.appending(path: "input-events.jsonl")
    }
}

public enum InputEventKind: String, Codable, Sendable {
    case keyDown = "key_down"
    case leftMouseDown = "left_mouse_down"
    case leftMouseUp = "left_mouse_up"
    case rightMouseDown = "right_mouse_down"
    case rightMouseUp = "right_mouse_up"
}

public struct InputEventRecord: Codable, Sendable, Equatable {
    public let elapsedMilliseconds: Int64
    public let kind: InputEventKind
    public let keyCode: UInt16?
    public let modifiers: UInt
    public let mouseX: Double?
    public let mouseY: Double?

    public init(
        elapsedMilliseconds: Int64,
        kind: InputEventKind,
        keyCode: UInt16?,
        modifiers: UInt,
        mouseX: Double?,
        mouseY: Double?
    ) {
        self.elapsedMilliseconds = elapsedMilliseconds
        self.kind = kind
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.mouseX = mouseX
        self.mouseY = mouseY
    }
}
