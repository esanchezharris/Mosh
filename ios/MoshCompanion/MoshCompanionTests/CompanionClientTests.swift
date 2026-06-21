import XCTest
@testable import MoshCompanion

@MainActor
final class CompanionClientTests: XCTestCase {
    func testPairingURLParsesPercentEscapedPayload() throws {
        let json = #"{"host":"Studio-Mac.local","port":47873,"token":"abc+123/="}"#
        let payload = Data(json.utf8).base64EncodedString()
        let escaped = try XCTUnwrap(payload.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed))

        let parsed = try CompanionClient.parsePairingURL("mosh://pair?payload=\(escaped)")

        XCTAssertEqual(parsed.host, "Studio-Mac.local")
        XCTAssertEqual(parsed.port, 47873)
        XCTAssertEqual(parsed.token, "abc+123/=")
    }

    func testPairingPayloadBuildsRoundTrippableSimulatorDeepLink() throws {
        let payload = PairingPayload(host: "127.0.0.1", port: 47874, token: "sim token+/=")

        let url = try XCTUnwrap(payload.companionDeepLinkURL)
        let parsed = try CompanionClient.parsePairingURL(url.absoluteString)

        XCTAssertEqual(url.scheme, "mosh")
        XCTAssertEqual(url.host, "pair")
        XCTAssertEqual(parsed, payload)
    }

    func testSnapshotDecodesArtifactReadyRenderTargets() throws {
        let json = """
        {
          "tracks": [
            {
              "id": "track-1",
              "index": 0,
              "name": "Vox",
              "clips": [
                {
                  "id": "clip-1",
                  "name": "Lead",
                  "type": "wave",
                  "start": 0,
                  "length": 2.5,
                  "hasRenderLayer": true,
                  "renderLayer": {
                    "id": "layer-1",
                    "status": "ready",
                    "adapter": "fake",
                    "mode": "reimagine",
                    "seed": 7,
                    "userKept": false,
                    "hasArtifact": true
                  }
                }
              ]
            }
          ],
          "transport": { "playing": false, "recording": false, "position": 0, "looping": false }
        }
        """

        let snapshot = try JSONDecoder().decode(MoshSnapshot.self, from: Data(json.utf8))

        XCTAssertEqual(snapshot.renderTargets.map(\.clipId), ["clip-1"])
        XCTAssertEqual(snapshot.renderTargets.first?.title, "Vox · Lead")
        XCTAssertEqual(snapshot.tracks.first?.clips.first?.renderLayer?.hasArtifact, true)
    }

    func testStoreAcceptRejectSendSelectedRenderCommands() async {
        let client = MockCompanionClient()
        client.snapshotValue = MoshSnapshot(
            tracks: [
                MoshTrack(
                    id: "track-1",
                    index: 0,
                    name: "Vox",
                    clips: [
                        MoshClip(
                            id: "clip-1",
                            name: "Lead",
                            type: "wave",
                            start: 0,
                            length: 2,
                            hasRenderLayer: true,
                            renderLayer: MoshRenderLayer(
                                id: "layer-1",
                                status: "ready",
                                adapter: "fake",
                                mode: "reimagine",
                                seed: 4,
                                userKept: false,
                                hasArtifact: true
                            )
                        )
                    ]
                )
            ],
            transport: MoshTransport(playing: false, recording: false, position: 0, looping: false)
        )
        let store = CompanionStore(client: client)

        await store.refresh()
        XCTAssertEqual(store.selectedRenderClipId, "clip-1")

        await store.runRenderDecision(.accept)
        await store.runRenderDecision(.reject)

        XCTAssertEqual(client.commands.map(\.command), ["accept_render", "reject_render"])
        XCTAssertEqual(client.commands.map { $0.args["clipId"] as? String }, ["clip-1", "clip-1"])
    }

    func testVoiceAcceptRejectRequiresSelectedRenderTarget() async {
        let client = MockCompanionClient()
        client.snapshotValue = MoshSnapshot(
            tracks: [
                MoshTrack(id: "track-1", index: 0, name: "Empty", clips: [])
            ],
            transport: MoshTransport(playing: false, recording: false, position: 0, looping: false)
        )
        let store = CompanionStore(client: client)

        await store.refresh()
        await store.runVoiceCommand("accept render")

        XCTAssertTrue(client.commands.isEmpty)
        XCTAssertTrue(store.receipts.first?.contains("needs a rendered clip") == true)
    }

    func testFixtureSpeechSourceFeedsRecognizedCommandPath() async throws {
        let source = FixtureSpeechCommandSource(transcripts: ["Play", "ACCEPT render"])
        let recognizer = SpeechCommandRecognizer(commandSource: source)
        var recognized: [String] = []

        await recognizer.refreshAvailability()
        try recognizer.start { phrase in recognized.append(phrase) }
        recognizer.stop()

        XCTAssertEqual(recognized, ["play", "accept render"])
        XCTAssertFalse(recognizer.isListening)
    }

    func testStoreMarksOfflineKeepsSnapshotAndSuppressesCommands() async {
        let client = MockCompanionClient()
        client.snapshotValue = MoshSnapshot(
            tracks: [
                MoshTrack(id: "track-1", index: 0, name: "Vox", clips: [])
            ],
            transport: MoshTransport(playing: false, recording: false, position: 42, looping: false)
        )
        let store = CompanionStore(client: client)

        await store.refresh()
        XCTAssertTrue(store.canSendCommands)

        client.snapshotError = CompanionError.server("Mac companion server unreachable")
        await store.refresh()

        guard case let .offline(message, lastOnline) = store.connectionState else {
            XCTFail("Expected offline connection state")
            return
        }
        XCTAssertEqual(message, "Mac companion server unreachable")
        XCTAssertNotNil(lastOnline)
        XCTAssertEqual(store.snapshot?.transport.position, 42)
        XCTAssertFalse(store.canSendCommands)

        store.setTransport("play")
        XCTAssertTrue(client.commands.isEmpty)
        XCTAssertTrue(store.receipts.first?.contains("MOSH is offline") == true)
    }

    func testForgetPairingClearsSessionState() async {
        let client = MockCompanionClient()
        client.snapshotValue = MoshSnapshot(
            tracks: [
                MoshTrack(id: "track-1", index: 0, name: "Vox", clips: [])
            ],
            transport: MoshTransport(playing: false, recording: false, position: 0, looping: false)
        )
        let store = CompanionStore(client: client)

        await store.refresh()
        XCTAssertNotNil(store.snapshot)

        store.forgetPairing()

        XCTAssertTrue(client.didClearPairing)
        XCTAssertFalse(store.isPaired)
        XCTAssertNil(store.snapshot)
        XCTAssertNil(store.selectedTrackId)
        XCTAssertTrue(store.receipts.isEmpty)
        XCTAssertEqual(store.connectionState, .unpaired)
    }

    func testFixturePhoneTakeSourceUploadsSequencedChunksAndFinishes() async throws {
        let chunks = [
            Data([0x01, 0x00, 0x02, 0x00]),
            Data([0x03, 0x00, 0x04, 0x00])
        ]
        let source = FixturePhoneTakeAudioSource(sampleRate: 48_000, channels: 1, chunks: chunks, levels: [0.25, 0.5])
        let recorder = PhoneTakeRecorder(audioSource: source)
        let client = MockCompanionClient()

        try await recorder.start(client: client, trackId: "track-1", name: "Fixture Take")
        await Task.yield()
        XCTAssertTrue(recorder.isRecording)
        XCTAssertEqual(recorder.level, 0.5, accuracy: 0.001)

        try await recorder.stop(client: client)

        XCTAssertFalse(recorder.isRecording)
        XCTAssertEqual(client.startedTakeRequests.map(\.trackId), ["track-1"])
        XCTAssertEqual(client.startedTakeRequests.map(\.name), ["Fixture Take"])
        XCTAssertEqual(client.startedTakeRequests.map(\.sampleRate), [48_000])
        XCTAssertEqual(client.startedTakeRequests.map(\.channels), [1])
        XCTAssertEqual(client.appendedTakeChunks.map(\.sequence), [0, 1])
        XCTAssertEqual(client.appendedTakeChunks.map(\.pcm16), chunks)
        XCTAssertEqual(client.finishedTakeIds, ["take-1"])
        XCTAssertTrue(source.didStop)
    }

    func testMonitoringMetricsEstimateLatencyAndDetectAcousticOnset() {
        let samples = [
            MonitoringClockSample(macSendMs: 0, macReceiveMs: 12, phoneReceiveMs: 10, phoneSendMs: 12),
            MonitoringClockSample(macSendMs: 20, macReceiveMs: 34, phoneReceiveMs: 30, phoneSendMs: 34)
        ]

        let offset = MonitoringMetrics.estimateClockOffsetMs(samples: samples)
        XCTAssertEqual(offset, 5.0, accuracy: 0.001)

        let playback = MonitoringMetrics.playoutSummary(
            samples: [
                MonitoringPlaybackSample(macSentMs: 100, phoneScheduledPlaybackMs: 145),
                MonitoringPlaybackSample(macSentMs: 200, phoneScheduledPlaybackMs: 246),
                MonitoringPlaybackSample(macSentMs: 300, phoneScheduledPlaybackMs: 350)
            ],
            clockOffsetMs: offset
        )
        XCTAssertEqual(playback.medianMs, 41.0, accuracy: 0.001)
        XCTAssertEqual(playback.p95Ms, 45.0, accuracy: 0.001)
        XCTAssertEqual(playback.jitterMs, 5.0, accuracy: 0.001)

        var pcm = Array(repeating: Float(0), count: 6000)
        pcm[4800] = 0.9
        let onset = MonitoringMetrics.detectAcousticOnsetMs(samples: pcm, sampleRate: 48_000, threshold: 0.4)
        XCTAssertEqual(try XCTUnwrap(onset), 100.0, accuracy: 0.001)
    }

    func testMonitoringRunnerRecordsSyntheticReportForSimulatorGate() async throws {
        let client = MockCompanionClient()
        let runner = MonitoringDiagnosticRunner()
        var impulse = Array(repeating: Float(0), count: 4_800)
        impulse[1_200] = 0.8

        await runner.runSynthetic(
            client: client,
            sessionId: "sim-monitor-1",
            clockSamples: [
                MonitoringClockSample(macSendMs: 0, macReceiveMs: 12, phoneReceiveMs: 10, phoneSendMs: 12),
                MonitoringClockSample(macSendMs: 20, macReceiveMs: 34, phoneReceiveMs: 30, phoneSendMs: 34)
            ],
            playbackSamples: [
                MonitoringPlaybackSample(macSentMs: 100, phoneScheduledPlaybackMs: 145),
                MonitoringPlaybackSample(macSentMs: 200, phoneScheduledPlaybackMs: 246),
                MonitoringPlaybackSample(macSentMs: 300, phoneScheduledPlaybackMs: 350)
            ],
            acousticSamples: impulse,
            acousticSampleRate: 48_000,
            acousticThreshold: 0.4
        )

        let report = try XCTUnwrap(runner.lastReport)
        XCTAssertEqual(report.sessionId, "sim-monitor-1")
        XCTAssertEqual(report.networkMedianMs, 41.0, accuracy: 0.001)
        XCTAssertEqual(report.networkP95Ms, 45.0, accuracy: 0.001)
        XCTAssertEqual(report.networkJitterMs, 5.0, accuracy: 0.001)
        XCTAssertEqual(report.acousticMedianMs, 25.0, accuracy: 0.001)
        XCTAssertEqual(runner.lastReportFile, "/tmp/report.json")
        XCTAssertEqual(client.monitorReports, [report])
    }
}

@MainActor
private final class MockCompanionClient: CompanionClientProtocol {
    struct Command {
        let command: String
        let args: [String: Any]
    }

    struct StartedTakeRequest {
        let trackId: String?
        let name: String
        let sampleRate: Double
        let channels: Int
    }

    struct AppendedTakeChunk {
        let takeId: String
        let sequence: Int
        let pcm16: Data
    }

    var snapshotValue = MoshSnapshot(
        tracks: [],
        transport: MoshTransport(playing: false, recording: false, position: 0, looping: false)
    )
    var snapshotError: Error?
    var commands: [Command] = []
    var paired = true
    var didClearPairing = false
    var startedTakeRequests: [StartedTakeRequest] = []
    var appendedTakeChunks: [AppendedTakeChunk] = []
    var finishedTakeIds: [String] = []
    var canceledTakeIds: [String] = []
    var monitorReports: [MonitoringReportPayload] = []
    var isPaired: Bool { paired }

    func configure(pairing: PairingPayload) {
        paired = true
    }

    func clearPairing() {
        paired = false
        didClearPairing = true
    }

    func snapshot() async throws -> MoshSnapshot {
        if let snapshotError { throw snapshotError }
        return snapshotValue
    }

    func execute(_ command: String, args: [String: Any]) async throws -> CommandResult {
        commands.append(Command(command: command, args: args))
        return CommandResult(ok: true, command: command, error: nil)
    }

    func pollEvents(since: Int) async throws -> EventPoll {
        EventPoll(latestSeq: since)
    }

    func startTake(trackId: String?, name: String, sampleRate: Double, channels: Int) async throws -> StartedTake {
        startedTakeRequests.append(
            StartedTakeRequest(trackId: trackId, name: name, sampleRate: sampleRate, channels: channels)
        )
        return StartedTake(takeId: "take-1")
    }

    func appendTakeChunk(takeId: String, sequence: Int, pcm16: Data) async throws {
        appendedTakeChunks.append(AppendedTakeChunk(takeId: takeId, sequence: sequence, pcm16: pcm16))
    }

    func finishTake(takeId: String) async throws {
        finishedTakeIds.append(takeId)
    }

    func cancelTake(takeId: String) async throws {
        canceledTakeIds.append(takeId)
    }

    func monitorPing(phoneTimeMs: Double) async throws -> MonitoringPingResponse {
        MonitoringPingResponse(macTimeMs: 0, phoneTimeMs: phoneTimeMs)
    }
    func startMonitor(mode: String) async throws -> MonitoringSession {
        MonitoringSession(sessionId: "monitor-1", sampleRate: 48_000, chunkFrames: 2_400)
    }
    func nextMonitorChunk(sessionId: String, sequence: Int) async throws -> MonitoringChunk {
        MonitoringChunk(sequence: sequence, sampleRate: 48_000, pcm16Base64: "", sentAtMacMs: 0)
    }
    func reportMonitor(_ report: MonitoringReportPayload) async throws -> MonitoringReportAck {
        monitorReports.append(report)
        return MonitoringReportAck(reportFile: "/tmp/report.json")
    }
    func stopMonitor(sessionId: String) async throws {}
}

private final class FixturePhoneTakeAudioSource: PhoneTakeAudioSource {
    let sampleRate: Double
    let channels: Int
    let chunks: [Data]
    let levels: [Float]
    private(set) var didStop = false

    init(sampleRate: Double, channels: Int, chunks: [Data], levels: [Float]) {
        self.sampleRate = sampleRate
        self.channels = channels
        self.chunks = chunks
        self.levels = levels
    }

    func prepare() async throws -> PhoneTakeAudioFormat {
        PhoneTakeAudioFormat(sampleRate: sampleRate, channels: channels)
    }

    func start(onChunk: @escaping (Data, Float) -> Void) throws {
        for (index, chunk) in chunks.enumerated() {
            onChunk(chunk, levels.indices.contains(index) ? levels[index] : 0)
        }
    }

    func stop() {
        didStop = true
    }

    func cancel() {
        didStop = true
    }
}

private final class FixtureSpeechCommandSource: SpeechCommandSource {
    let transcripts: [String]
    private(set) var isRunning = false

    init(transcripts: [String]) {
        self.transcripts = transcripts
    }

    func refreshAvailability() async -> Bool {
        true
    }

    func start(onCommand: @escaping (String) -> Void) throws {
        isRunning = true
        transcripts.forEach { onCommand($0.lowercased()) }
    }

    func stop() {
        isRunning = false
    }
}
