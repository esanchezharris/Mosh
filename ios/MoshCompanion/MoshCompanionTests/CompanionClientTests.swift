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
}

@MainActor
private final class MockCompanionClient: CompanionClientProtocol {
    struct Command {
        let command: String
        let args: [String: Any]
    }

    var snapshotValue = MoshSnapshot(
        tracks: [],
        transport: MoshTransport(playing: false, recording: false, position: 0, looping: false)
    )
    var snapshotError: Error?
    var commands: [Command] = []
    var paired = true
    var didClearPairing = false
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
        StartedTake(takeId: "take-1")
    }

    func appendTakeChunk(takeId: String, sequence: Int, pcm16: Data) async throws {}
    func finishTake(takeId: String) async throws {}
    func cancelTake(takeId: String) async throws {}
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
        MonitoringReportAck(reportFile: "/tmp/report.json")
    }
    func stopMonitor(sessionId: String) async throws {}
}
