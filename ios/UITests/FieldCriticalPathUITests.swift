import XCTest

/// The field mechanic's post-login critical path, driven against a **real**
/// session (seeded via `FieldUITestCase`) talking to the **real** backend.
///
/// These assertions check the **real visible outcomes** — the rendered Korean
/// labels and the elements keyed by production accessibility identifiers. There
/// is no fake repository anywhere: the work orders, threads and consent state
/// come from the backend the seeded session authenticates against.
///
/// CI-ONLY: requires the iOS Simulator + a real backend session source. Locally
/// (`swift build` / `swift test`) this target is not built — see the CI job
/// `ios-ui-tests` in `.github/workflows/ios-ui-tests.yml`.
final class FieldCriticalPathUITests: FieldUITestCase {
    func testAuthenticatedLaunchShowsTodayTabInKorean() {
        launchApp()
        waitForAuthenticatedShell()

        // The Today tab and its title render in Korean.
        XCTAssertTrue(
            app.staticTexts[KO.todayTitle].waitForExistence(timeout: 10),
            "Today tab title 오늘 작업 should be visible after real-session restore."
        )
        // The login form must NOT be present — we are past auth for real.
        XCTAssertFalse(
            app.textFields[AID.loginUserIDField].exists,
            "Login field must not be present once the real session is restored."
        )
    }

    func testDispatchListRendersMechanicWorkOrdersOrRealEmptyState() {
        launchApp()
        waitForAuthenticatedShell()

        let list = app.collectionViews[AID.todayList]
        XCTAssertTrue(list.waitForExistence(timeout: 15), "Dispatch list should render.")

        // Either the mechanic has real work orders (at least one row keyed by the
        // production identifier prefix) OR the real empty-state copy is shown.
        let rowPredicate = NSPredicate(format: "identifier BEGINSWITH %@", "today.workOrderRow.")
        let rows = app.buttons.containing(rowPredicate)
        let emptyState = app.staticTexts[AID.todayEmpty]

        let hasRows = rows.firstMatch.waitForExistence(timeout: 10)
        let hasEmpty = emptyState.exists || app.staticTexts[KO.emptyToday].exists
        XCTAssertTrue(
            hasRows || hasEmpty,
            "Dispatch tab must show either real work-order rows or the empty state 오늘 배정된 작업이 없습니다."
        )
    }

    func testOpenWorkOrderDetailAndAdvanceWhenADispatchExists() throws {
        launchApp()
        waitForAuthenticatedShell()

        let rowPredicate = NSPredicate(format: "identifier BEGINSWITH %@", "today.workOrderRow.")
        let firstRow = app.buttons.containing(rowPredicate).firstMatch
        guard firstRow.waitForExistence(timeout: 15) else {
            throw XCTSkip("The seeded mechanic has no dispatched work orders on the real backend; nothing to open.")
        }

        firstRow.tap()

        // Detail sheet renders with its real controls.
        let detail = app.otherElements[AID.detailView]
        XCTAssertTrue(detail.waitForExistence(timeout: 10), "Work-order detail should open.")

        let startWork = app.buttons[AID.detailStartWorkButton]
        XCTAssertTrue(startWork.waitForExistence(timeout: 5), "작업 시작 button should be present in detail.")
        XCTAssertTrue(app.buttons[AID.detailSubmitReportButton].exists, "보고 제출 button should be present.")
        XCTAssertTrue(app.buttons[AID.detailCaptureEvidenceButton].exists, "증빙 촬영 button should be present.")

        // Advance the work order for real (start work). The visible outcome is a
        // status message or a non-error detail state; we assert the action is
        // reachable and produces no login regression.
        startWork.tap()
        XCTAssertFalse(
            app.textFields[AID.loginUserIDField].waitForExistence(timeout: 2),
            "Advancing a work order must not drop the real session back to login."
        )

        // Close the detail via the real back control.
        let back = app.buttons[AID.detailBackButton]
        if back.exists { back.tap() }
        XCTAssertTrue(
            app.collectionViews[AID.todayList].waitForExistence(timeout: 10),
            "Closing detail should return to the dispatch list."
        )
    }

    func testReportFormValidationSurfacesRealRequiredCopy() throws {
        launchApp()
        waitForAuthenticatedShell()

        let rowPredicate = NSPredicate(format: "identifier BEGINSWITH %@", "today.workOrderRow.")
        let firstRow = app.buttons.containing(rowPredicate).firstMatch
        guard firstRow.waitForExistence(timeout: 15) else {
            throw XCTSkip("No dispatched work order to exercise the report form.")
        }
        firstRow.tap()
        XCTAssertTrue(app.otherElements[AID.detailView].waitForExistence(timeout: 10))

        // Submitting with empty diagnosis/action surfaces the real required-field
        // copy (error_required) — a genuine outcome of the production view model.
        app.buttons[AID.detailSubmitReportButton].tap()
        let message = app.staticTexts[AID.detailMessage]
        XCTAssertTrue(
            message.waitForExistence(timeout: 5),
            "Submitting an empty report should surface the required-field message."
        )
    }

    func testLocationConsentSectionIsPresentOnTheRealSession() {
        launchApp()
        waitForAuthenticatedShell()
        // The GPS consent section header renders in Korean on the Today tab.
        XCTAssertTrue(
            app.staticTexts[KO.locationConsentTitle].waitForExistence(timeout: 15),
            "GPS 위치 동의 section should render for the authenticated mechanic."
        )
    }
}
