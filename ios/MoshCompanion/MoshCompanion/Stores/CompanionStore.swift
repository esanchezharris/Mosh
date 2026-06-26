import Foundation

@MainActor
final class CompanionStore: ObservableObject {
    @Published var pairingText = ""
    @Published private(set) var snapshot: MoshSnapshot?
    @Published private(set) var receipts: [String] = []
    @Published private(set) var errorText: String?
    @Published private(set) var connectionState: CompanionConnectionState
    @Published private(set) var paired: Bool
    @Published var selectedTrackId: String?
    @Published var selectedRenderClipId: String?

    let browser = BonjourBrowser()
    let recorder = PhoneTakeRecorder()
    let speech = SpeechCommandRecognizer()
    let monitoring = MonitoringDiagnosticRunner()

    private let client: CompanionClientProtocol
    private var eventSeq = 0
    private var lastOnlineAt: Date?

    init(client: CompanionClientProtocol = CompanionClient()) {
        self.client = client
        self.paired = client.isPaired
        self.connectionState = client.isPaired ? .connecting : .unpaired
    }

    var isPaired: Bool { paired }
    var canSendCommands: Bool {
        guard paired else { return false }
        if case .online = connectionState { return true }
        return false
    }
    var transport: MoshTransport? { snapshot?.transport }
    var tracks: [MoshTrack] { snapshot?.tracks ?? [] }
    var renderTargets: [RenderTarget] { snapshot?.renderTargets ?? [] }
    var controller: MoshControllerState { snapshot?.controller ?? MoshControllerState.derived(from: snapshot) }
    var controllerMode: ControllerMode { controller.displayMode }

    func start() {
        browser.start()
        Task { await speech.refreshAvailability() }
        if paired {
            connectionState = .connecting
        }
    }

    func pairFromText() {
        pair(from: pairingText)
    }

    func pair(from raw: String) {
        do {
            let payload = try CompanionClient.parsePairingURL(raw)
            client.configure(pairing: payload)
            paired = true
            connectionState = .connecting
            receipts.insert("Paired with \(payload.host)", at: 0)
            Task { await refresh() }
        } catch {
            errorText = error.localizedDescription
        }
    }

    func refresh() async {
        guard paired else {
            connectionState = .unpaired
            return
        }

        if snapshot == nil {
            connectionState = .connecting
        }

        do {
            snapshot = try await client.snapshot()
            if selectedTrackId == nil { selectedTrackId = snapshot?.tracks.first?.id }
            reconcileRenderTargetSelection()
            let poll = try? await client.pollEvents(since: eventSeq)
            if let poll { eventSeq = poll.latestSeq }
            errorText = nil
            let now = Date()
            lastOnlineAt = now
            connectionState = .online(lastUpdated: now)
        } catch {
            markOffline(error.localizedDescription)
        }
    }

    func setTransport(_ action: String) {
        guard ensureOnlineForCommand() else { return }

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

    func runControllerEvent(_ event: ControllerEvent, scrubPosition: Double? = nil) async {
        guard ensureOnlineForCommand() else { return }
        guard let command = controllerCommand(for: event, scrubPosition: scrubPosition) else { return }

        do {
            let result = try await client.execute(command.name, args: command.args)
            receipts.insert(result.ok ? receipt(for: event) : (result.error ?? "\(event.rawValue) failed"), at: 0)
            await refresh()
        } catch {
            errorText = error.localizedDescription
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

        guard ensureOnlineForCommand() else { return }

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
        guard ensureOnlineForCommand() else { return }

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
                    guard ensureOnlineForCommand() else { return }
                    try await recorder.start(client: client, trackId: selectedTrackId, name: "Phone Take")
                    receipts.insert("Phone take recording", at: 0)
                }
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    func runMonitoringDiagnostics() {
        guard ensureOnlineForCommand() else { return }
        Task { await monitoring.run(client: client) }
    }

    func forgetPairing() {
        if recorder.isRecording {
            Task { await recorder.cancel(client: client) }
        }

        client.clearPairing()
        paired = false
        pairingText = ""
        snapshot = nil
        receipts.removeAll()
        errorText = nil
        selectedTrackId = nil
        selectedRenderClipId = nil
        eventSeq = 0
        lastOnlineAt = nil
        connectionState = .unpaired
        browser.start()
    }

    private func reconcileRenderTargetSelection() {
        let targets = renderTargets
        if let selectedRenderClipId, targets.contains(where: { $0.clipId == selectedRenderClipId }) {
            return
        }
        selectedRenderClipId = targets.first?.clipId
    }

    private func markOffline(_ message: String) {
        errorText = message
        connectionState = .offline(message: message, lastOnline: lastOnlineAt)
    }

    private func controllerCommand(for event: ControllerEvent, scrubPosition: Double?) -> (name: String, args: [String: Any])? {
        var args: [String: Any] = [
            "source": "phone_controller",
            "controllerEvent": event.rawValue,
            "issuedAtPhoneMs": Date().timeIntervalSince1970 * 1000.0
        ]

        if let clipId = controller.take?.clipId {
            args["clipId"] = clipId
        }

        switch event {
        case .transportToggle:
            args["action"] = "toggle"
            return ("set_transport", args)
        case .transportScrub:
            args["position"] = scrubPosition ?? transport?.position ?? 0
            return ("set_transport", args)
        case .takeListen:
            guard controller.take?.exists == true else {
                receipts.insert("LISTEN needs a recorded take.", at: 0)
                return nil
            }
            args["action"] = "play"
            args["position"] = controller.take?.start ?? transport?.position ?? 0
            return ("set_transport", args)
        case .takeKeep:
            guard controller.take?.exists == true, controller.take?.clipId != nil, controller.take?.canKeep == true else {
                receipts.insert("KEEP needs an active take lane.", at: 0)
                return nil
            }
            args["controllerLabel"] = "kept"
            return ("keep_take", args)
        case .takeRedo:
            args["controllerLabel"] = "undone"
            return ("undo", args)
        case .takeMark:
            args["controllerLabel"] = "flagged"
            args["position"] = transport?.position ?? 0
            return ("mark_take", args)
        }
    }

    private func receipt(for event: ControllerEvent) -> String {
        switch event {
        case .transportToggle:
            return transport?.playing == true ? "Transport stopped" : "Transport started"
        case .transportScrub:
            return "Scrubbed"
        case .takeListen:
            return "Listening"
        case .takeKeep:
            return "Kept take"
        case .takeRedo:
            return "Redo take"
        case .takeMark:
            return "Marked take"
        }
    }

    private func ensureOnlineForCommand() -> Bool {
        guard canSendCommands else {
            let message = "MOSH is offline. Tap Refresh before sending commands."
            errorText = message
            receipts.insert(message, at: 0)
            return false
        }
        return true
    }
}
