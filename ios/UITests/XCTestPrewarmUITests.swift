import XCTest

/// Bounded infrastructure-only warmup for XCTest and the app host. It is kept
/// outside the functional shard manifest: it cannot substitute for a user
/// workflow result and failure still fails the owning worker.
@MainActor
final class XCTestPrewarmUITests: XCTestCase {
    func testRunnerAndHostLaunch() {
        let app = XCUIApplication()
        app.launch()
        defer { app.terminate() }

        XCTAssertEqual(
            app.state,
            .runningForeground,
            "The XCTest runner must be able to launch and foreground the app host before functional shards run."
        )
    }
}
