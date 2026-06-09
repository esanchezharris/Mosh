import SwiftUI

struct PairingView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        NavigationStack {
            Form {
                Section("Nearby Macs") {
                    if store.browser.services.isEmpty {
                        Text("Start pairing in MOSH on your Mac.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(store.browser.services) { service in
                            HStack {
                                Image(systemName: "macbook")
                                Text(service.name)
                                Spacer()
                                Text("ready").foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                Section("Pairing URL") {
                    TextField("mosh://pair?payload=...", text: $store.pairingText, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button {
                        store.pairFromText()
                    } label: {
                        Label("Pair", systemImage: "link")
                    }
                }

                if let error = store.errorText {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Mosh")
        }
    }
}
