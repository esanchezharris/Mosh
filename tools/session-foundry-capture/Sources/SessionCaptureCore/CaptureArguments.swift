import Foundation

public struct CaptureArguments: Sendable, Equatable {
    public let sessionID: String
    public let sessionDirectory: URL
    public let goal: String
    public let abletonSet: URL
    public let maximumDuration: TimeInterval
    public let chunkDuration: TimeInterval

    public static func parse(_ arguments: [String]) throws -> CaptureArguments {
        guard arguments.first == "capture" else {
            throw CaptureArgumentError.invalidCommand(arguments.first ?? "")
        }
        let flags = try parseFlags(Array(arguments.dropFirst()))
        let known = Set(["--session-id", "--session-directory", "--goal", "--set", "--max-minutes", "--chunk-minutes"])
        if let unknown = flags.keys.first(where: { !known.contains($0) }) {
            throw CaptureArgumentError.unknownFlag(unknown)
        }

        let sessionID = try required("--session-id", in: flags)
        let directory = try absoluteFileURL(try required("--session-directory", in: flags), flag: "--session-directory")
        let goal = try required("--goal", in: flags)
        let setURL = try absoluteFileURL(try required("--set", in: flags), flag: "--set")
        guard setURL.pathExtension.lowercased() == "als" else {
            throw CaptureArgumentError.invalidValue("--set must name an .als file")
        }
        let maxMinutes = try boundedMinutes(try required("--max-minutes", in: flags), flag: "--max-minutes", maximum: 120)
        let chunkMinutes = try boundedMinutes(try required("--chunk-minutes", in: flags), flag: "--chunk-minutes", maximum: 15)

        return CaptureArguments(
            sessionID: sessionID,
            sessionDirectory: directory,
            goal: goal,
            abletonSet: setURL,
            maximumDuration: TimeInterval(maxMinutes * 60),
            chunkDuration: TimeInterval(chunkMinutes * 60)
        )
    }
}

public enum CaptureArgumentError: Error, Equatable, CustomStringConvertible {
    case invalidCommand(String)
    case invalidSequence(String)
    case duplicateFlag(String)
    case unknownFlag(String)
    case missingFlag(String)
    case invalidValue(String)

    public var description: String {
        switch self {
        case let .invalidCommand(command): "unknown command: \(command)"
        case let .invalidSequence(flag): "invalid flag sequence near \(flag)"
        case let .duplicateFlag(flag): "duplicate flag: \(flag)"
        case let .unknownFlag(flag): "unknown flag: \(flag)"
        case let .missingFlag(flag): "missing \(flag)"
        case let .invalidValue(message): message
        }
    }
}

private func parseFlags(_ arguments: [String]) throws -> [String: String] {
    var result: [String: String] = [:]
    var index = 0
    while index < arguments.count {
        let flag = arguments[index]
        guard flag.hasPrefix("--"), index + 1 < arguments.count else {
            throw CaptureArgumentError.invalidSequence(flag)
        }
        let value = arguments[index + 1]
        guard !value.hasPrefix("--") else {
            throw CaptureArgumentError.invalidSequence(flag)
        }
        guard result[flag] == nil else {
            throw CaptureArgumentError.duplicateFlag(flag)
        }
        result[flag] = value
        index += 2
    }
    return result
}

private func required(_ flag: String, in flags: [String: String]) throws -> String {
    guard let value = flags[flag], !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw CaptureArgumentError.missingFlag(flag)
    }
    return value
}

private func absoluteFileURL(_ value: String, flag: String) throws -> URL {
    guard value.hasPrefix("/") else {
        throw CaptureArgumentError.invalidValue("\(flag) must be an absolute path")
    }
    return URL(fileURLWithPath: value)
}

private func boundedMinutes(_ value: String, flag: String, maximum: Int) throws -> Int {
    guard let result = Int(value), (1...maximum).contains(result) else {
        throw CaptureArgumentError.invalidValue("\(flag) must be between 1 and \(maximum)")
    }
    return result
}
