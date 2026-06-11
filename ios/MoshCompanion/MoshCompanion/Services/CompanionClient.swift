import Foundation

@MainActor
protocol CompanionClientProtocol: AnyObject {
    var isPaired: Bool { get }

    func configure(pairing: PairingPayload)
    func snapshot() async throws -> MoshSnapshot
    func execute(_ command: String, args: [String: Any]) async throws -> CommandResult
    func pollEvents(since: Int) async throws -> EventPoll
    func startTake(trackId: String?, name: String, sampleRate: Double, channels: Int) async throws -> StartedTake
    func appendTakeChunk(takeId: String, sequence: Int, pcm16: Data) async throws
    func finishTake(takeId: String) async throws
    func cancelTake(takeId: String) async throws
    func monitorPing(phoneTimeMs: Double) async throws -> MonitoringPingResponse
    func startMonitor(mode: String) async throws -> MonitoringSession
    func nextMonitorChunk(sessionId: String, sequence: Int) async throws -> MonitoringChunk
    func reportMonitor(_ report: MonitoringReportPayload) async throws -> MonitoringReportAck
    func stopMonitor(sessionId: String) async throws
}

@MainActor
final class CompanionClient: CompanionClientProtocol {
    private(set) var pairing: PairingPayload?
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
        self.pairing = KeychainPairingStore.load()
    }

    var isPaired: Bool { pairing != nil }

    func configure(pairing: PairingPayload) {
        self.pairing = pairing
        KeychainPairingStore.save(pairing)
    }

    static func parsePairingURL(_ raw: String) throws -> PairingPayload {
        guard
            let components = URLComponents(string: raw),
            components.scheme == "mosh",
            let payload = components.queryItems?.first(where: { $0.name == "payload" })?.value,
            let data = Data(base64Encoded: payload)
        else {
            throw CompanionError.invalidPairingURL
        }
        return try JSONDecoder().decode(PairingPayload.self, from: data)
    }

    func snapshot() async throws -> MoshSnapshot {
        try await post("/snapshot", body: [:], as: MoshSnapshot.self)
    }

    func execute(_ command: String, args: [String: Any] = [:]) async throws -> CommandResult {
        try await post("/command", body: ["command": ["command": command, "args": args]], as: CommandResult.self)
    }

    func pollEvents(since: Int) async throws -> EventPoll {
        try await post("/events", body: ["since": since], as: EventPoll.self)
    }

    func startTake(trackId: String?, name: String, sampleRate: Double, channels: Int) async throws -> StartedTake {
        var body: [String: Any] = ["name": name, "sampleRate": sampleRate, "channels": channels]
        if let trackId, !trackId.isEmpty { body["trackId"] = trackId }
        return try await post("/take/start", body: body, as: StartedTake.self)
    }

    func appendTakeChunk(takeId: String, sequence: Int, pcm16: Data) async throws {
        _ = try await post("/take/chunk", body: [
            "takeId": takeId,
            "sequence": sequence,
            "pcm16Base64": pcm16.base64EncodedString()
        ], as: EmptyRemoteData.self)
    }

    func finishTake(takeId: String) async throws {
        _ = try await post("/take/finish", body: ["takeId": takeId], as: EmptyRemoteData.self)
    }

    func cancelTake(takeId: String) async throws {
        _ = try await post("/take/cancel", body: ["takeId": takeId], as: EmptyRemoteData.self)
    }

    func monitorPing(phoneTimeMs: Double) async throws -> MonitoringPingResponse {
        try await post("/monitor/ping", body: ["phoneTimeMs": phoneTimeMs], as: MonitoringPingResponse.self)
    }

    func startMonitor(mode: String) async throws -> MonitoringSession {
        try await post("/monitor/start", body: ["mode": mode], as: MonitoringSession.self)
    }

    func nextMonitorChunk(sessionId: String, sequence: Int) async throws -> MonitoringChunk {
        try await post("/monitor/chunk", body: ["sessionId": sessionId, "sequence": sequence], as: MonitoringChunk.self)
    }

    func reportMonitor(_ report: MonitoringReportPayload) async throws -> MonitoringReportAck {
        try await post("/monitor/report", body: report.dictionary, as: MonitoringReportAck.self)
    }

    func stopMonitor(sessionId: String) async throws {
        _ = try await post("/monitor/stop", body: ["sessionId": sessionId], as: EmptyRemoteData.self)
    }

    private func post<T: Decodable>(_ path: String, body: [String: Any], as type: T.Type) async throws -> T {
        guard let pairing, let baseURL = pairing.baseURL else { throw CompanionError.notPaired }
        var payload = body
        payload["token"] = pairing.token

        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, _) = try await session.data(for: request)
        let envelope = try JSONDecoder().decode(RemoteEnvelope<T>.self, from: data)
        guard envelope.ok else { throw CompanionError.server(envelope.error ?? "MOSH remote request failed.") }
        guard let decoded = envelope.data else {
            if T.self == EmptyRemoteData.self { return EmptyRemoteData() as! T }
            throw CompanionError.missingResponse
        }
        return decoded
    }
}
