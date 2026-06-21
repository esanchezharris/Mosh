import SwiftUI

struct HoldToTalkView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()
                Button {
                    if store.speech.isListening { store.stopHoldToTalk() }
                    else { store.startHoldToTalk() }
                } label: {
                    Image(systemName: store.speech.isListening ? "stop.circle.fill" : "mic.circle.fill")
                        .font(.system(size: 88))
                        .symbolRenderingMode(.hierarchical)
                }
                .disabled(!store.speech.isAvailable || !store.canSendCommands)

                Text(store.speech.isAvailable ? "Hold-to-talk ready" : "On-device speech unavailable")
                    .foregroundStyle(.secondary)

                ReceiptsView()
                Spacer()
            }
            .padding()
            .navigationTitle("Voice")
        }
    }
}
