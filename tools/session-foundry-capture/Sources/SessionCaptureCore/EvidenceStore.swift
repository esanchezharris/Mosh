import CryptoKit
import Foundation

public enum SessionCaptureStateV1: String, Codable, Sendable {
    case capturing
    case completed
    case failed
}

public struct SetSnapshotRecordV1: Codable, Sendable, Equatable {
    public let sequence: Int
    public let elapsedMilliseconds: Int64
    public let sha256: String
    public let bytes: Int
    public let absoluteCopyPath: String
}

public struct CaptureMarkRecordV1: Codable, Sendable, Equatable {
    public let sequence: Int
    public let elapsedMilliseconds: Int64
}

public struct CapturedMediaFileV1: Codable, Sendable, Equatable {
    public let kind: String
    public let absolutePath: String
    public let sha256: String
    public let bytes: Int64
}

public struct MediaChunkRecordV1: Codable, Sendable, Equatable {
    public let sequence: Int
    public let startedElapsedMilliseconds: Int64
    public let endedElapsedMilliseconds: Int64
    public let files: [CapturedMediaFileV1]
}

public struct CaptureDropCountersV1: Codable, Sendable, Equatable {
    public var incompleteVideoFrames: Int
    public var writerBackpressureSamples: Int
    public var appendFailures: Int
}

public struct SessionCaptureManifestV1: Codable, Sendable, Equatable {
    public let schemaVersion: Int
    public let sessionID: String
    public var state: SessionCaptureStateV1
    public let goal: String
    public let abletonSetPath: String
    public let referenceApplication: String
    public let startedAt: Date
    public var endedAt: Date?
    public let maximumDurationSeconds: Int
    public let chunkDurationSeconds: Int
    public let video: VideoCaptureSettingsV1
    public let audio: AudioCaptureSettingsV1
    public var inputEventCaptureAvailable: Bool
    public var setSnapshots: [SetSnapshotRecordV1]
    public var marks: [CaptureMarkRecordV1]
    public var chunks: [MediaChunkRecordV1]
    public var drops: CaptureDropCountersV1
    public var failure: String?
}

public struct VideoCaptureSettingsV1: Codable, Sendable, Equatable {
    public let maximumWidth: Int
    public let maximumHeight: Int
    public let framesPerSecond: Int
    public let codec: String
    public let hardwareAccelerationRequired: Bool
}

public struct AudioCaptureSettingsV1: Codable, Sendable, Equatable {
    public let systemAndMicrophoneAreSeparate: Bool
    public let targetSampleRate: Int
    public let codec: String
    public let changesCoreAudioRouting: Bool
}

public final class EvidenceStore: @unchecked Sendable {
    public let paths: SessionPaths
    private let lock = NSLock()
    private var manifest: SessionCaptureManifestV1
    private var lastSetHash: String?

    public init(arguments: CaptureArguments, startedAt: Date) throws {
        paths = SessionPaths(root: arguments.sessionDirectory)
        manifest = SessionCaptureManifestV1(
            schemaVersion: 1,
            sessionID: arguments.sessionID,
            state: .capturing,
            goal: arguments.goal,
            abletonSetPath: arguments.abletonSet.path,
            referenceApplication: "Ableton Live 11 Standard",
            startedAt: startedAt,
            endedAt: nil,
            maximumDurationSeconds: Int(arguments.maximumDuration),
            chunkDurationSeconds: Int(arguments.chunkDuration),
            video: VideoCaptureSettingsV1(
                maximumWidth: 2_560,
                maximumHeight: 1_440,
                framesPerSecond: 30,
                codec: "h264",
                hardwareAccelerationRequired: true
            ),
            audio: AudioCaptureSettingsV1(
                systemAndMicrophoneAreSeparate: true,
                targetSampleRate: 48_000,
                codec: "aac",
                changesCoreAudioRouting: false
            ),
            inputEventCaptureAvailable: false,
            setSnapshots: [],
            marks: [],
            chunks: [],
            drops: CaptureDropCountersV1(incompleteVideoFrames: 0, writerBackpressureSamples: 0, appendFailures: 0),
            failure: nil
        )

        try FileManager.default.createDirectory(at: paths.root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: paths.media, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: paths.setSnapshots, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try writeManifestLocked()
    }

    public func snapshotSetIfChanged(elapsedMilliseconds: Int64) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: manifest.abletonSetPath)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.referenceCount] as? NSNumber)?.intValue == 1 else {
            throw EvidenceStoreError.unsafeAbletonSet
        }
        if let owner = attributes[.ownerAccountID] as? NSNumber, owner.uint32Value != getuid() {
            throw EvidenceStoreError.unsafeAbletonSet
        }
        let source = URL(fileURLWithPath: manifest.abletonSetPath)
        let data = try Data(contentsOf: source, options: [.mappedIfSafe])
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()

        lock.lock()
        defer { lock.unlock() }
        guard lastSetHash != hash else { return }
        let sequence = manifest.setSnapshots.count
        let copy = paths.setSnapshots.appending(path: String(format: "%03d-%@.als", sequence, String(hash.prefix(16))))
        try data.write(to: copy, options: [.atomic])
        try secureFile(copy)
        manifest.setSnapshots.append(SetSnapshotRecordV1(
            sequence: sequence,
            elapsedMilliseconds: elapsedMilliseconds,
            sha256: hash,
            bytes: data.count,
            absoluteCopyPath: copy.path
        ))
        lastSetHash = hash
        try writeManifestLocked()
    }

    public func setInputEventCaptureAvailable(_ available: Bool) throws {
        try mutateManifest { value in value.inputEventCaptureAvailable = available }
    }

    public func addMark(elapsedMilliseconds: Int64) throws {
        try mutateManifest { value in
            value.marks.append(CaptureMarkRecordV1(sequence: value.marks.count, elapsedMilliseconds: elapsedMilliseconds))
        }
    }

    public func updateMedia(chunks: [MediaChunkRecordV1], drops: CaptureDropCountersV1) throws {
        try mutateManifest { value in
            value.chunks = chunks
            value.drops = drops
        }
    }

    public func complete(at date: Date, chunks: [MediaChunkRecordV1], drops: CaptureDropCountersV1) throws {
        try mutateManifest { value in
            value.state = .completed
            value.endedAt = date
            value.chunks = chunks
            value.drops = drops
        }
    }

    public func fail(at date: Date, message: String, chunks: [MediaChunkRecordV1], drops: CaptureDropCountersV1) throws {
        try mutateManifest { value in
            value.state = .failed
            value.endedAt = date
            value.chunks = chunks
            value.drops = drops
            value.failure = message
        }
    }

    private func mutateManifest(_ body: (inout SessionCaptureManifestV1) -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        body(&manifest)
        try writeManifestLocked()
    }

    private func writeManifestLocked() throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(manifest)
        data.append(0x0A)
        try data.write(to: paths.manifest, options: [.atomic])
        try secureFile(paths.manifest)
    }

    private func secureFile(_ url: URL) throws {
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

public enum EvidenceStoreError: Error {
    case unsafeAbletonSet
}
