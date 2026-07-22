import XCTest

/// Field mechanic critical path against the real isolated backend and a session
/// restored by the production Keychain path. CI-only.
final class FieldCriticalPathUITests: FieldUITestCase {
    func testAuthenticatedLaunchShowsTodayTabInKorean() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        XCTAssertTrue(app.staticTexts[KO.todayTitle].waitForExistence(timeout: 10), "Today tab title 오늘 작업 should be visible after real-session restore.")
        XCTAssertFalse(app.textFields[AID.loginUserIDField].exists, "Login field must not be present once the real session is restored.")
    }

    func testDispatchListRendersDeterministicMechanicWorkOrder() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        XCTAssertTrue(app.collectionViews[AID.todayList].waitForExistence(timeout: 15), "Dispatch list should render.")
        let fixtureID = try UITestFixture.requiredID(UITestFixture.detailWorkOrderID)
        let fixtureRow = app.buttons[AID.workOrderRow(fixtureID)]
        XCTAssertTrue(fixtureRow.waitForExistence(timeout: 15), "Dispatch tab must render the deterministic mechanic fixture; an empty state is a failed seed or API result, not a valid CI outcome.")
    }

    func testOpenWorkOrderDetailAndAdvance() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.startWorkOrderID)

        let startWork = app.buttons[AID.detailStartWorkButton]
        XCTAssertTrue(startWork.waitForExistence(timeout: 5), "작업 시작 button should be present in detail.")
        XCTAssertTrue(app.buttons[AID.detailSubmitReportButton].exists, "보고 제출 button should be present.")
        XCTAssertTrue(app.buttons[AID.detailCaptureEvidenceButton].exists, "증빙 촬영 button should be present.")
        startWork.tap()

        // A successful mutation must be observable in the rendered detail,
        // not inferred from still being authenticated or from another IN_PROGRESS
        // row behind the sheet. The isolated fixture is seeded as assigned; the
        // production API transitions this exact detail to 진행 중.
        let detailStatus = app.descendants(matching: .any)[AID.detailStatus]
        XCTAssertTrue(
            detailStatus.waitForExistence(timeout: 15),
            "The selected detail must expose its status through the stable detail.status identifier."
        )
        XCTAssertEqual(
            detailStatus.label,
            KO.inProgress,
            "Starting the deterministic work order must visibly transition it to 진행 중."
        )
        XCTAssertFalse(
            app.staticTexts[AID.detailMessage].exists || app.staticTexts[KO.operationFailed].exists,
            "Starting work must not settle in the visible failure state."
        )
        XCTAssertFalse(app.textFields[AID.loginUserIDField].exists, "Advancing a work order must not drop the real session back to login.")

        let back = app.buttons[AID.detailBackButton]
        XCTAssertTrue(back.waitForExistence(timeout: 5), "Detail must expose a back control.")
        back.tap()
        XCTAssertTrue(app.collectionViews[AID.todayList].waitForExistence(timeout: 10), "Closing detail should return to the dispatch list.")
    }

    func testReportFormValidationSurfacesRealRequiredCopy() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.reportWorkOrderID)
        app.buttons[AID.detailSubmitReportButton].tap()
        XCTAssertTrue(
            app.staticTexts[KO.requiredField].waitForExistence(timeout: 5),
            "Submitting an empty report must render the exact required-field validation copy."
        )
        XCTAssertFalse(
            app.staticTexts[KO.operationFailed].exists,
            "Required-field validation must not collapse into the generic operation failure."
        )
    }

    func testReportSubmissionPersistsVisibleTerminalOutcome() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.reportSuccessWorkOrderID)

        let diagnosis = app.textFields[AID.detailDiagnosisField]
        XCTAssertTrue(diagnosis.waitForExistence(timeout: 5), "Report diagnosis field should be present in detail.")
        diagnosis.tap()
        diagnosis.typeText("iOS UI 보고 성공 진단")

        let actionTaken = app.textFields[AID.detailActionTakenField]
        XCTAssertTrue(actionTaken.waitForExistence(timeout: 5), "Report action field should be present in detail.")
        actionTaken.tap()
        actionTaken.typeText("iOS UI 보고 성공 조치")

        app.buttons[AID.detailSubmitReportButton].tap()

        XCTAssertTrue(
            app.staticTexts[KO.reportSuccessMessage].waitForExistence(timeout: 15),
            "Submitting the isolated report fixture must prove the live API success response."
        )
        XCTAssertTrue(
            app.staticTexts[KO.reportSubmitted].waitForExistence(timeout: 15),
            "Submitting the isolated report fixture must visibly persist the 보고 완료 terminal outcome."
        )
        XCTAssertFalse(
            app.staticTexts[KO.operationFailed].exists,
            "A successfully persisted report must not settle in the generic operation failure state."
        )
    }

    func testLocationConsentTransitionsPersistThroughTheRealBackend() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.detailWorkOrderID)
        XCTAssertTrue(app.staticTexts[KO.locationConsentTitle].waitForExistence(timeout: 15), "GPS 위치 동의 section should render for the authenticated mechanic.")

        let grant = app.buttons[AID.locationConsentGrantButton]
        let suspend = app.buttons[AID.locationConsentSuspendButton]
        let resume = app.buttons[AID.locationConsentResumeButton]
        let withdraw = app.buttons[AID.locationConsentWithdrawButton]
        XCTAssertTrue(grant.waitForExistence(timeout: 5), "Location-consent controls must render.")
        XCTAssertTrue(app.staticTexts[KO.locationConsentNoRecord].exists, "The isolated backend must begin without a consent record.")
        XCTAssertTrue(app.staticTexts[KO.no].exists, "No-record consent must prohibit GPS collection.")
        XCTAssertTrue(grant.isEnabled)
        XCTAssertFalse(suspend.isEnabled)
        XCTAssertFalse(resume.isEnabled)
        XCTAssertFalse(withdraw.isEnabled)

        grant.tap()
        XCTAssertTrue(app.staticTexts[KO.locationConsentGranted].waitForExistence(timeout: 15), "Grant must persist the consented state through the real API.")
        XCTAssertTrue(app.staticTexts[KO.yes].exists, "Granted consent must permit GPS collection.")
        XCTAssertFalse(grant.isEnabled)
        XCTAssertTrue(suspend.isEnabled)
        XCTAssertFalse(resume.isEnabled)
        XCTAssertTrue(withdraw.isEnabled)

        // Discard all in-memory reducer state and prove GET status readback from
        // a newly launched app before continuing the state machine.
        app.terminate()
        _ = try await launchApp()
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.detailWorkOrderID)
        XCTAssertTrue(
            app.staticTexts[KO.locationConsentGranted].waitForExistence(timeout: 15),
            "A fresh app launch must read the granted state back from the backend."
        )
        XCTAssertTrue(app.staticTexts[KO.yes].exists, "Persisted granted consent must permit GPS collection after relaunch.")

        let reloadedSuspend = app.buttons[AID.locationConsentSuspendButton]
        let reloadedResume = app.buttons[AID.locationConsentResumeButton]
        let reloadedWithdraw = app.buttons[AID.locationConsentWithdrawButton]
        reloadedSuspend.tap()
        XCTAssertTrue(app.staticTexts[KO.locationConsentSuspended].waitForExistence(timeout: 15), "Suspend must persist the GPS-off state through the real API.")
        XCTAssertTrue(app.staticTexts[KO.no].exists, "Suspended consent must prohibit GPS collection.")
        XCTAssertFalse(app.buttons[AID.locationConsentGrantButton].isEnabled)
        XCTAssertFalse(reloadedSuspend.isEnabled)
        XCTAssertTrue(reloadedResume.isEnabled)
        XCTAssertTrue(reloadedWithdraw.isEnabled)

        reloadedResume.tap()
        XCTAssertTrue(app.staticTexts[KO.locationConsentGranted].waitForExistence(timeout: 15), "Resume must restore the consented state through the real API.")
        XCTAssertTrue(app.staticTexts[KO.yes].exists, "Resumed consent must permit GPS collection.")

        reloadedWithdraw.tap()
        XCTAssertTrue(app.staticTexts[KO.locationConsentWithdrawn].waitForExistence(timeout: 15), "Withdraw must persist the terminal revoked state through the real API.")
        XCTAssertTrue(app.staticTexts[KO.no].exists, "Withdrawn consent must prohibit GPS collection.")
        XCTAssertTrue(app.buttons[AID.locationConsentGrantButton].isEnabled)
        XCTAssertFalse(reloadedSuspend.isEnabled)
        XCTAssertFalse(reloadedResume.isEnabled)
        XCTAssertFalse(reloadedWithdraw.isEnabled)
        XCTAssertFalse(app.staticTexts[KO.operationFailed].exists, "Every consent transition must complete without a visible failure state.")

        app.terminate()
        _ = try await launchApp()
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.detailWorkOrderID)
        XCTAssertTrue(
            app.staticTexts[KO.locationConsentWithdrawn].waitForExistence(timeout: 15),
            "A fresh app launch must read the withdrawn terminal state back from the backend."
        )
        XCTAssertTrue(app.staticTexts[KO.no].exists, "Persisted withdrawn consent must prohibit GPS collection after relaunch.")
        XCTAssertFalse(app.staticTexts[KO.operationFailed].exists)
    }
}
