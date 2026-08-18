import SwiftUI
import UIKit

struct PairingView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        NavigationStack {
            Form {
                Section {
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
                } header: {
                    Text("Nearby Macs")
                } footer: {
                    // Auto-discovery is Bonjour/mDNS, which only the macOS host
                    // advertises today (RemoteCompanionServer::startBonjour() is
                    // JUCE_MAC-guarded — see docs/IPHONE_COMPANION.md). A MOSH
                    // instance on a Windows host will never show up here even
                    // though it pairs and controls fine; use the QR scan or the
                    // pairing URL below.
                    Text("Only macOS hosts appear here automatically. On Windows, scan the QR code shown in MOSH or paste its pairing link below.")
                }

                Section("Pairing URL") {
                    TextField("mosh://pair?payload=...", text: $store.pairingText, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    HStack {
                        Button {
                            store.pairFromText()
                        } label: {
                            Label("Pair", systemImage: "link")
                        }
                        .disabled(store.pairingText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                        Spacer()

                        Button {
                            pasteFromClipboard()
                        } label: {
                            Label("Paste", systemImage: "doc.on.clipboard")
                        }
                        .disabled(!clipboardHasStrings)
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

    /// `mosh://` links can also arrive by AirDrop, Messages, or a teammate
    /// copying the popover's URL manually — a one-tap paste avoids re-typing a
    /// base64 payload by hand, the main friction point of the manual-pairing
    /// fallback this view exists for.
    ///
    /// iOS 16+ pasteboard privacy: reading `.string` outside a user paste
    /// gesture fires the system "would like to paste" alert — and this
    /// property is evaluated on every body render, so checking content here
    /// would alert the user the moment the screen appears. `hasStrings` is
    /// metadata-only (no alert); the actual content read stays inside
    /// `pasteFromClipboard()`, where the alert is a legitimate response to
    /// the user's own tap.
    private var clipboardHasStrings: Bool {
        UIPasteboard.general.hasStrings
    }

    private func pasteFromClipboard() {
        guard let text = UIPasteboard.general.string else { return }
        store.pairingText = text
        store.pairFromText()
    }
}
