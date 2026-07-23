import XCTest

/// Field mechanic critical path against the real isolated backend and a session
/// restored by the production Keychain path. CI-only.
final class FieldCriticalPathUITests: FieldUITestCase {
    func testAuthenticatedLaunchShowsTodayTabInKorean() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        XCTAssertTrue(app.tabBars.buttons[KO.todayTitle].waitForExistence(timeout: 10), "Today tab button 오늘 작업 should be visible after real-session restore.")
        XCTAssertFalse(app.textFields[AID.loginUserIDField].exists, "Login field must not be present once the real session is restored.")
    }

    func testDispatchListRendersDeterministicMechanicWorkOrder() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        XCTAssertTrue(app.collectionViews[AID.todayList].waitForExistence(timeout: 15), "Dispatch list should render.")
        let fixtureID = try UITestFixture.requiredID(UITestFixture.detailWorkOrderID)
        XCTAssertNotNil(
            scrollToWorkOrderRow(in: app, id: fixtureID, timeout: 15),
            "Dispatch tab must render the deterministic mechanic fixture; an empty state is a failed seed or API result, not a valid CI outcome."
        )
    }

    func testFullFixtureRowsRemainReachableAboveTabBar() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        assertTodayListEndsAtOrAboveTabBar(in: app)

        let list = app.collectionViews[AID.todayList]
        let fixtureKeys = [
            UITestFixture.startWorkOrderID,
            UITestFixture.reportWorkOrderID,
            UITestFixture.reportSuccessWorkOrderID,
            UITestFixture.adminApproveWorkOrderID,
            UITestFixture.adminRejectWorkOrderID,
        ]
        for fixtureKey in fixtureKeys {
            let fixtureID = try UITestFixture.requiredID(fixtureKey)
            guard let row = scrollToWorkOrderRow(in: app, id: fixtureID, timeout: 30) else {
                XCTFail("Full functional fixture row \(fixtureID) must be reachable above tab-bar chrome.")
                continue
            }
            XCTAssertNotNil(
                workOrderRowActivationPoint(in: app, row: row, list: list),
                "Full functional fixture row \(fixtureID) must expose a safe activation point."
            )
        }
    }

    func testOpenWorkOrderDetailAndAdvance() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.startWorkOrderID)

        guard let startWork = scrollToDetailElement(app.buttons[AID.detailStartWorkButton]) else {
            XCTFail("작업 시작 button should be reachable in the lazy detail form.")
            return
        }
        startWork.tap()

        // A successful mutation must be observable in the rendered detail,
        // not inferred from still being authenticated or from another IN_PROGRESS
        // row behind the sheet. The isolated fixture is seeded as assigned; the
        // production API transitions this exact detail to 진행 중.
        let detailStatus = app.descendants(matching: .any)[AID.detailStatus]
        guard detailStatus.waitForExistence(timeout: 15) else {
            XCTFail("The selected detail must expose its status through the stable detail.status identifier.")
            return
        }
        XCTAssertTrue(
            detailStatus.exists,
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
        guard let submit = scrollToDetailElement(app.buttons[AID.detailSubmitReportButton]) else {
            XCTFail("보고 제출 button should be reachable in the lazy detail form.")
            return
        }
        submit.tap()
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

        guard let diagnosis = scrollToDetailElement(app.textFields[AID.detailDiagnosisField]) else {
            XCTFail("Report diagnosis field should be reachable in detail.")
            return
        }
        diagnosis.tap()
        diagnosis.typeText("iOS UI 보고 성공 진단\n")

        guard let actionTaken = scrollToDetailElement(app.textFields[AID.detailActionTakenField]) else {
            XCTFail("Report action field should be reachable in detail.")
            return
        }
        actionTaken.tap()
        actionTaken.typeText("iOS UI 보고 성공 조치\n")

        guard let submit = scrollToDetailElement(app.buttons[AID.detailSubmitReportButton]) else {
            XCTFail("보고 제출 button should remain reachable after completing the report fields.")
            return
        }
        submit.tap()

        XCTAssertNotNil(
            scrollToDetailElement(app.staticTexts[KO.reportSuccessMessage], timeout: 15),
            "Submitting the isolated report fixture must prove the live API success response."
        )
        XCTAssertNotNil(
            scrollToDetailElement(app.staticTexts[KO.reportSubmitted], timeout: 15),
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
        let detail = app.collectionViews[AID.detailView]
        XCTAssertTrue(detail.staticTexts[KO.locationConsentTitle].waitForExistence(timeout: 15), "GPS 위치 동의 section should render for the authenticated mechanic.")

        let grant = detail.buttons[AID.locationConsentGrantButton]
        let suspend = detail.buttons[AID.locationConsentSuspendButton]
        let resume = detail.buttons[AID.locationConsentResumeButton]
        let withdraw = detail.buttons[AID.locationConsentWithdrawButton]
        let stateValue = detail.descendants(matching: .any)[AID.locationConsentStateValue]
        let collectionValue = detail.descendants(matching: .any)[AID.locationConsentCollectionValue]
        XCTAssertTrue(grant.waitForExistence(timeout: 5), "Location-consent controls must render.")
        XCTAssertTrue(waitForLabel(stateValue, containing: KO.locationConsentNoRecord), "The isolated backend must begin without a consent record.")
        XCTAssertTrue(waitForLabel(collectionValue, containing: KO.no), "No-record consent must prohibit GPS collection.")
        XCTAssertTrue(grant.isEnabled)
        XCTAssertFalse(suspend.exists)
        XCTAssertFalse(resume.exists)
        XCTAssertFalse(withdraw.exists)

        grant.tap()
        XCTAssertTrue(waitForLabel(stateValue, containing: KO.locationConsentGranted), "Grant must persist the consented state through the real API.")
        XCTAssertTrue(waitForLabel(collectionValue, containing: KO.yes), "Granted consent must permit GPS collection.")
        XCTAssertFalse(grant.exists)
        XCTAssertTrue(suspend.isEnabled)
        XCTAssertFalse(resume.exists)
        XCTAssertTrue(withdraw.isEnabled)

        // Discard all in-memory reducer state and prove GET status readback from
        // a newly launched app before continuing the state machine.
        app.terminate()
        _ = try await launchApp()
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.detailWorkOrderID)
        let reloadedDetail = app.collectionViews[AID.detailView]
        let reloadedStateValue = reloadedDetail.descendants(matching: .any)[AID.locationConsentStateValue]
        let reloadedCollectionValue = reloadedDetail.descendants(matching: .any)[AID.locationConsentCollectionValue]
        XCTAssertTrue(
            waitForLabel(reloadedStateValue, containing: KO.locationConsentGranted),
            "A fresh app launch must read the granted state back from the backend."
        )
        XCTAssertTrue(waitForLabel(reloadedCollectionValue, containing: KO.yes), "Persisted granted consent must permit GPS collection after relaunch.")

        let reloadedSuspend = reloadedDetail.buttons[AID.locationConsentSuspendButton]
        let reloadedResume = reloadedDetail.buttons[AID.locationConsentResumeButton]
        let reloadedWithdraw = reloadedDetail.buttons[AID.locationConsentWithdrawButton]
        reloadedSuspend.tap()
        XCTAssertTrue(waitForLabel(reloadedStateValue, containing: KO.locationConsentSuspended), "Suspend must persist the GPS-off state through the real API.")
        XCTAssertTrue(waitForLabel(reloadedCollectionValue, containing: KO.no), "Suspended consent must prohibit GPS collection.")
        XCTAssertFalse(reloadedDetail.buttons[AID.locationConsentGrantButton].exists)
        XCTAssertFalse(reloadedSuspend.exists)
        XCTAssertTrue(reloadedResume.isEnabled)
        XCTAssertTrue(reloadedWithdraw.isEnabled)

        reloadedResume.tap()
        XCTAssertTrue(waitForLabel(reloadedStateValue, containing: KO.locationConsentGranted), "Resume must restore the consented state through the real API.")
        XCTAssertTrue(waitForLabel(reloadedCollectionValue, containing: KO.yes), "Resumed consent must permit GPS collection.")

        reloadedWithdraw.tap()
        XCTAssertTrue(waitForLabel(reloadedStateValue, containing: KO.locationConsentWithdrawn), "Withdraw must persist the terminal revoked state through the real API.")
        XCTAssertTrue(waitForLabel(reloadedCollectionValue, containing: KO.no), "Withdrawn consent must prohibit GPS collection.")
        XCTAssertTrue(reloadedDetail.buttons[AID.locationConsentGrantButton].isEnabled)
        XCTAssertFalse(reloadedSuspend.exists)
        XCTAssertFalse(reloadedResume.exists)
        XCTAssertFalse(reloadedWithdraw.exists)
        XCTAssertFalse(app.staticTexts[KO.operationFailed].exists, "Every consent transition must complete without a visible failure state.")

        app.terminate()
        _ = try await launchApp()
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.detailWorkOrderID)
        let terminalDetail = app.collectionViews[AID.detailView]
        let terminalStateValue = terminalDetail.descendants(matching: .any)[AID.locationConsentStateValue]
        let terminalCollectionValue = terminalDetail.descendants(matching: .any)[AID.locationConsentCollectionValue]
        XCTAssertTrue(
            waitForLabel(terminalStateValue, containing: KO.locationConsentWithdrawn),
            "A fresh app launch must read the withdrawn terminal state back from the backend."
        )
        XCTAssertTrue(waitForLabel(terminalCollectionValue, containing: KO.no), "Persisted withdrawn consent must prohibit GPS collection after relaunch.")
        XCTAssertFalse(app.staticTexts[KO.operationFailed].exists)
    }
}
