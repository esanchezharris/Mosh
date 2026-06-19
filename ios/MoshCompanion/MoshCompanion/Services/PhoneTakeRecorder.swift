import AVFoundation
import Foundation

@MainActor
final class PhoneTakeRecorder: ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var level: Float = 0

    private let engine = AVAudioEngine()
    private var activeTakeId: String?
    private var uploadSequencer: ChunkSequencer?

    func start(client: CompanionClientProtocol, trackId: String?, name: String) async throws {
        guard !isRecording else { return }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true)

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        let sampleRate = format.sampleRate
        let channels = max(1, min(2, Int(format.channelCount)))
        let started = try await client.startTake(trackId: trackId, name: name, sampleRate: sampleRate, channels: channels)

        activeTakeId = started.takeId
        let sequencer = ChunkSequencer()
        uploadSequencer = sequencer
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self, weak client, sequencer, takeId = started.takeId] buffer, _ in
            guard let client else { return }
            let pcm = Self.pcm16Data(from: buffer, channels: channels)
            let seq = sequencer.nextSequence()
            let task = Task { try await client.appendTakeChunk(takeId: takeId, sequence: seq, pcm16: pcm) }
            sequencer.add(task)
            Task { @MainActor in self?.level = Self.peakLevel(from: buffer) }
        }

        engine.prepare()
        try engine.start()
        isRecording = true
    }

    func stop(client: CompanionClientProtocol) async throws {
        guard let takeId = activeTakeId else { return }
        let sequencer = uploadSequencer
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
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

        private func pendingTasks() -> [Task<Void, Error>] {
            lock.lock()
            let pending = tasks
            lock.unlock()
            return pending
        }
    }
}
