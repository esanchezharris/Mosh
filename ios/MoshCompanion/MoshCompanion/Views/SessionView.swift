import SwiftUI

struct SessionView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        NavigationStack {
            List {
                Section("Transport") {
                    HStack(spacing: 12) {
                        Button {
                            store.setTransport(store.transport?.playing == true ? "stop" : "play")
                        } label: {
                            Label(store.transport?.playing == true ? "Stop" : "Play",
                                  systemImage: store.transport?.playing == true ? "stop.fill" : "play.fill")
                        }
                        .buttonStyle(.borderedProminent)

                        Button {
                            store.setTransport("stop")
                        } label: {
                            Label("Return", systemImage: "backward.end.fill")
                        }
                    }
                    Text(positionText)
                        .font(.system(.title2, design: .monospaced))
                }

                Section("Target Track") {
                    Picker("Track", selection: $store.selectedTrackId) {
                        ForEach(store.tracks) { track in
                            Text(track.name.isEmpty ? "Track \(track.index + 1)" : track.name)
                                .tag(Optional(track.id))
                        }
                    }
                }

                Section("Render") {
                    Picker("Target", selection: $store.selectedRenderClipId) {
                        if store.renderTargets.isEmpty {
                            Text("No rendered clips").tag(Optional<String>.none)
                        } else {
                            ForEach(store.renderTargets) { target in
                                Text(target.title).tag(Optional(target.clipId))
                            }
                        }
                    }

                    HStack(spacing: 12) {
                        Button {
                            Task { await store.runRenderDecision(.accept) }
                        } label: {
                            Label("Accept", systemImage: "checkmark.circle")
                        }
                        .disabled(store.selectedRenderClipId == nil)

                        Button {
                            Task { await store.runRenderDecision(.reject) }
                        } label: {
                            Label("Reject", systemImage: "xmark.circle")
                        }
                        .disabled(store.selectedRenderClipId == nil)
                    }
                }

                ReceiptsView()
            }
            .refreshable { await store.refresh() }
            .navigationTitle("MOSH Session")
        }
    }

    private var positionText: String {
        let position = store.transport?.position ?? 0
        let minutes = Int(position / 60)
        let seconds = Int(position) % 60
        let centis = Int((position * 100).truncatingRemainder(dividingBy: 100))
        return String(format: "%d:%02d.%02d", minutes, seconds, centis)
    }
}
