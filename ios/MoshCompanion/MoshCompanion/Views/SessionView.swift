import SwiftUI

struct SessionView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(alignment: .center, spacing: 12) {
                        Text("MOSH Session")
                            .font(.title2.bold())
                        Spacer()
                        Button {
                            store.forgetPairing()
                        } label: {
                            Label("Forget", systemImage: "link.badge.minus")
                        }
                        .buttonStyle(.bordered)
                    }

                    sessionGroup("Transport") {
                        HStack(spacing: 12) {
                            Button {
                                store.setTransport(store.transport?.playing == true ? "stop" : "play")
                            } label: {
                                Label(store.transport?.playing == true ? "Stop" : "Play",
                                      systemImage: store.transport?.playing == true ? "stop.fill" : "play.fill")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!store.canSendCommands)

                            Button {
                                store.setTransport("stop")
                            } label: {
                                Label("Return", systemImage: "backward.end.fill")
                                    .labelStyle(.iconOnly)
                                    .frame(maxWidth: .infinity)
                            }
                            .accessibilityLabel("Return")
                            .buttonStyle(.bordered)
                            .disabled(!store.canSendCommands)

                            Text(positionText)
                                .font(.system(.title3, design: .monospaced))
                                .fixedSize()
                        }
                    }

                    HStack(alignment: .center, spacing: 12) {
                        Text("Target Track")
                            .font(.headline)
                            .foregroundStyle(.secondary)

                        Picker("Track", selection: $store.selectedTrackId) {
                            ForEach(store.tracks) { track in
                                Text(track.name.isEmpty ? "Track \(track.index + 1)" : track.name)
                                    .tag(Optional(track.id))
                            }
                        }
                        .pickerStyle(.menu)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    sessionGroup("Render") {
                        Picker("Target", selection: $store.selectedRenderClipId) {
                            if store.renderTargets.isEmpty {
                                Text("No rendered clips").tag(Optional<String>.none)
                            } else {
                                ForEach(store.renderTargets) { target in
                                    Text(target.title).tag(Optional(target.clipId))
                                }
                            }
                        }
                        .pickerStyle(.menu)

                        HStack(spacing: 12) {
                            Button {
                                Task { await store.runRenderDecision(.accept) }
                            } label: {
                                Label("Accept", systemImage: "checkmark.circle")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .disabled(store.selectedRenderClipId == nil || !store.canSendCommands)

                            Button {
                                Task { await store.runRenderDecision(.reject) }
                            } label: {
                                Label("Reject", systemImage: "xmark.circle")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .disabled(store.selectedRenderClipId == nil || !store.canSendCommands)
                        }
                    }

                    Label(connectionTitle, systemImage: connectionIcon)
                        .font(.headline)
                        .foregroundStyle(connectionColor)
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)
                .padding(.bottom, 104)
            }
            .refreshable { await store.refresh() }
            .ignoresSafeArea(.container, edges: .top)
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private func sessionGroup<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 12) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var positionText: String {
        let position = store.transport?.position ?? 0
        let minutes = Int(position / 60)
        let seconds = Int(position) % 60
        let centis = Int((position * 100).truncatingRemainder(dividingBy: 100))
        return String(format: "%d:%02d.%02d", minutes, seconds, centis)
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
            return .green
        case .offline:
            return .orange
        default:
            return .secondary
        }
    }
}
