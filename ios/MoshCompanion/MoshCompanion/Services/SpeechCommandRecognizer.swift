import AVFoundation
import Foundation
import Speech

@MainActor
protocol SpeechCommandSource: AnyObject {
    func refreshAvailability() async -> Bool
    func requestAuthorization() async -> Bool
    func start(onCommand: @escaping (String) -> Void) throws
    func stop()
}

@MainActor
final class SpeechCommandRecognizer: ObservableObject {
    @Published private(set) var isListening = false
    @Published private(set) var isAvailable = false

    private let commandSource: SpeechCommandSource

    init(commandSource: SpeechCommandSource = AppleSpeechCommandSource()) {
        self.commandSource = commandSource
    }

    func refreshAvailability() async {
        isAvailable = await commandSource.refreshAvailability()
    }

    func start(onCommand: @escaping (String) -> Void) async throws {
        guard isAvailable else { throw CompanionError.speechUnavailable }
        guard await commandSource.requestAuthorization() else {
            throw CompanionError.speechUnavailable
        }
        stop()
        try commandSource.start { phrase in
            onCommand(phrase.lowercased())
        }
        isListening = true
    }

    func stop() {
        commandSource.stop()
        isListening = false
    }
}

@MainActor
private final class AppleSpeechCommandSource: SpeechCommandSource {
    private let recognizer = SFSpeechRecognizer()
    private let engine = AVAudioEngine()
    private let microphonePermission = AppleAudioRecordingPermissionAuthorizer()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func refreshAvailability() async -> Bool {
        guard recognizer?.supportsOnDeviceRecognition ?? false else { return false }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized, .notDetermined:
            return true
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }

    func requestAuthorization() async -> Bool {
        let current = SFSpeechRecognizer.authorizationStatus()
        let speechAuthorization = current == .notDetermined
            ? await Self.requestSpeechAuthorization()
            : current
        guard speechAuthorization == .authorized else { return false }
        return await microphonePermission.requestPermission()
    }

    nonisolated private static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    func start(onCommand: @escaping (String) -> Void) throws {
        stop()

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .spokenAudio, options: [.duckOthers])
        try session.setActive(true)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }

        task = recognizer?.recognitionTask(with: request) { result, _ in
            guard let result, result.isFinal else { return }
            onCommand(result.bestTranscription.formattedString.lowercased())
        }

        engine.prepare()
        try engine.start()
    }

    func stop() {
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
    }
}
