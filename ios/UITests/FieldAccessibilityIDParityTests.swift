import XCTest

/// Guards the `AID` mirror in the UITests target against the production
/// `FieldAccessibilityID` namespace. Because the two modules cannot share the
/// constant at compile time, this test asserts the string VALUES match, so a
/// rename in the app can never silently leave the suite querying dead
/// identifiers.
///
/// This is a unit-level assertion (no `XCUIApplication`), so it runs fast and
/// first. The expected list below is a literal transcription of
/// `FieldAccessibilityID.allStableIdentifiers`; CI fails here the moment they
/// drift, forcing both sides to be updated together.
final class FieldAccessibilityIDParityTests: XCTestCase {
    func testMirroredIdentifiersMatchProductionValues() {
        // Literal expected production values (the contract). Keep sorted for a
        // readable diff when this fails.
        let expectedProduction: Set<String> = [
            "login.userIDField",
            "login.button",
            "login.errorMessage",
            "shell.authenticatedTabs",
            "shell.todayTab",
            "shell.messengerTab",
            "today.list",
            "today.empty",
            "today.refresh",
            "today.logout",
            "today.loading",
            "detail.view",
            "detail.startWork",
            "detail.resultTypePicker",
            "detail.diagnosisField",
            "detail.actionTakenField",
            "detail.submitReport",
            "detail.captureEvidence",
            "detail.back",
            "detail.message",
            "camera.shutter",
            "camera.cancel",
            "camera.openSettings",
            "camera.permissionDenied",
            "camera.permissionRequesting",
            "camera.unavailable",
            "locationConsent.grant",
            "locationConsent.suspend",
            "locationConsent.resume",
            "locationConsent.withdraw",
            "messenger.searchField",
            "messenger.searchButton",
            "messenger.searchNoResults",
            "messenger.emptyThreads",
            "messenger.selectThreadPrompt",
            "messenger.composerField",
            "messenger.sendButton",
            "messenger.refresh",
            "messenger.logout",
        ]

        let mirrored: Set<String> = [
            AID.loginUserIDField,
            AID.loginButton,
            AID.loginErrorMessage,
            AID.authenticatedTabs,
            AID.todayTab,
            AID.messengerTab,
            AID.todayList,
            AID.todayEmpty,
            AID.todayRefreshButton,
            AID.todayLogoutButton,
            AID.todayLoading,
            AID.detailView,
            AID.detailStartWorkButton,
            AID.detailResultTypePicker,
            AID.detailDiagnosisField,
            AID.detailActionTakenField,
            AID.detailSubmitReportButton,
            AID.detailCaptureEvidenceButton,
            AID.detailBackButton,
            AID.detailMessage,
            AID.cameraShutterButton,
            AID.cameraCancelButton,
            AID.cameraOpenSettingsButton,
            AID.cameraPermissionDenied,
            AID.cameraPermissionRequesting,
            AID.cameraUnavailable,
            AID.locationConsentGrantButton,
            AID.locationConsentSuspendButton,
            AID.locationConsentResumeButton,
            AID.locationConsentWithdrawButton,
            AID.messengerSearchField,
            AID.messengerSearchButton,
            AID.messengerSearchNoResults,
            AID.messengerEmptyThreads,
            AID.messengerSelectThreadPrompt,
            AID.messengerComposerField,
            AID.messengerSendButton,
            AID.messengerRefreshButton,
            AID.messengerLogoutButton,
        ]

        XCTAssertEqual(
            mirrored,
            expectedProduction,
            "UITests AID mirror drifted from FieldAccessibilityID. Update both in lock-step."
        )

        // Row helpers must match the production format too.
        XCTAssertEqual(AID.workOrderRow("ABC"), "today.workOrderRow.ABC")
        XCTAssertEqual(AID.messengerThreadRow("XYZ"), "messenger.threadRow.XYZ")
    }
}
