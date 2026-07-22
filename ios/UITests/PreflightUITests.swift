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
        let restoredApp = XCUIApplication()
        restoredApp.launchArguments += LaunchLocale.arguments
        restoredApp.launchEnvironment["MAINTENANCE_API_BASE_URL"] = baseURL
        restoredApp.launch()
        defer { restoredApp.terminate() }

        XCTAssertTrue(
            restoredApp.staticTexts[KO.todayTitle].waitForExistence(timeout: 20)
                || restoredApp.tabBars.buttons[KO.todayTitle].waitForExistence(timeout: 1)
                || restoredApp.collectionViews[AID.todayList].waitForExistence(timeout: 1),
            "The unmodified main app must restore the session written by the app-owned seeder."
        )
        XCTAssertFalse(
            restoredApp.textFields[AID.loginUserIDField].exists,
            "A seeded session must not leave the main app on the login form."
        )

        restoredApp.terminate()
        try RealSessionSeed.clear()

        let signedOutApp = XCUIApplication()
        signedOutApp.launchArguments += LaunchLocale.arguments
        signedOutApp.launchEnvironment["MAINTENANCE_API_BASE_URL"] = baseURL
        signedOutApp.launch()
        defer { signedOutApp.terminate() }
        XCTAssertTrue(
            signedOutApp.staticTexts[KO.loginTitle].waitForExistence(timeout: 15),
            "After a helper clear, the normal app launch must be signed out."
        )
    }
}
