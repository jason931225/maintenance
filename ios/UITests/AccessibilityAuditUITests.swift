import XCTest

/// Apple's accessibility audit over real authenticated and signed-out screens.
/// CI-only: every `.all` audit finding is a test failure.
final class AccessibilityAuditUITests: FieldUITestCase {
    func testTodayScreenPassesAuditStandard() async throws {
        _ = try await launchApp(.standard)
        waitForAuthenticatedShell()
        XCTAssertTrue(app.collectionViews[AID.todayList].waitForExistence(timeout: 15))
        assertNoAccessibilityIssues()
    }

    func testTodayScreenPassesAuditLargestDynamicType() async throws {
        _ = try await launchApp(.largestDynamicType)
        waitForAuthenticatedShell()
        XCTAssertTrue(app.collectionViews[AID.todayList].waitForExistence(timeout: 15))
        assertNoAccessibilityIssues()
    }

    func testTodayScreenPassesAuditDarkMode() async throws {
        _ = try await launchApp(.darkMode)
        waitForAuthenticatedShell()
        XCTAssertTrue(app.collectionViews[AID.todayList].waitForExistence(timeout: 15))
        assertNoAccessibilityIssues()
    }

    func testWorkOrderDetailPassesAudit() async throws {
        _ = try await launchApp(.largestDynamicType)
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.detailWorkOrderID)
        assertNoAccessibilityIssues()
    }

    func testMessengerScreenPassesAuditStandard() async throws {
        _ = try await launchApp(.standard)
        waitForAuthenticatedShell()
        XCTAssertTrue(tapTab(KO.messengerTitle))
        XCTAssertTrue(app.staticTexts[KO.messengerTitle].waitForExistence(timeout: 10))
        assertNoAccessibilityIssues()
    }

    func testMessengerScreenPassesAuditDarkMode() async throws {
        _ = try await launchApp(.darkMode)
        waitForAuthenticatedShell()
        XCTAssertTrue(tapTab(KO.messengerTitle))
        XCTAssertTrue(app.staticTexts[KO.messengerTitle].waitForExistence(timeout: 10))
        assertNoAccessibilityIssues()
    }

    /// The login screen is audited after removing the real session while keeping
    /// the same runner-provided local backend URL.
    func testLoginScreenPassesAudit() async throws {
        _ = try await launchSignedOutApp()
        XCTAssertTrue(
            app.textFields[AID.loginUserIDField].waitForExistence(timeout: 15),
            "Login field should appear when no session is seeded."
        )
        assertNoAccessibilityIssues()
    }
}
