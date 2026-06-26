import XCTest

final class ControllerUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testControllerButtonsSendCommands() throws {
        let app = XCUIApplication(bundleIdentifier: "studio.mosh.companion")
        app.activate()

        try tapControllerButton(app.buttons["controller.\(ControllerEventName.takeKeep.rawValue)"])
        try tapControllerButton(app.buttons["controller.\(ControllerEventName.takeRedo.rawValue)"])
        try tapControllerButton(app.buttons["controller.\(ControllerEventName.takeMark.rawValue)"])
    }

    @MainActor
    private func tapControllerButton(_ button: XCUIElement) throws {
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        let predicate = NSPredicate(format: "hittable == true")
        let result = XCTWaiter.wait(for: [expectation(for: predicate, evaluatedWith: button)], timeout: 10)
        XCTAssertEqual(result, .completed)
        button.tap()
    }
}

private enum ControllerEventName: String {
    case takeKeep = "TAKE_KEEP"
    case takeRedo = "TAKE_REDO"
    case takeMark = "TAKE_MARK"
}
