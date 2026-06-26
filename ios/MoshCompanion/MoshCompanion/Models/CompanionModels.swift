import Foundation

struct PairingPayload: Codable, Equatable {
    let host: String
    let port: Int
    let token: String

    var baseURL: URL? {
        URL(string: "http://\(host):\(port)")
    }

    var companionDeepLinkURL: URL? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        var components = URLComponents()
        components.scheme = "mosh"
        components.host = "pair"
        components.queryItems = [
            URLQueryItem(name: "payload", value: data.base64EncodedString())
        ]
        return components.url
    }
}

struct RemoteEnvelope<T: Decodable>: Decodable {
    let ok: Bool
    let data: T?
    let error: String?
}

struct EmptyRemoteData: Decodable {}

enum CompanionConnectionState: Equatable {
    case unpaired
    case connecting
    case online(lastUpdated: Date)
    case offline(message: String, lastOnline: Date?)
}

struct MoshSnapshot: Decodable, Equatable {
    var tracks: [MoshTrack]
    var transport: MoshTransport
    var controller: MoshControllerState?

    var renderTargets: [RenderTarget] {
        tracks.flatMap { track in
            track.clips.compactMap { clip in
                guard let layer = clip.renderLayer, layer.hasArtifact else { return nil }
                let trackName = track.name.isEmpty ? "Track \(track.index + 1)" : track.name
                let clipName = clip.name.isEmpty ? "Clip" : clip.name
                return RenderTarget(
                    clipId: clip.id,
                    layerId: layer.id,
                    title: "\(trackName) · \(clipName)"
                )
            }
        }
    }
}

enum ControllerEvent: String, CaseIterable, Equatable {
    case transportToggle = "TRANSPORT_TOGGLE"
    case transportScrub = "TRANSPORT_SCRUB"
    case takeListen = "TAKE_LISTEN"
    case takeKeep = "TAKE_KEEP"
    case takeRedo = "TAKE_REDO"
    case takeMark = "TAKE_MARK"
}

enum ControllerMode: String, Equatable {
    case capture
    case judgment
}

struct MoshControllerState: Decodable, Equatable {
    var mode: String
    var record: String
    var take: MoshControllerTake?
    var agent: String

    var displayMode: ControllerMode {
        mode == "capture" ? .capture : .judgment
    }

    static func derived(from snapshot: MoshSnapshot?) -> MoshControllerState {
        let transport = snapshot?.transport
        var latestTrack: MoshTrack?
        var latestClip: MoshClip?
        var latestEnd = -Double.greatestFiniteMagnitude

        for track in snapshot?.tracks ?? [] {
            for clip in track.clips where clip.type == "wave" {
                let end = clip.start + clip.length
                if latestClip == nil || end >= latestEnd {
                    latestTrack = track
                    latestClip = clip
                    latestEnd = end
                }
            }
        }

        var take = MoshControllerTake.empty
        if let latestTrack, let latestClip {
            let numTakes = latestClip.numTakes ?? 0
            take = MoshControllerTake(
                exists: true,
                clipId: latestClip.id,
                trackId: latestTrack.id,
                name: latestClip.name,
                start: latestClip.start,
                length: latestClip.length,
                hasLanes: numTakes > 0,
                canKeep: numTakes > 0,
                kept: numTakes == 0,
                numTakes: latestClip.numTakes,
                currentTakeIndex: latestClip.currentTakeIndex
            )
        }

        return MoshControllerState(
            mode: transport?.recording == true ? "capture" : "judgment",
            record: transport?.recording == true ? "recording" : "idle",
            take: take,
            agent: "idle"
        )
    }
}

struct MoshControllerTake: Decodable, Equatable {
    var exists: Bool
    var clipId: String?
    var trackId: String?
    var name: String?
    var start: Double?
    var length: Double?
    var hasLanes: Bool?
    var canKeep: Bool?
    var kept: Bool?
    var numTakes: Int?
    var currentTakeIndex: Int?

    static let empty = MoshControllerTake(
        exists: false,
        clipId: nil,
        trackId: nil,
        name: nil,
        start: nil,
        length: nil,
        hasLanes: nil,
        canKeep: nil,
        kept: nil,
        numTakes: nil,
        currentTakeIndex: nil
    )
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
    let numTakes: Int?
    let currentTakeIndex: Int?

    init(id: String,
         name: String,
         type: String,
         start: Double,
         length: Double,
         hasRenderLayer: Bool,
         renderLayer: MoshRenderLayer?,
         numTakes: Int? = nil,
         currentTakeIndex: Int? = nil) {
        self.id = id
        self.name = name
        self.type = type
        self.start = start
        self.length = length
        self.hasRenderLayer = hasRenderLayer
        self.renderLayer = renderLayer
        self.numTakes = numTakes
        self.currentTakeIndex = currentTakeIndex
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

    var id: String { clipId }
}

struct MoshTransport: Decodable, Equatable {
    let playing: Bool
    let recording: Bool
    let position: Double
    let looping: Bool
    let loopStart: Double?
    let loopEnd: Double?

    init(playing: Bool,
         recording: Bool,
         position: Double,
         looping: Bool,
         loopStart: Double? = nil,
         loopEnd: Double? = nil) {
        self.playing = playing
        self.recording = recording
        self.position = position
        self.looping = looping
        self.loopStart = loopStart
        self.loopEnd = loopEnd
    }
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
