import Foundation

enum MonitoringMetrics {
    static func estimateClockOffsetMs(samples: [MonitoringClockSample]) -> Double {
        guard !samples.isEmpty else { return 0 }
        let offsets = samples.map { (($0.phoneReceiveMs - $0.macSendMs) + ($0.phoneSendMs - $0.macReceiveMs)) / 2.0 }
        return median(offsets)
    }

    static func playoutSummary(samples: [MonitoringPlaybackSample], clockOffsetMs: Double) -> MonitoringSummary {
        let latencies = samples.map { $0.phoneScheduledPlaybackMs - clockOffsetMs - $0.macSentMs }
        return summary(latencies)
    }

    static func acousticSummary(onsetDeltasMs: [Double]) -> MonitoringSummary {
        summary(onsetDeltasMs)
    }

    static func detectAcousticOnsetMs(samples: [Float], sampleRate: Double, threshold: Float) -> Double? {
        guard sampleRate > 0 else { return nil }
        guard let index = samples.firstIndex(where: { abs($0) >= threshold }) else { return nil }
        return (Double(index) / sampleRate) * 1000.0
    }

    private static func summary(_ values: [Double]) -> MonitoringSummary {
        guard !values.isEmpty else {
            return MonitoringSummary(medianMs: 0, p95Ms: 0, jitterMs: 0)
        }
        let sorted = values.sorted()
        let medianValue = median(sorted)
        let p95Value = percentile(sorted, percentile: 0.95)
        let minValue = sorted.first ?? 0
        let maxValue = sorted.last ?? 0
        return MonitoringSummary(medianMs: medianValue, p95Ms: p95Value, jitterMs: maxValue - minValue)
    }

    private static func median(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let mid = sorted.count / 2
        if sorted.count.isMultiple(of: 2) {
            return (sorted[mid - 1] + sorted[mid]) / 2.0
        }
        return sorted[mid]
    }

    private static func percentile(_ sortedValues: [Double], percentile: Double) -> Double {
        guard !sortedValues.isEmpty else { return 0 }
        let clamped = max(0, min(1, percentile))
        let index = Int(ceil(clamped * Double(sortedValues.count))) - 1
        return sortedValues[max(0, min(sortedValues.count - 1, index))]
    }
}
