import SwiftUI

struct TakeRecorderView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()
                Button {
                    store.toggleTake()
                } label: {
                    Image(systemName: store.recorder.isRecording ? "stop.circle.fill" : "record.circle")
                        .font(.system(size: 96))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(store.recorder.isRecording ? .red : .primary)
                }
                .disabled(!store.canSendCommands && !store.recorder.isRecording)

                ProgressView(value: Double(store.recorder.level), total: 1)
                    .padding(.horizontal)

                Text(store.recorder.isRecording ? "Recording phone take" : "Ready to record")
                    .foregroundStyle(.secondary)

                ReceiptsView()
                Spacer()
            }
            .padding()
            .navigationTitle("Phone Take")
        }
    }
}
