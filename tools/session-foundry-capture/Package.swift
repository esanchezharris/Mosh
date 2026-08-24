// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MoshSessionCapture",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "SessionCaptureCore", targets: ["SessionCaptureCore"]),
        .executable(name: "MoshSessionCapture", targets: ["MoshSessionCapture"]),
    ],
    targets: [
        .target(name: "SessionCaptureCore"),
        .executableTarget(name: "MoshSessionCapture", dependencies: ["SessionCaptureCore"]),
        .testTarget(name: "SessionCaptureCoreTests", dependencies: ["SessionCaptureCore"]),
    ],
    swiftLanguageModes: [.v5]
)
