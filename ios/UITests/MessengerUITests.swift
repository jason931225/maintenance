import XCTest

/// Messaging flow, driven against the real session + real backend. Covers the
/// thread list, the empty/select states, search, and the composer — the field
/// mechanic's day-to-day communication surface.
///
/// CI-ONLY (see `FieldCriticalPathUITests` for the why).
@MainActor
final class MessengerUITests: FieldUITestCase {
    private func openMessengerTab() {
        launchApp()
        waitForAuthenticatedShell()
        // The Messenger tab item carries the Korean label 메신저.
        XCTAssertTrue(tapTab(KO.messengerTitle), "Messenger tab 메신저 should be tappable.")
    }

    func testMessengerTabRendersThreadsOrRealEmptyState() {
        openMessengerTab()

        XCTAssertTrue(
            app.staticTexts[KO.messengerTitle].waitForExistence(timeout: 10),
            "메신저 title should render."
        )

        let threadPredicate = NSPredicate(format: "identifier BEGINSWITH %@", "messenger.threadRow.")
        let hasThreads = app.buttons.containing(threadPredicate).firstMatch.waitForExistence(timeout: 10)
        let hasEmpty = app.staticTexts[AID.messengerEmptyThreads].exists
            || app.staticTexts[KO.messengerEmptyThreads].exists
        XCTAssertTrue(
            hasThreads || hasEmpty,
            "Messenger must show real threads or the empty-state 표시할 대화방이 없습니다."
        )
    }

    func testSelectThreadPromptOrSelectionIsConsistent() {
        openMessengerTab()

        let threadPredicate = NSPredicate(format: "identifier BEGINSWITH %@", "messenger.threadRow.")
        let firstThread = app.buttons.containing(threadPredicate).firstMatch
        if firstThread.waitForExistence(timeout: 10) {
            firstThread.tap()
            // After selecting a real thread, the composer becomes available.
            XCTAssertTrue(
                app.textViews[AID.messengerComposerField].waitForExistence(timeout: 10)
                    || app.textFields[AID.messengerComposerField].waitForExistence(timeout: 1),
                "Selecting a real thread should reveal the composer."
            )
        } else {
            // No threads: the select-thread prompt must be shown.
            XCTAssertTrue(
                app.staticTexts[AID.messengerSelectThreadPrompt].exists
                    || app.staticTexts[KO.messengerSelectThread].exists,
                "With no thread selected the prompt 대화방을 선택하세요. should render."
            )
        }
    }

    func testMessengerSearchEmptyQueryShowsRealNoResultsOrClears() {
        openMessengerTab()

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
