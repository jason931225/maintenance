import XCTest

/// Apple's iOS 17+ automated accessibility audit
/// (`XCUIApplication.performAccessibilityAudit`) run on each real screen, under
/// the standard, largest-Dynamic-Type, and dark-mode presentations the field
/// uses. Any issue the audit reports (contrast, clipped text, missing
/// descriptions, bad traits, Dynamic-Type truncation, undetectable elements) is
/// a real VoiceOver/contrast/touch-target defect that must be fixed in the
/// SwiftUI views — not suppressed here.
///
/// CI-ONLY.
final class AccessibilityAuditUITests: FieldUITestCase {
    // MARK: Today / dispatch

    func testTodayScreenPassesAuditStandard() {
        launchApp(.standard)
        waitForAuthenticatedShell()
        _ = app.collectionViews[AID.todayList].waitForExistence(timeout: 15)
        assertNoAccessibilityIssues()
    }

    func testTodayScreenPassesAuditLargestDynamicType() {
        launchApp(.largestDynamicType)
        waitForAuthenticatedShell()
        _ = app.collectionViews[AID.todayList].waitForExistence(timeout: 15)
        assertNoAccessibilityIssues()
    }

    func testTodayScreenPassesAuditDarkMode() {
        launchApp(.darkMode)
        waitForAuthenticatedShell()
        _ = app.collectionViews[AID.todayList].waitForExistence(timeout: 15)
        assertNoAccessibilityIssues()
    }

    // MARK: Work-order detail

    func testWorkOrderDetailPassesAudit() throws {
        launchApp(.largestDynamicType)
        waitForAuthenticatedShell()
        let rowPredicate = NSPredicate(format: "identifier BEGINSWITH %@", "today.workOrderRow.")
        let firstRow = app.buttons.containing(rowPredicate).firstMatch
        guard firstRow.waitForExistence(timeout: 15) else {
            throw XCTSkip("No dispatched work order; detail audit needs a real row.")
        }
        firstRow.tap()
        XCTAssertTrue(app.otherElements[AID.detailView].waitForExistence(timeout: 10))
        assertNoAccessibilityIssues()
    }

    // MARK: Messenger

    func testMessengerScreenPassesAuditStandard() {
        launchApp(.standard)
        waitForAuthenticatedShell()
        XCTAssertTrue(tapTab(KO.messengerTitle))
        _ = app.staticTexts[KO.messengerTitle].waitForExistence(timeout: 10)
        assertNoAccessibilityIssues()
    }

    func testMessengerScreenPassesAuditDarkMode() {
        launchApp(.darkMode)
        waitForAuthenticatedShell()
        XCTAssertTrue(tapTab(KO.messengerTitle))
        _ = app.staticTexts[KO.messengerTitle].waitForExistence(timeout: 10)
        assertNoAccessibilityIssues()
    }

    // MARK: Login (signed-out audit)

    /// The login screen is audited from a signed-out launch (the seeded session
    /// is cleared first) so the very first screen a user meets is covered too.
    func testLoginScreenPassesAudit() {
        RealSessionSeed.clear()
        let app = XCUIApplication()
        app.launch()
        self.app = app
        XCTAssertTrue(
            app.textFields[AID.loginUserIDField].waitForExistence(timeout: 15),
            "Login field should appear when no session is seeded."
        )
        assertNoAccessibilityIssues()
    }
}
