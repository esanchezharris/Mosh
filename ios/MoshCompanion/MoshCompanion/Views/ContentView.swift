import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        Group {
            if store.isPaired {
                ConnectedSessionView()
            } else {
                PairingView()
            }
        }
        .task { store.start() }
    }
}
