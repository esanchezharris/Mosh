import Foundation
import Testing
@testable import SessionCaptureCore

@Test func parsesBoundedCaptureArguments() throws {
    let arguments = try CaptureArguments.parse([
        "capture",
        "--session-id", "20260823T033000Z-test",
        "--session-directory", "/tmp/session",
        "--goal", "make a beat",
        "--set", "/tmp/beat.als",
        "--max-minutes", "120",
        "--chunk-minutes", "15",
    ])

    #expect(arguments.sessionID == "20260823T033000Z-test")
    #expect(arguments.maximumDuration == 120 * 60)
    #expect(arguments.chunkDuration == 15 * 60)
}

@Test func rejectsDuplicateAndOutOfBoundsArguments() {
    #expect(throws: CaptureArgumentError.self) {
        try CaptureArguments.parse([
            "capture",
            "--session-id", "one",
            "--session-id", "two",
            "--session-directory", "/tmp/session",
            "--goal", "beat",
            "--set", "/tmp/beat.als",
            "--max-minutes", "120",
            "--chunk-minutes", "15",
        ])
    }
}

@Test func createsOnlyPrivacySafeInputPayloads() throws {
    let event = InputEventRecord(
        elapsedMilliseconds: 123,
        kind: .keyDown,
        keyCode: 49,
        modifiers: 1_048_576,
        mouseX: nil,
        mouseY: nil
    )
    let encoded = try JSONEncoder().encode(event)
    let json = try #require(String(data: encoded, encoding: .utf8))

    #expect(json.contains("\"keyCode\":49"))
    #expect(!json.contains("characters"))
    #expect(!json.contains("clipboard"))
}

@Test func derivesDeterministicSessionPaths() {
    let paths = SessionPaths(root: URL(fileURLWithPath: "/tmp/session", isDirectory: true))
    #expect(paths.manifest.lastPathComponent == "manifest.json")
    #expect(paths.events.lastPathComponent == "input-events.jsonl")
    #expect(paths.media.lastPathComponent == "media")
    #expect(paths.setSnapshots.lastPathComponent == "sets")
}

@Test func evidenceStoreSnapshotsTheAbletonSetAndWritesAnOwnerManifest() throws {
    let temporary = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let set = temporary.appending(path: "beat.als")
    try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
    try Data("first-save".utf8).write(to: set)
    let arguments = CaptureArguments(
        sessionID: "test-session",
        sessionDirectory: temporary.appending(path: "session", directoryHint: .isDirectory),
        goal: "make a beat",
        abletonSet: set,
        maximumDuration: 7_200,
        chunkDuration: 900
    )

    let store = try EvidenceStore(arguments: arguments, startedAt: Date(timeIntervalSince1970: 1_000))
    try store.snapshotSetIfChanged(elapsedMilliseconds: 0)
    let manifestData = try Data(contentsOf: store.paths.manifest)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    let manifest = try decoder.decode(SessionCaptureManifestV1.self, from: manifestData)

    #expect(manifest.state == .capturing)
    #expect(manifest.setSnapshots.count == 1)
    #expect(FileManager.default.fileExists(atPath: manifest.setSnapshots[0].absoluteCopyPath))
    let attributes = try FileManager.default.attributesOfItem(atPath: store.paths.manifest.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
}
