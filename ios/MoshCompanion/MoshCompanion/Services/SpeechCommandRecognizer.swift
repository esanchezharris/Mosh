import AVFoundation
import Foundation
import Speech

@MainActor
final class SpeechCommandRecognizer: ObservableObject {
    @Published private(set) var isListening = false
    @Published private(set) var isAvailable = false

    private let recognizer = SFSpeechRecognizer()
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func refreshAvailability() async {
        let auth = await Self.requestAuthorizationStatus()
        isAvailable = auth == .authorized && (recognizer?.supportsOnDeviceRecognition ?? false)
    }

    nonisolated private static func requestAuthorizationStatus() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    func start(onCommand: @escaping (String) -> Void) throws {
        guard isAvailable else { throw CompanionError.speechUnavailable }
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
        isListening = true
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
        isListening = false
    }
}
