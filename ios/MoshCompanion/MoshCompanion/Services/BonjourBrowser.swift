import Foundation
import Network

@MainActor
final class BonjourBrowser: ObservableObject {
    struct Service: Identifiable, Equatable {
        let id: String
        let name: String
        let endpoint: NWEndpoint
    }

    @Published private(set) var services: [Service] = []
    private var browser: NWBrowser?

    func start() {
        guard browser == nil else { return }
        let descriptor = NWBrowser.Descriptor.bonjour(type: "_moshcompanion._tcp", domain: nil)
        let browser = NWBrowser(for: descriptor, using: .tcp)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let mapped = results.compactMap { result -> Service? in
                guard case let .service(name, type, domain, _) = result.endpoint else { return nil }
                return Service(id: "\(name).\(type).\(domain)", name: name, endpoint: result.endpoint)
            }
            Task { @MainActor in self?.services = mapped.sorted { $0.name < $1.name } }
        }
        browser.start(queue: .global(qos: .utility))
        self.browser = browser
    }

    func stop() {
        browser?.cancel()
        browser = nil
        services = []
    }
}
