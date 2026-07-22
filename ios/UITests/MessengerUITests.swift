import XCTest

/// Messaging flow, driven against the real session + real backend. Covers the
/// exact seeded thread, persisted messages, search, and composer — the field
/// mechanic's day-to-day communication surface. Empty/first-row fallbacks are
/// forbidden because this job owns a deterministic database.
///
/// CI-ONLY (see `FieldCriticalPathUITests` for the why).
final class MessengerUITests: FieldUITestCase {
    private let seededMessageBody = "iOS CI 초기 메시지"
    private let sentMessageBody = "iOS CI 메신저 전송 지속성"

    private func openMessengerTab() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        // The Messenger tab item carries the Korean label 메신저.
        XCTAssertTrue(tapTab(KO.messengerTitle), "Messenger tab 메신저 should be tappable.")
    }

    private func openSeededThread() async throws {
        try await openMessengerTab()
        XCTAssertTrue(
            app.staticTexts[KO.messengerTitle].waitForExistence(timeout: 10),
            "메신저 title should render."
        )
        let threadID = try UITestFixture.requiredID(UITestFixture.messengerThreadID)
        let thread = app.buttons[AID.messengerThreadRow(threadID)]
        XCTAssertTrue(thread.waitForExistence(timeout: 15), "The exact isolated messenger thread must render.")
        XCTAssertFalse(app.staticTexts[AID.messengerEmptyThreads].exists, "A seeded messenger fixture must never pass as an empty state.")
        thread.tap()
        let initialMessageID = try UITestFixture.requiredID(UITestFixture.messengerInitialMessageID)
        XCTAssertTrue(
            app.descendants(matching: .any)[AID.messengerMessageRow(initialMessageID)].waitForExistence(timeout: 10),
            "Selecting the exact thread must load the exact seeded message row."
        )
        XCTAssertTrue(app.staticTexts[seededMessageBody].exists, "The seeded message body must be visible after backend readback.")
    }

    func testExactSeededMessengerThreadAndMessageRender() async throws {
        try await openSeededThread()
        XCTAssertTrue(
            app.textViews[AID.messengerComposerField].exists
                || app.textFields[AID.messengerComposerField].exists,
            "Selecting the seeded thread must expose the composer."
        )
    }

    func testMessengerSendSurvivesBackendRefresh() async throws {
        try await openSeededThread()

        let textView = app.textViews[AID.messengerComposerField]
        let textField = app.textFields[AID.messengerComposerField]
        let composer = textView.exists ? textView : textField
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "Messenger composer must be available for the exact seeded thread.")
        composer.tap()
        composer.typeText(sentMessageBody)
        app.buttons[AID.messengerSendButton].tap()

        XCTAssertTrue(
            app.staticTexts[sentMessageBody].waitForExistence(timeout: 10),
            "A successful send must render the server-returned message."
        )
        XCTAssertFalse(
            app.staticTexts["오프라인 메시지로 저장되었습니다."].exists,
            "A queued offline fallback is not a successful persisted send."
        )

        // Kill the app to discard the reducer's locally merged message state,
        // then prove a brand-new view model reads the sent body from the backend.
        app.terminate()
        try await openSeededThread()
        XCTAssertTrue(
            app.staticTexts[sentMessageBody].waitForExistence(timeout: 10),
            "The sent message must be returned after a full app relaunch, proving backend persistence."
        )
        XCTAssertFalse(app.staticTexts[KO.operationFailed].exists, "Backend readback must not settle in a failure state.")
    }

    func testMessengerSearchUnmatchedQueryShowsRealNoResults() async throws {
        try await openMessengerTab()

        let search = app.textFields[AID.messengerSearchField]
        guard search.waitForExistence(timeout: 10) else {
            XCTFail("Messenger search field should be present.")
            return
        }
        search.tap()
        // A query unlikely to match seeds the real no-results path.
        search.typeText("zzzznoresultsq")
        app.buttons[AID.messengerSearchButton].tap()

        XCTAssertTrue(
            app.staticTexts[AID.messengerSearchNoResults].waitForExistence(timeout: 10)
                || app.staticTexts[KO.messengerSearchNoResults].exists,
            "An unmatched search should surface 검색 결과가 없습니다."
        )
    }
}
