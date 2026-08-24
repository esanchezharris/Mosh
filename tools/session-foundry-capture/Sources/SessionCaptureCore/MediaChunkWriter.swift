import AVFoundation
import CoreMedia
import CryptoKit
import Foundation
import VideoToolbox

public enum CapturedMediaKind: String, Sendable {
    case video
    case systemAudio = "system_audio"
    case microphone
}

public final class MediaChunkCoordinator: @unchecked Sendable {
    private let mediaDirectory: URL
    private let chunkDurationMilliseconds: Int64
    private var chunkSequence = 0
    private var chunkStartedMilliseconds: Int64 = 0
    private var videoWriter: AssetFileWriter?
    private var systemAudioWriter: AssetFileWriter?
    private var microphoneWriter: AssetFileWriter?
    private var completedChunks: [MediaChunkRecordV1] = []
    private var counters = CaptureDropCountersV1(incompleteVideoFrames: 0, writerBackpressureSamples: 0, appendFailures: 0)

    public init(mediaDirectory: URL, chunkDuration: TimeInterval) {
        self.mediaDirectory = mediaDirectory
        chunkDurationMilliseconds = Int64(chunkDuration * 1_000)
    }

    public func append(_ sampleBuffer: CMSampleBuffer, kind: CapturedMediaKind, elapsedMilliseconds: Int64) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else {
            counters.appendFailures += 1
            return
        }
        if elapsedMilliseconds - chunkStartedMilliseconds >= chunkDurationMilliseconds, hasStartedCurrentChunk {
            do {
                try finishCurrentChunk(endedElapsedMilliseconds: elapsedMilliseconds)
                chunkSequence += 1
                chunkStartedMilliseconds = elapsedMilliseconds
            } catch {
                counters.appendFailures += 1
            }
        }
        do {
            let writer = try writer(for: kind)
            switch writer.append(sampleBuffer) {
            case .appended:
                break
            case .backpressure:
                counters.writerBackpressureSamples += 1
            case .failed:
                counters.appendFailures += 1
            }
        } catch {
            counters.appendFailures += 1
        }
    }

    public func recordIncompleteVideoFrame() {
        counters.incompleteVideoFrames += 1
    }

    public func finish(elapsedMilliseconds: Int64) throws -> (chunks: [MediaChunkRecordV1], drops: CaptureDropCountersV1) {
        if hasStartedCurrentChunk {
            try finishCurrentChunk(endedElapsedMilliseconds: elapsedMilliseconds)
        }
        return (completedChunks, counters)
    }

    public func snapshot() -> (chunks: [MediaChunkRecordV1], drops: CaptureDropCountersV1) {
        (completedChunks, counters)
    }

    private var hasStartedCurrentChunk: Bool {
        videoWriter != nil || systemAudioWriter != nil || microphoneWriter != nil
    }

    private func writer(for kind: CapturedMediaKind) throws -> AssetFileWriter {
        switch kind {
        case .video:
            if let writer = videoWriter { return writer }
            let writer = try AssetFileWriter(directory: mediaDirectory, chunkSequence: chunkSequence, kind: kind)
            videoWriter = writer
            return writer
        case .systemAudio:
            if let writer = systemAudioWriter { return writer }
            let writer = try AssetFileWriter(directory: mediaDirectory, chunkSequence: chunkSequence, kind: kind)
            systemAudioWriter = writer
            return writer
        case .microphone:
            if let writer = microphoneWriter { return writer }
            let writer = try AssetFileWriter(directory: mediaDirectory, chunkSequence: chunkSequence, kind: kind)
            microphoneWriter = writer
            return writer
        }
    }

    private func finishCurrentChunk(endedElapsedMilliseconds: Int64) throws {
        let files = try [videoWriter, systemAudioWriter, microphoneWriter].compactMap { writer in
            try writer?.finish()
        }
        completedChunks.append(MediaChunkRecordV1(
            sequence: chunkSequence,
            startedElapsedMilliseconds: chunkStartedMilliseconds,
            endedElapsedMilliseconds: endedElapsedMilliseconds,
            files: files
        ))
        videoWriter = nil
        systemAudioWriter = nil
        microphoneWriter = nil
    }
}

private enum AppendResult {
    case appended
    case backpressure
    case failed
}

private final class AssetFileWriter {
    private let outputURL: URL
    private let kind: CapturedMediaKind
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?

    init(directory: URL, chunkSequence: Int, kind: CapturedMediaKind) throws {
        self.kind = kind
        let extensionName = kind == .video ? "mp4" : "m4a"
        outputURL = directory.appending(path: String(format: "%03d-%@.%@", chunkSequence, kind.rawValue, extensionName))
        if FileManager.default.fileExists(atPath: outputURL.path) {
            throw MediaWriterError.outputAlreadyExists(outputURL.path)
        }
    }

    func append(_ sampleBuffer: CMSampleBuffer) -> AppendResult {
        do {
            if writer == nil {
                try start(with: sampleBuffer)
            }
            guard let writer, let input else { return .failed }
            guard writer.status == .writing else { return .failed }
            guard input.isReadyForMoreMediaData else { return .backpressure }
            return input.append(sampleBuffer) ? .appended : .failed
        } catch {
            return .failed
        }
    }

    func finish() throws -> CapturedMediaFileV1? {
        guard let writer, let input else { return nil }
        input.markAsFinished()
        let semaphore = DispatchSemaphore(value: 0)
        writer.finishWriting { semaphore.signal() }
        semaphore.wait()
        guard writer.status == .completed else {
            throw MediaWriterError.finishFailed(writer.error?.localizedDescription ?? "unknown writer failure")
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outputURL.path)
        let data = try Data(contentsOf: outputURL, options: [.mappedIfSafe])
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        let bytes = (attributes[.size] as? NSNumber)?.int64Value ?? Int64(data.count)
        return CapturedMediaFileV1(kind: kind.rawValue, absolutePath: outputURL.path, sha256: hash, bytes: bytes)
    }

    private func start(with sampleBuffer: CMSampleBuffer) throws {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else {
            throw MediaWriterError.missingFormatDescription
        }
        let mediaType: AVMediaType
        let settings: [String: Any]
        switch kind {
        case .video:
            mediaType = .video
            let dimensions = CMVideoFormatDescriptionGetDimensions(formatDescription)
            settings = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: Int(dimensions.width),
                AVVideoHeightKey: Int(dimensions.height),
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: 10_000_000,
                    AVVideoMaxKeyFrameIntervalKey: 60,
                    AVVideoExpectedSourceFrameRateKey: 30,
                ],
                AVVideoEncoderSpecificationKey: [
                    kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as String: true,
                    kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
                ],
            ]
        case .systemAudio, .microphone:
            mediaType = .audio
            let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)?.pointee
            let channels = max(1, min(2, Int(streamDescription?.mChannelsPerFrame ?? 1)))
            settings = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: channels == 1 ? 128_000 : 192_000,
            ]
        }
        let newWriter = try AVAssetWriter(outputURL: outputURL, fileType: kind == .video ? .mp4 : .m4a)
        let newInput = AVAssetWriterInput(mediaType: mediaType, outputSettings: settings, sourceFormatHint: formatDescription)
        newInput.expectsMediaDataInRealTime = true
        guard newWriter.canAdd(newInput) else { throw MediaWriterError.cannotAddInput }
        newWriter.add(newInput)
        guard newWriter.startWriting() else {
            throw MediaWriterError.startFailed(newWriter.error?.localizedDescription ?? "unknown writer failure")
        }
        newWriter.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        writer = newWriter
        input = newInput
    }
}

public enum MediaWriterError: Error {
    case outputAlreadyExists(String)
    case missingFormatDescription
    case cannotAddInput
    case startFailed(String)
    case finishFailed(String)
}
