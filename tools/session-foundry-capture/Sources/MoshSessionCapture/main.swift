import Foundation
import SessionCaptureCore

do {
    _ = try CaptureArguments.parse(Array(CommandLine.arguments.dropFirst()))
    fputs("capture engine not yet initialized\n", stderr)
    exit(2)
} catch {
    fputs("MoshSessionCapture: \(error)\n", stderr)
    exit(64)
}
