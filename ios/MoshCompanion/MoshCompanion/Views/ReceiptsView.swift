import SwiftUI

struct ReceiptsView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        Group {
            Section("Connection") {
                Label(connectionTitle, systemImage: connectionIcon)
                    .foregroundStyle(connectionColor)

                if let detail = connectionDetail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if store.isPaired {
                    Button {
                        Task { await store.refresh() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }

                    Button {
                        store.forgetPairing()
                    } label: {
                        Label("Forget Pairing", systemImage: "trash")
                            .foregroundStyle(.red)
                    }
                }
            }

            Section("Receipts") {
                if let error = store.errorText {
                    Text(error).foregroundStyle(.red)
                }
                ForEach(Array(store.receipts.prefix(5).enumerated()), id: \.offset) { _, receipt in
                    Text(receipt).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var connectionTitle: String {
        switch store.connectionState {
        case .unpaired:
            return "Not paired"
        case .connecting:
            return "Connecting to MOSH"
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

    private var connectionDetail: String? {
        switch store.connectionState {
        case .unpaired:
            return "Scan the Mac QR code or paste the pairing URL."
        case .connecting:
            return "Checking the Mac companion server."
        case .online(let lastUpdated):
            return "Last refreshed \(lastUpdated.formatted(date: .omitted, time: .shortened))."
        case .offline(let message, let lastOnline):
            if let lastOnline {
                return "\(message) Last online \(lastOnline.formatted(date: .omitted, time: .shortened))."
            }
            return message
        }
    }
}
