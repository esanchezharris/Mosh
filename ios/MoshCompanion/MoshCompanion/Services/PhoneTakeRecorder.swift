import AVFoundation
import Foundation

struct PhoneTakeAudioFormat: Equatable {
    let sampleRate: Double
    let channels: Int
}

@MainActor
protocol PhoneTakeAudioSource: AnyObject {
    func prepare() async throws -> PhoneTakeAudioFormat
    func start(onChunk: @escaping (Data, Float) -> Void) throws
    func stop()
    func cancel()
}

@MainActor
protocol AudioRecordingPermissionAuthorizing: AnyObject {
    func requestPermission() async -> Bool
}

@MainActor
final class AppleAudioRecordingPermissionAuthorizer: AudioRecordingPermissionAuthorizing {
    func requestPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        @unknown default:
            return false
        }
    }
}

@MainActor
final class PhoneTakeRecorder: ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var level: Float = 0

    private let audioSource: PhoneTakeAudioSource
    private let permissionAuthorizer: AudioRecordingPermissionAuthorizing
    private var activeTakeId: String?
    private var uploadSequencer: ChunkSequencer?

    init(
        audioSource: PhoneTakeAudioSource = AVAudioEnginePhoneTakeAudioSource(),
        permissionAuthorizer: AudioRecordingPermissionAuthorizing = AppleAudioRecordingPermissionAuthorizer()
    ) {
        self.audioSource = audioSource
        self.permissionAuthorizer = permissionAuthorizer
    }

    func start(client: CompanionClientProtocol, trackId: String?, name: String) async throws {
        guard !isRecording else { return }
        guard await permissionAuthorizer.requestPermission() else {
            throw CompanionError.microphoneUnavailable
        }

        let format = try await audioSource.prepare()
        let started = try await client.startTake(
            trackId: trackId,
            name: name,
            sampleRate: format.sampleRate,
            channels: format.channels
        )

        activeTakeId = started.takeId
        let sequencer = ChunkSequencer()
        uploadSequencer = sequencer
        try audioSource.start { [weak self, weak client, sequencer, takeId = started.takeId] pcm, level in
            guard let client else { return }
            let seq = sequencer.nextSequence()
            let task = Task { try await client.appendTakeChunk(takeId: takeId, sequence: seq, pcm16: pcm) }
            sequencer.add(task)
            Task { @MainActor in self?.level = level }
        }

        isRecording = true
    }

    func stop(client: CompanionClientProtocol) async throws {
        guard let takeId = activeTakeId else { return }
        let sequencer = uploadSequencer
        audioSource.stop()
        activeTakeId = nil
        uploadSequencer = nil
        isRecording = false
        level = 0
        do {
            try await sequencer?.waitForUploads()
            try await client.finishTake(takeId: takeId)
        } catch {
            try? await client.cancelTake(takeId: takeId)
            throw error
        }
    }

    func cancel(client: CompanionClientProtocol) async {
        guard let takeId = activeTakeId else { return }
        let sequencer = uploadSequencer
        audioSource.cancel()
        activeTakeId = nil
        uploadSequencer = nil
        isRecording = false
        level = 0
        sequencer?.cancel()
        try? await client.cancelTake(takeId: takeId)
    }

    private final class ChunkSequencer: @unchecked Sendable {
        private let lock = NSLock()
        private var sequence = 0
        private var tasks: [Task<Void, Error>] = []

        func nextSequence() -> Int {
            lock.lock()
            defer { lock.unlock() }
            defer { sequence += 1 }
            return sequence
        }

        func add(_ task: Task<Void, Error>) {
            lock.lock()
            tasks.append(task)
            lock.unlock()
        }

        func waitForUploads() async throws {
            for task in pendingTasks() {
                try await task.value
            }
        }

        func cancel() {
            for task in pendingTasks() {
                task.cancel()
            }
        }

        private func pendingTasks() -> [Task<Void, Error>] {
            lock.lock()
            let pending = tasks
            lock.unlock()
            return pending
        }
    }
}

@MainActor
private final class AVAudioEnginePhoneTakeAudioSource: PhoneTakeAudioSource {
    private let engine = AVAudioEngine()
    private var preparedFormat: AVAudioFormat?
    private var preparedChannels = 1

    func prepare() async throws -> PhoneTakeAudioFormat {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true)

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        preparedFormat = format
        preparedChannels = max(1, min(2, Int(format.channelCount)))
        return PhoneTakeAudioFormat(sampleRate: format.sampleRate, channels: preparedChannels)
    }

    func start(onChunk: @escaping (Data, Float) -> Void) throws {
        let input = engine.inputNode
        let format = preparedFormat ?? input.outputFormat(forBus: 0)
        let channels = preparedChannels
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            let pcm = Self.pcm16Data(from: buffer, channels: channels)
            let level = Self.peakLevel(from: buffer)
            onChunk(pcm, level)
        }

        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    func cancel() {
        stop()
    }

    nonisolated private static func pcm16Data(from buffer: AVAudioPCMBuffer, channels: Int) -> Data {
        guard let source = buffer.floatChannelData else { return Data() }
        let frames = Int(buffer.frameLength)
        var data = Data()
        data.reserveCapacity(frames * channels * 2)

        for frame in 0..<frames {
            for channel in 0..<channels {
                let sample = max(-1, min(1, source[channel][frame]))
                var intSample = Int16(sample * Float(Int16.max)).littleEndian
                withUnsafeBytes(of: &intSample) { data.append(contentsOf: $0) }
            }
        }
        return data
    }

    nonisolated private static func peakLevel(from buffer: AVAudioPCMBuffer) -> Float {
        guard let source = buffer.floatChannelData else { return 0 }
        let frames = Int(buffer.frameLength)
        let channels = Int(buffer.format.channelCount)
        var peak: Float = 0
        for channel in 0..<channels {
            for frame in 0..<frames {
                peak = max(peak, abs(source[channel][frame]))
            }
        }
        return peak
    }
}
