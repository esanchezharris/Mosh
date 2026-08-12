import SwiftUI

struct ControllerView: View {
    @EnvironmentObject private var store: CompanionStore
    @State private var scrubPosition = 0.0
    @State private var isScrubbing = false
    @State private var showingDiagnostics = false

    var body: some View {
        controllerSurface
            .task { await store.refresh() }
            .onAppear { scrubPosition = store.transport?.position ?? 0 }
            .onChange(of: store.transport?.position ?? 0) { _, newValue in
                if !isScrubbing { scrubPosition = newValue }
            }
            #if DEBUG
            .sheet(isPresented: $showingDiagnostics) {
                DiagnosticsView()
            }
            #endif
    }

    private var controllerSurface: some View {
        ZStack {
            ControllerPalette.page.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 12) {
                chrome
                header
                recordingPad
                scrubNavigator

                Spacer(minLength: 0)
                footer
            }
            .padding(.horizontal, 18)
            .safeAreaPadding(.top, 10)
            .safeAreaPadding(.bottom, 12)
        }
    }

    private var chrome: some View {
        HStack {
            Button {
                store.forgetPairing()
            } label: {
                Image(systemName: "xmark.circle")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Forget pairing")

            Spacer()

            #if DEBUG
            Button {
                showingDiagnostics = true
            } label: {
                Image(systemName: "speedometer")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Diagnostics")
            #endif
        }
        .font(.system(size: 19, weight: .bold))
        .foregroundStyle(ControllerPalette.ink.opacity(0.82))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(sessionTitle)
                    .font(.system(size: 30, weight: .black, design: .rounded))
                    .foregroundStyle(ControllerPalette.lime)
                Spacer()
                Text(positionText)
                    .font(.system(.title3, design: .monospaced).weight(.semibold))
                    .foregroundStyle(ControllerPalette.bone)
            }

            statusStrip
        }
        .padding(16)
        .background(ControllerPalette.panel, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(ControllerPalette.ink.opacity(0.22), lineWidth: 1)
        )
    }

    private var statusStrip: some View {
        HStack(spacing: 10) {
            statusPill(connectionTitle, systemImage: connectionIcon, color: connectionColor)
            if store.paired {
                statusPill(qualityText, systemImage: qualityIcon, color: qualityColor)
                    .accessibilityIdentifier("controller.connectionQuality")
                    .accessibilityLabel("Connection quality: \(qualityAccessibilityLabel)")
            }
            statusPill(store.controller.agent.uppercased(), systemImage: "sparkles", color: ControllerPalette.bone.opacity(0.82))
            if let take = store.controller.take, take.exists {
                statusPill(takeText(take), systemImage: "waveform", color: ControllerPalette.bone.opacity(0.82))
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.75)
    }

    private var recordingPad: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                controllerButton("KEEP", subtitle: "commit take", icon: "checkmark.circle.fill", event: .takeKeep, kind: .keep, minHeight: 136)
                    .disabled(!store.canSendCommands || store.controller.take?.canKeep != true)
                controllerButton("REDO", subtitle: "try again", icon: "arrow.counterclockwise.circle.fill", event: .takeRedo, kind: .again, minHeight: 136)
                    .disabled(!store.canSendCommands)
            }

            HStack(spacing: 12) {
                controllerButton("HEAR IT", subtitle: "play back", icon: "speaker.wave.2.fill", event: .takeListen, kind: .hear, minHeight: 108)
                    .disabled(!store.canSendCommands || store.controller.take?.exists != true)
                controllerButton("MARKER", subtitle: "flag moment", icon: "flag.fill", event: .takeMark, kind: .marker, minHeight: 108)
                    .disabled(!store.canSendCommands)
            }

            HStack(spacing: 12) {
                Button {
                    Task { await store.runPutMeIn() }
                } label: {
                    tileLabel("PUT ME IN", subtitle: "record", icon: "record.circle", minHeight: 54, compact: true)
                }
                .buttonStyle(ControllerButtonStyle(kind: .record))
                .disabled(!store.canSendCommands)
                .accessibilityIdentifier("controller.PUT_ME_IN")

                Button {
                    Task { await store.runControllerEvent(.transportToggle) }
                } label: {
                    tileLabel(
                        store.transport?.playing == true ? "STOP" : "PLAY",
                        subtitle: store.transport?.playing == true ? "pause transport" : "roll",
                        icon: store.transport?.playing == true ? "stop.fill" : "play.fill",
                        minHeight: 54,
                        compact: true
                    )
                }
                .buttonStyle(ControllerButtonStyle(kind: .transport))
                    .disabled(!store.canSendCommands)
                .accessibilityIdentifier("controller.\(ControllerEvent.transportToggle.rawValue)")
            }
        }
        .padding(12)
        .background(ControllerPalette.panel, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(ControllerPalette.ink.opacity(0.22), lineWidth: 1)
        )
        .shadow(color: ControllerPalette.ink.opacity(0.18), radius: 18, x: 0, y: 12)
    }

    private var scrubNavigator: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                Slider(
                    value: $scrubPosition,
                    in: 0...maxScrubPosition,
                    onEditingChanged: { editing in
                        isScrubbing = editing
                        if !editing {
                            Task { await store.runControllerEvent(.transportScrub, scrubPosition: scrubPosition) }
                        }
                    }
                )
                .tint(ControllerPalette.lime)
                HStack {
                    Text("0:00.00")
                    Spacer()
                    Text(timeText(maxScrubPosition))
                }
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ControllerPalette.ink.opacity(0.62))
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 2)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: connectionIcon)
                Text(connectionTitle)
                Spacer()
                Button {
                    Task { await store.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Refresh")
            }
            .font(.system(.headline, design: .rounded).weight(.bold))
            .foregroundStyle(connectionColor)

            if let detail = connectionDetail {
                Text(detail)
                    .font(.system(.footnote, design: .rounded))
                    .foregroundStyle(ControllerPalette.ink.opacity(0.56))
                    .lineLimit(2)
            }

            if let error = store.errorText {
                Text(error)
                    .font(.system(.footnote, design: .rounded))
                    .foregroundStyle(ControllerPalette.red)
                    .lineLimit(2)
            } else if let receipt = store.receipts.first {
                Text(receipt)
                    .font(.system(.footnote, design: .rounded))
                    .foregroundStyle(ControllerPalette.ink.opacity(0.56))
                    .lineLimit(1)
            }
        }
        .padding(.top, 4)
    }

    private func controllerButton(_ title: String, subtitle: String, icon: String, event: ControllerEvent, kind: ControllerButtonStyle.Kind, minHeight: CGFloat) -> some View {
        Button {
            Task { await store.runControllerEvent(event) }
        } label: {
            tileLabel(title, subtitle: subtitle, icon: icon, minHeight: minHeight)
        }
        .buttonStyle(ControllerButtonStyle(kind: kind))
        .accessibilityIdentifier("controller.\(event.rawValue)")
    }

    private func tileLabel(_ title: String, subtitle: String, icon: String, minHeight: CGFloat, compact: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: compact ? 4 : 8) {
            HStack {
                Image(systemName: icon)
                    .font(.system(size: compact ? 16 : 22, weight: .black))
                Spacer(minLength: 0)
            }
            Spacer(minLength: compact ? 0 : 4)
            Text(title)
                .font(.system(size: compact ? (title == "PUT ME IN" ? 17 : 20) : (title == "PUT ME IN" ? 22 : 28), weight: .black, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.74)
            Text(subtitle.uppercased())
                .font(.system(size: compact ? 9 : 11, weight: .heavy, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .opacity(0.72)
        }
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .bottomLeading)
        .padding(compact ? 10 : 14)
    }

    private func statusPill(_ text: String, systemImage: String, color: Color) -> some View {
        Label(text, systemImage: systemImage)
            .font(.system(.caption, design: .rounded).weight(.bold))
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(ControllerPalette.bone.opacity(0.08), in: Capsule())
            .foregroundStyle(color)
    }

    private var maxScrubPosition: Double {
        let transportEnd = max(store.transport?.loopEnd ?? 0, (store.transport?.position ?? 0) + 30)
        let takeEnd = (store.controller.take?.start ?? 0) + (store.controller.take?.length ?? 0)
        return max(1, transportEnd, takeEnd)
    }

    private var positionText: String {
        timeText(store.transport?.position ?? 0)
    }

    private var sessionTitle: String {
        if store.transport?.recording == true {
            return "RECORDING"
        }
        if store.transport?.playing == true {
            return "PLAYING"
        }
        return "READY"
    }

    private func timeText(_ position: Double) -> String {
        let minutes = Int(position / 60)
        let seconds = Int(position) % 60
        let centis = Int((position * 100).truncatingRemainder(dividingBy: 100))
        return String(format: "%d:%02d.%02d", minutes, seconds, centis)
    }

    private func takeText(_ take: MoshControllerTake) -> String {
        if let numTakes = take.numTakes, numTakes > 0 {
            return "TAKE \(max(1, (take.currentTakeIndex ?? 0) + 1))/\(numTakes)"
        }
        return "TAKE"
    }

    private var connectionTitle: String {
        switch store.connectionState {
        case .unpaired:
            return "Not paired"
        case .connecting:
            return "Connecting"
        case .online:
            return "Connected"
        case .offline:
            return "Offline"
        }
    }

    private var connectionIcon: String {
        switch store.connectionState {
        case .unpaired:
            return "link.badge.plus"
        case .connecting:
            return "antenna.radiowaves.left.and.right"
        case .online:
            return "checkmark.circle.fill"
        case .offline:
            return "exclamationmark.triangle.fill"
        }
    }

    private var connectionColor: Color {
        switch store.connectionState {
        case .online:
            return ControllerPalette.lime
        case .offline:
            return .orange
        default:
            return ControllerPalette.bone.opacity(0.7)
        }
    }

    /// Rough round-trip label for the small connection-quality pill — "42ms" while
    /// healthy, a plain word once the link itself is the problem.
    private var qualityText: String {
        switch store.connectionQuality {
        case .unknown: return "…"
        case .good(let ms), .marginal(let ms), .poor(let ms): return "\(Int(ms.rounded()))ms"
        case .lost: return "lost"
        }
    }

    private var qualityIcon: String {
        switch store.connectionQuality {
        case .unknown: return "wifi"
        case .good: return "wifi"
        case .marginal: return "wifi.exclamationmark"
        case .poor, .lost: return "wifi.slash"
        }
    }

    private var qualityColor: Color {
        switch store.connectionQuality {
        case .unknown: return ControllerPalette.bone.opacity(0.55)
        case .good: return ControllerPalette.lime
        case .marginal: return ControllerPalette.gold
        case .poor, .lost: return ControllerPalette.red
        }
    }

    private var qualityAccessibilityLabel: String {
        switch store.connectionQuality {
        case .unknown: return "measuring"
        case .good(let ms): return "good, \(Int(ms.rounded())) milliseconds"
        case .marginal(let ms): return "marginal, \(Int(ms.rounded())) milliseconds"
        case .poor(let ms): return "poor, \(Int(ms.rounded())) milliseconds"
        case .lost: return "lost"
        }
    }

    private var connectionDetail: String? {
        switch store.connectionState {
        case .unpaired:
            return nil
        case .connecting:
            return "Checking Mac"
        case .online(let lastUpdated):
            return "Updated \(lastUpdated.formatted(date: .omitted, time: .shortened))"
        case .offline(let message, let lastOnline):
            if let lastOnline {
                return "\(message) Last online \(lastOnline.formatted(date: .omitted, time: .shortened))"
            }
            return message
        }
    }
}

private enum ControllerPalette {
    static let page = Color(red: 238 / 255, green: 230 / 255, blue: 214 / 255)
    static let ink = Color(red: 11 / 255, green: 11 / 255, blue: 11 / 255)
    static let panel = Color(red: 20 / 255, green: 22 / 255, blue: 22 / 255)
    static let raised = Color(red: 35 / 255, green: 38 / 255, blue: 38 / 255)
    static let line = Color(red: 72 / 255, green: 76 / 255, blue: 74 / 255)
    static let lime = Color(red: 204 / 255, green: 255 / 255, blue: 35 / 255)
    static let bone = Color(red: 246 / 255, green: 242 / 255, blue: 235 / 255)
    static let gold = Color(red: 255 / 255, green: 202 / 255, blue: 82 / 255)
    static let red = Color(red: 255 / 255, green: 82 / 255, blue: 82 / 255)
    static let rust = Color(red: 226 / 255, green: 91 / 255, blue: 62 / 255)
}

private struct ControllerButtonStyle: ButtonStyle {
    enum Kind {
        case keep
        case again
        case hear
        case marker
        case record
        case transport
    }

    let kind: Kind

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(foreground)
            .background(background.opacity(configuration.isPressed ? 0.78 : 1.0), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(border, lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
    }

    private var background: Color {
        switch kind {
        case .keep:
            return ControllerPalette.lime
        case .again:
            return ControllerPalette.rust
        case .hear:
            return ControllerPalette.raised
        case .marker:
            return ControllerPalette.gold
        case .record:
            return ControllerPalette.panel
        case .transport:
            return ControllerPalette.bone.opacity(0.16)
        }
    }

    private var foreground: Color {
        switch kind {
        case .keep, .again, .marker:
            return ControllerPalette.ink
        case .hear, .record, .transport:
            return ControllerPalette.bone
        }
    }

    private var border: Color {
        switch kind {
        case .keep:
            return ControllerPalette.lime
        case .again:
            return ControllerPalette.rust
        case .hear:
            return ControllerPalette.line
        case .marker:
            return ControllerPalette.gold
        case .record:
            return ControllerPalette.lime.opacity(0.46)
        case .transport:
            return ControllerPalette.bone.opacity(0.28)
        }
    }
}
