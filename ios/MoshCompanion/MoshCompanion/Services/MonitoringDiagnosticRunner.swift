import AVFoundation
import Foundation

@MainActor
final class MonitoringDiagnosticRunner: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var lastReport: MonitoringReportPayload?
    @Published private(set) var lastReportFile: String?
    @Published private(set) var errorText: String?

    func run(client: CompanionClientProtocol) async {
        guard !isRunning else { return }
        isRunning = true
        errorText = nil
        defer { isRunning = false }

        do {
            let clockSamples = try await collectClockSamples(client: client)
            let offset = MonitoringMetrics.estimateClockOffsetMs(samples: clockSamples)
            let session = try await client.startMonitor(mode: "both")
            defer { Task { try? await client.stopMonitor(sessionId: session.sessionId) } }

            let audio = try AudioProbe(sampleRate: Double(session.sampleRate))
            try audio.start()
            defer { audio.stop() }

            var playbackSamples: [MonitoringPlaybackSample] = []
            var firstScheduledPhoneMs: Double?

            for sequence in 0..<12 {
                let chunk = try await client.nextMonitorChunk(sessionId: session.sessionId, sequence: sequence)
                let scheduledPhoneMs = Self.nowMs()
                if firstScheduledPhoneMs == nil { firstScheduledPhoneMs = scheduledPhoneMs }
                playbackSamples.append(
                    MonitoringPlaybackSample(
                        macSentMs: chunk.sentAtMacMs,
                        phoneScheduledPlaybackMs: scheduledPhoneMs
                    )
                )
                try audio.schedule(base64Pcm16: chunk.pcm16Base64, sampleRate: chunk.sampleRate)
                try await Task.sleep(nanoseconds: 55_000_000)
            }

            try await Task.sleep(nanoseconds: 450_000_000)

            let network = MonitoringMetrics.playoutSummary(samples: playbackSamples, clockOffsetMs: offset)
            let recorded = audio.recordedSamples()
            let acousticLatency = MonitoringMetrics
                .detectAcousticOnsetMs(samples: recorded.samples, sampleRate: recorded.sampleRate, threshold: 0.18)
                .map { onsetMs in
                    let onsetPhoneMs = recorded.startedAtPhoneMs + onsetMs
                    return max(0, onsetPhoneMs - (firstScheduledPhoneMs ?? onsetPhoneMs))
                }
            let acoustic = MonitoringMetrics.acousticSummary(onsetDeltasMs: acousticLatency.map { [$0] } ?? [])

            let report = MonitoringReportPayload(
                sessionId: session.sessionId,
                networkMedianMs: network.medianMs,
                networkP95Ms: network.p95Ms,
                networkJitterMs: network.jitterMs,
                acousticMedianMs: acoustic.medianMs,
                acousticP95Ms: acoustic.p95Ms,
                acousticJitterMs: acoustic.jitterMs
            )
            let ack = try await client.reportMonitor(report)
            lastReport = report
            lastReportFile = ack.reportFile
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func collectClockSamples(client: CompanionClientProtocol) async throws -> [MonitoringClockSample] {
        var samples: [MonitoringClockSample] = []
        for _ in 0..<6 {
            let macSendApprox = Self.nowMs()
            let phoneReceive = Self.nowMs()
            let response = try await client.monitorPing(phoneTimeMs: phoneReceive)
            let phoneSend = Self.nowMs()
            let macReceiveApprox = response.macTimeMs + max(0, Self.nowMs() - phoneSend)
            samples.append(
                MonitoringClockSample(
                    macSendMs: macSendApprox,
                    macReceiveMs: macReceiveApprox,
                    phoneReceiveMs: response.phoneTimeMs,
                    phoneSendMs: phoneSend
                )
            )
            try await Task.sleep(nanoseconds: 35_000_000)
        }
        return samples
    }

    private static func nowMs() -> Double {
        Date().timeIntervalSince1970 * 1000.0
    }
}

private final class AudioProbe {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format: AVAudioFormat
    private let collector = SampleCollector()

    init(sampleRate: Double) throws {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                         sampleRate: sampleRate,
                                         channels: 1,
                                         interleaved: false) else {
            throw CompanionError.missingResponse
        }
        self.format = format
    }

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setPreferredSampleRate(format.sampleRate)
        try session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true)

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        collector.start(sampleRate: inputFormat.sampleRate)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [collector] buffer, _ in
            collector.append(buffer)
        }

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.prepare()
        try engine.start()
        player.play()
    }

    func schedule(base64Pcm16: String, sampleRate: Int) throws {
        guard let data = Data(base64Encoded: base64Pcm16),
              let buffer = Self.makeBuffer(data: data, sampleRate: Double(sampleRate)) else {
            throw CompanionError.missingResponse
        }
        player.scheduleBuffer(buffer)
    }

    func recordedSamples() -> (samples: [Float], sampleRate: Double, startedAtPhoneMs: Double) {
        collector.snapshot()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    private static func makeBuffer(data: Data, sampleRate: Double) -> AVAudioPCMBuffer? {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                         sampleRate: sampleRate,
                                         channels: 1,
                                         interleaved: false) else { return nil }
        let frames = data.count / MemoryLayout<Int16>.size
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<frames {
                channel[index] = Float(Int16(littleEndian: samples[index])) / Float(Int16.max)
            }
        }
        return buffer
    }
}

private final class SampleCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [Float] = []
    private var sampleRate: Double = 48_000
    private var startedAtPhoneMs: Double = 0

    func start(sampleRate: Double) {
        lock.lock()
        samples.removeAll(keepingCapacity: true)
        self.sampleRate = sampleRate
        self.startedAtPhoneMs = Date().timeIntervalSince1970 * 1000.0
        lock.unlock()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let source = buffer.floatChannelData?[0] else { return }
        let frameCount = Int(buffer.frameLength)
        lock.lock()
        samples.reserveCapacity(samples.count + frameCount)
        for frame in 0..<frameCount {
            samples.append(source[frame])
        }
        lock.unlock()
    }

    func snapshot() -> (samples: [Float], sampleRate: Double, startedAtPhoneMs: Double) {
        lock.lock()
        let result = (samples, sampleRate, startedAtPhoneMs)
        lock.unlock()
        return result
    }
}
