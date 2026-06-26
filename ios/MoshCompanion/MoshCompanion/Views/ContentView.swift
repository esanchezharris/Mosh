import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: CompanionStore
    @State private var appliedLaunchPairing = false

    var body: some View {
        Group {
            if store.isPaired {
                ConnectedSessionView()
            } else {
                PairingView()
            }
        }
        .task {
            store.start()
            var appliedPairing = false
            #if DEBUG
            if !appliedLaunchPairing,
               let launchPairingURL = ProcessInfo.processInfo.environment["MOSH_COMPANION_PAIRING_URL"],
               !launchPairingURL.isEmpty {
                appliedLaunchPairing = true
                appliedPairing = true
                store.pair(from: launchPairingURL)
            }
            #endif
            if !appliedPairing, store.isPaired {
                await store.refresh()
            }
        }
    }
}
