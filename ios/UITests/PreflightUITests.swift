import XCTest

/// Fails before the post-login suite if workflow-provided session, local backend,
/// deterministic fixture, or the app-owned Keychain-seeder prerequisites are
/// absent. This is deliberately a real cross-process restore proof, not an
/// entitlement inspection of the XCTest runner.
@MainActor
final class PreflightUITests: XCTestCase {
    func testWorkflowMintedSessionAndLocalBackendAreConfigured() throws {
        let baseURL = try RealBackendSession.baseURL()
        XCTAssertFalse(baseURL.isEmpty)
        let tokens = try RealBackendSession.tokens()
        XCTAssertFalse(tokens.accessToken.isEmpty, "Workflow-minted access token must be non-empty.")
        XCTAssertFalse(tokens.refreshToken.isEmpty, "Workflow-minted refresh token must be non-empty.")
    }

    func testDeterministicWorkOrderFixturesAreConfigured() throws {
        for key in [
            UITestFixture.detailWorkOrderID,
            UITestFixture.startWorkOrderID,
            UITestFixture.reportWorkOrderID,
            UITestFixture.reportSuccessWorkOrderID,
            UITestFixture.cameraWorkOrderID,
        ] {
            let workOrderID = try UITestFixture.requiredID(key)
            XCTAssertFalse(workOrderID.isEmpty, "Fixture \(key) must be non-empty.")
        }
        XCTAssertFalse(try UITestFixture.requiredID(UITestFixture.messengerThreadID).isEmpty)
        XCTAssertFalse(try UITestFixture.requiredID(UITestFixture.messengerInitialMessageID).isEmpty)
    }

    func testSeederRestoresThenClearsRealSession() throws {
        let tokens = try RealBackendSession.tokens()
        let baseURL = try RealBackendSession.baseURL()

        try RealSessionSeed.seed(tokens)
        let restoredApp = try XCUIApplication.fieldUITestApp(baseURL: baseURL)
        restoredApp.launch()
        defer { restoredApp.terminate() }

        XCTAssertTrue(
            restoredApp.tabBars.buttons[KO.todayTitle].waitForExistence(timeout: 20),
            "The unmodified main app must restore the session written by the app-owned seeder."
        )
        XCTAssertFalse(
            restoredApp.textFields[AID.loginUserIDField].exists,
            "A seeded session must not leave the main app on the login form."
        )
        XCTAssertTrue(
            restoredApp.collectionViews[AID.todayList].waitForExistence(timeout: 20),
            "An authenticated shell without the Today list is not a successful API restore."
        )
        let detailWorkOrderID = try UITestFixture.requiredID(UITestFixture.detailWorkOrderID)
        XCTAssertTrue(
            scrollToWorkOrderRow(in: restoredApp, id: detailWorkOrderID, timeout: 20) != nil,
            "The restored app must decode and render the deterministic Today fixture; an HTTP 200 with an undecodable work-order response is a preflight failure."
        )

        restoredApp.terminate()
        try RealSessionSeed.clear()

        let signedOutApp = try XCUIApplication.fieldUITestApp(baseURL: baseURL)
        signedOutApp.launch()
        defer { signedOutApp.terminate() }
        XCTAssertTrue(
            signedOutApp.staticTexts[KO.loginTitle].waitForExistence(timeout: 15),
            "After a helper clear, the normal app launch must be signed out."
        )
    }
}
