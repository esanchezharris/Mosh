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
            ControllerPalette.ink.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 16) {
                chrome
                header
                statusStrip

                if store.controllerMode == .capture {
                    captureControls
                } else {
                    judgmentControls
                }

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
        .foregroundStyle(ControllerPalette.bone.opacity(0.86))
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(store.controllerMode == .capture ? "CAPTURE" : "JUDGMENT")
                .font(.system(size: 30, weight: .black, design: .rounded))
                .foregroundStyle(ControllerPalette.lime)
            Spacer()
            Text(positionText)
                .font(.system(.title3, design: .monospaced).weight(.semibold))
                .foregroundStyle(ControllerPalette.bone)
        }
    }

    private var statusStrip: some View {
        HStack(spacing: 10) {
            statusPill(connectionTitle, systemImage: connectionIcon, color: connectionColor)
            statusPill(store.controller.agent.uppercased(), systemImage: "sparkles", color: ControllerPalette.bone.opacity(0.82))
            if let take = store.controller.take, take.exists {
                statusPill(takeText(take), systemImage: "waveform", color: ControllerPalette.bone.opacity(0.82))
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.75)
    }

    private var captureControls: some View {
        VStack(spacing: 14) {
            Button {
                Task { await store.runControllerEvent(.takeMark) }
            } label: {
                Label("MARK", systemImage: "flag.fill")
                    .frame(maxWidth: .infinity, minHeight: 168)
            }
            .buttonStyle(ControllerButtonStyle(kind: .primary))
            .disabled(!store.canSendCommands)
            .accessibilityIdentifier("controller.\(ControllerEvent.takeMark.rawValue)")

            Button {
                Task { await store.runControllerEvent(.transportToggle) }
            } label: {
                Label(store.transport?.playing == true ? "PAUSE" : "PLAY", systemImage: store.transport?.playing == true ? "pause.fill" : "play.fill")
                    .frame(maxWidth: .infinity, minHeight: 84)
            }
            .buttonStyle(ControllerButtonStyle(kind: .secondary))
            .disabled(!store.canSendCommands)
        }
    }

    private var judgmentControls: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                controllerButton("KEEP", icon: "checkmark.circle.fill", event: .takeKeep, kind: .primary)
                    .disabled(!store.canSendCommands || store.controller.take?.canKeep != true)
                controllerButton("REDO", icon: "arrow.counterclockwise.circle.fill", event: .takeRedo, kind: .danger)
                    .disabled(!store.canSendCommands)
            }

            controllerButton("LISTEN", icon: "speaker.wave.2.fill", event: .takeListen, kind: .secondary)
                .disabled(!store.canSendCommands || store.controller.take?.exists != true)

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
                .foregroundStyle(ControllerPalette.bone.opacity(0.68))
            }
            .padding(.top, 8)
        }
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
                    .foregroundStyle(ControllerPalette.bone.opacity(0.52))
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
                    .foregroundStyle(ControllerPalette.bone.opacity(0.52))
                    .lineLimit(1)
            }
        }
        .padding(.top, 4)
    }

    private func controllerButton(_ title: String, icon: String, event: ControllerEvent, kind: ControllerButtonStyle.Kind) -> some View {
        Button {
            Task { await store.runControllerEvent(event) }
        } label: {
            Label(title, systemImage: icon)
                .frame(maxWidth: .infinity, minHeight: 92)
        }
        .buttonStyle(ControllerButtonStyle(kind: kind))
        .accessibilityIdentifier("controller.\(event.rawValue)")
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
    static let ink = Color(red: 11 / 255, green: 11 / 255, blue: 11 / 255)
    static let lime = Color(red: 204 / 255, green: 255 / 255, blue: 35 / 255)
    static let bone = Color(red: 246 / 255, green: 242 / 255, blue: 235 / 255)
    static let red = Color(red: 255 / 255, green: 82 / 255, blue: 82 / 255)
}

private struct ControllerButtonStyle: ButtonStyle {
    enum Kind {
        case primary
        case secondary
        case danger
    }

    let kind: Kind

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.title2, design: .rounded).weight(.black))
            .labelStyle(.titleAndIcon)
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
        case .primary:
            return ControllerPalette.lime
        case .secondary:
            return ControllerPalette.bone.opacity(0.14)
        case .danger:
            return ControllerPalette.red.opacity(0.92)
        }
    }

    private var foreground: Color {
        switch kind {
        case .primary, .danger:
            return ControllerPalette.ink
        case .secondary:
            return ControllerPalette.bone
        }
    }

    private var border: Color {
        switch kind {
        case .primary:
            return ControllerPalette.lime
        case .secondary:
            return ControllerPalette.bone.opacity(0.28)
        case .danger:
            return ControllerPalette.red
        }
    }
}
