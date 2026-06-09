import Foundation

struct PairingPayload: Codable, Equatable {
    let host: String
    let port: Int
    let token: String

    var baseURL: URL? {
        URL(string: "http://\(host):\(port)")
    }
}

struct RemoteEnvelope<T: Decodable>: Decodable {
    let ok: Bool
    let data: T?
    let error: String?
}

struct EmptyRemoteData: Decodable {}

struct RemotePairingInfo: Decodable, Equatable {
    let host: String
    let port: Int
    let token: String
    let expiresAtMs: Double
    let pairingUrl: String
}

struct RemoteStatus: Decodable, Equatable {
    let running: Bool
    let port: Int
    let pairing: RemotePairingInfo?
}

struct MoshSnapshot: Decodable, Equatable {
    var tracks: [MoshTrack]
    var transport: MoshTransport

    var renderTargets: [RenderTarget] {
        tracks.flatMap { track in
            track.clips.compactMap { clip in
                guard let layer = clip.renderLayer, layer.hasArtifact else { return nil }
                let trackName = track.name.isEmpty ? "Track \(track.index + 1)" : track.name
                let clipName = clip.name.isEmpty ? "Clip" : clip.name
                return RenderTarget(
                    clipId: clip.id,
                    layerId: layer.id,
                    title: "\(trackName) · \(clipName)",
                    status: layer.status,
                    adapter: layer.adapter
                )
            }
        }
    }
}

struct MoshTrack: Decodable, Identifiable, Equatable {
    let id: String
    let index: Int
    let name: String
    let clips: [MoshClip]

    init(id: String, index: Int, name: String, clips: [MoshClip] = []) {
        self.id = id
        self.index = index
        self.name = name
        self.clips = clips
    }
}

struct MoshClip: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let type: String
    let start: Double
    let length: Double
    let hasRenderLayer: Bool
    let renderLayer: MoshRenderLayer?

    init(id: String,
         name: String,
         type: String,
         start: Double,
         length: Double,
         hasRenderLayer: Bool,
         renderLayer: MoshRenderLayer?) {
        self.id = id
        self.name = name
        self.type = type
        self.start = start
        self.length = length
        self.hasRenderLayer = hasRenderLayer
        self.renderLayer = renderLayer
    }
}

struct MoshRenderLayer: Decodable, Equatable {
    let id: String
    let status: String
    let adapter: String
    let mode: String
    let seed: Int
    let userKept: Bool
    let hasArtifact: Bool
}

struct RenderTarget: Identifiable, Equatable {
    let clipId: String
    let layerId: String
    let title: String
    let status: String
    let adapter: String

    var id: String { clipId }
}

struct MoshTransport: Decodable, Equatable {
    let playing: Bool
    let recording: Bool
    let position: Double
    let looping: Bool
}

struct CommandResult: Decodable, Equatable {
    let ok: Bool
    let command: String?
    let error: String?
}

struct StartedTake: Decodable, Equatable {
    let takeId: String
}

struct EventPoll: Decodable {
    let latestSeq: Int
}

enum RenderDecision {
    case accept
    case reject

    var command: String {
        switch self {
        case .accept: return "accept_render"
        case .reject: return "reject_render"
        }
    }

    var receiptVerb: String {
        switch self {
        case .accept: return "Accepted"
        case .reject: return "Rejected"
        }
    }
}

struct MonitoringPingResponse: Decodable, Equatable {
    let macTimeMs: Double
    let phoneTimeMs: Double
}

struct MonitoringSession: Decodable, Equatable {
    let sessionId: String
    let sampleRate: Int
    let chunkFrames: Int
}

struct MonitoringChunk: Decodable, Equatable {
    let sequence: Int
    let sampleRate: Int
    let pcm16Base64: String
    let sentAtMacMs: Double
}

struct MonitoringReportPayload: Encodable, Equatable {
    let sessionId: String
    let networkMedianMs: Double
    let networkP95Ms: Double
    let networkJitterMs: Double
    let acousticMedianMs: Double
    let acousticP95Ms: Double
    let acousticJitterMs: Double

    var dictionary: [String: Any] {
        [
            "sessionId": sessionId,
            "networkMedianMs": networkMedianMs,
            "networkP95Ms": networkP95Ms,
            "networkJitterMs": networkJitterMs,
            "acousticMedianMs": acousticMedianMs,
            "acousticP95Ms": acousticP95Ms,
            "acousticJitterMs": acousticJitterMs
        ]
    }
}

struct MonitoringReportAck: Decodable, Equatable {
    let reportFile: String
}

struct MonitoringClockSample: Equatable {
    let macSendMs: Double
    let macReceiveMs: Double
    let phoneReceiveMs: Double
    let phoneSendMs: Double
}

struct MonitoringPlaybackSample: Equatable {
    let macSentMs: Double
    let phoneScheduledPlaybackMs: Double
}

struct MonitoringSummary: Equatable {
    let medianMs: Double
    let p95Ms: Double
    let jitterMs: Double
}

enum CompanionError: LocalizedError, Equatable {
    case invalidPairingURL
    case notPaired
    case server(String)
    case missingResponse
    case speechUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidPairingURL: return "Invalid MOSH pairing URL."
        case .notPaired: return "Pair the iPhone with MOSH first."
        case .server(let message): return message
        case .missingResponse: return "MOSH did not return a usable response."
        case .speechUnavailable: return "On-device speech recognition is unavailable."
        }
    }
}
