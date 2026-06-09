import SwiftUI

struct ConnectedSessionView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        TabView {
            SessionView()
                .tabItem { Label("Session", systemImage: "slider.horizontal.3") }
            HoldToTalkView()
                .tabItem { Label("Talk", systemImage: "mic") }
            TakeRecorderView()
                .tabItem { Label("Takes", systemImage: "waveform") }
            #if DEBUG
            DiagnosticsView()
                .tabItem { Label("Diagnostics", systemImage: "speedometer") }
            #endif
        }
        .task { await store.refresh() }
    }
}
