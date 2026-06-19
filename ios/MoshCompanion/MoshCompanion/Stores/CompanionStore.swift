import Foundation

@MainActor
final class CompanionStore: ObservableObject {
    @Published var pairingText = ""
    @Published private(set) var snapshot: MoshSnapshot?
    @Published private(set) var receipts: [String] = []
    @Published private(set) var errorText: String?
    @Published var selectedTrackId: String?
    @Published var selectedRenderClipId: String?

    let browser = BonjourBrowser()
    let recorder = PhoneTakeRecorder()
    let speech = SpeechCommandRecognizer()
    let monitoring = MonitoringDiagnosticRunner()

    private let client: CompanionClientProtocol
    private var eventSeq = 0

    init(client: CompanionClientProtocol = CompanionClient()) {
        self.client = client
    }

    var isPaired: Bool { client.isPaired }
    var transport: MoshTransport? { snapshot?.transport }
    var tracks: [MoshTrack] { snapshot?.tracks ?? [] }
    var renderTargets: [RenderTarget] { snapshot?.renderTargets ?? [] }

    func start() {
        browser.start()
        Task { await speech.refreshAvailability() }
    }

    func pairFromText() {
        pair(from: pairingText)
    }

    func pair(from raw: String) {
        do {
            let payload = try CompanionClient.parsePairingURL(raw)
            client.configure(pairing: payload)
            receipts.insert("Paired with \(payload.host)", at: 0)
            Task { await refresh() }
        } catch {
            errorText = error.localizedDescription
        }
    }

    func refresh() async {
        do {
            snapshot = try await client.snapshot()
            if selectedTrackId == nil { selectedTrackId = snapshot?.tracks.first?.id }
            reconcileRenderTargetSelection()
            let poll = try? await client.pollEvents(since: eventSeq)
            if let poll { eventSeq = poll.latestSeq }
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
    }

    func setTransport(_ action: String) {
        Task {
            do {
                let result = try await client.execute("set_transport", args: ["action": action])
                receipts.insert(result.ok ? "Transport \(action)" : (result.error ?? "Transport failed"), at: 0)
                await refresh()
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    func runVoiceCommand(_ phrase: String) async {
        let command: (String, [String: Any])?
        if phrase.contains("play") { command = ("set_transport", ["action": "play"]) }
        else if phrase.contains("stop") { command = ("set_transport", ["action": "stop"]) }
        else if phrase.contains("accept") {
            await runRenderDecision(.accept)
            return
        }
        else if phrase.contains("reject") {
            await runRenderDecision(.reject)
            return
        }
        else { command = nil }

        guard let command else {
            receipts.insert("Unmapped: \(phrase)", at: 0)
            return
        }

        do {
            _ = try await client.execute(command.0, args: command.1)
            receipts.insert("Voice: \(phrase)", at: 0)
            await refresh()
        } catch {
            errorText = error.localizedDescription
        }
    }

    func runRecognizedCommand(_ phrase: String) {
        Task { await runVoiceCommand(phrase) }
    }

    func runRenderDecision(_ decision: RenderDecision) async {
        guard let clipId = selectedRenderClipId else {
            receipts.insert("\(decision.receiptVerb) render needs a rendered clip.", at: 0)
            return
        }

        do {
            let result = try await client.execute(decision.command, args: ["clipId": clipId])
            receipts.insert(result.ok ? "\(decision.receiptVerb) render" : (result.error ?? "\(decision.command) failed"), at: 0)
            await refresh()
        } catch {
            errorText = error.localizedDescription
        }
    }

    func startHoldToTalk() {
        do {
            try speech.start { [weak self] phrase in
                Task { @MainActor in self?.runRecognizedCommand(phrase) }
            }
        } catch {
            errorText = error.localizedDescription
        }
    }

    func stopHoldToTalk() {
        speech.stop()
    }

    func toggleTake() {
        Task {
            do {
                if recorder.isRecording {
                    try await recorder.stop(client: client)
                    receipts.insert("Phone take imported", at: 0)
                    await refresh()
                } else {
                    try await recorder.start(client: client, trackId: selectedTrackId, name: "Phone Take")
                    receipts.insert("Phone take recording", at: 0)
                }
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    func runMonitoringDiagnostics() {
        Task { await monitoring.run(client: client) }
    }

    private func reconcileRenderTargetSelection() {
        let targets = renderTargets
        if let selectedRenderClipId, targets.contains(where: { $0.clipId == selectedRenderClipId }) {
            return
        }
        selectedRenderClipId = targets.first?.clipId
    }
}
