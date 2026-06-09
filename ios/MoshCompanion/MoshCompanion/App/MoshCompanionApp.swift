import SwiftUI

@main
struct MoshCompanionApp: App {
    @StateObject private var store = CompanionStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .onOpenURL { store.pair(from: $0.absoluteString) }
        }
    }
}
