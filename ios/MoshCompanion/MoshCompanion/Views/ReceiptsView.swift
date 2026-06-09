import SwiftUI

struct ReceiptsView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
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
