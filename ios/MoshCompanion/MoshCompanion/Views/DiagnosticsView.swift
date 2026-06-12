import SwiftUI

#if DEBUG
struct DiagnosticsView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        NavigationStack {
            List {
                Section("Monitoring") {
                    Button {
                        store.runMonitoringDiagnostics()
                    } label: {
                        Label(store.monitoring.isRunning ? "Running" : "Run Latency Spike",
                              systemImage: "waveform.path.ecg")
                    }
                    .disabled(store.monitoring.isRunning || !store.canSendCommands)

                    if let report = store.monitoring.lastReport {
                        LabeledContent("Network median", value: format(report.networkMedianMs))
                        LabeledContent("Network p95", value: format(report.networkP95Ms))
                        LabeledContent("Network jitter", value: format(report.networkJitterMs))
                        LabeledContent("Acoustic median", value: format(report.acousticMedianMs))
                        LabeledContent("Acoustic p95", value: format(report.acousticP95Ms))
                        LabeledContent("Acoustic jitter", value: format(report.acousticJitterMs))
                    }

                    if let reportFile = store.monitoring.lastReportFile {
                        Text(reportFile)
                            .font(.footnote.monospaced())
                            .foregroundStyle(.secondary)
                    }

                    if let error = store.monitoring.errorText {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Diagnostics")
        }
    }

    private func format(_ value: Double) -> String {
        String(format: "%.1f ms", value)
    }
}
#endif
