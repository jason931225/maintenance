import XCTest

/// The camera-capture screen's UI states. The capture sheet is presented from a
/// real work-order detail. On the Simulator there is no camera device, so the
/// real outcome is the permission/denied/unavailable branch — which is exactly a
/// UI state worth asserting (the field app must degrade gracefully when the
/// camera is unavailable or permission is refused).
///
/// CI-ONLY.
@MainActor
final class CameraCaptureUITests: FieldUITestCase {
    func testCaptureSheetPresentsAGracefulRealStateOnSimulator() throws {
        launchApp()
        waitForAuthenticatedShell()

        let rowPredicate = NSPredicate(format: "identifier BEGINSWITH %@", "today.workOrderRow.")
        let firstRow = app.buttons.containing(rowPredicate).firstMatch
        guard firstRow.waitForExistence(timeout: 15) else {
            throw XCTSkip("No dispatched work order to open the capture screen from.")
        }
        firstRow.tap()
        XCTAssertTrue(app.otherElements[AID.detailView].waitForExistence(timeout: 10))

        let capture = app.buttons[AID.detailCaptureEvidenceButton]
        XCTAssertTrue(capture.waitForExistence(timeout: 5), "증빙 촬영 button should be present.")
        capture.tap()

        // System camera-permission alert may appear first; allow it so we reach
        // the app's own state. (springboard alert handling.)
        addUIInterruptionMonitor(withDescription: "Camera permission") { alert in
            for label in ["OK", "확인", "Allow", "허용", "Don't Allow", "허용 안 함"] {
                let button = alert.buttons[label]
                if button.exists {
                    button.tap()
                    return true
                }
            }
            return false
        }
        app.tap() // trigger the interruption monitor

        // The capture screen must resolve to one of its real, defined states:
        // requesting permission, denied (with cancel/open-settings), the live
        // preview shutter, or the unavailable fallback — never a blank screen.
        let requesting = app.otherElements[AID.cameraPermissionRequesting]
        let progress = app.activityIndicators.firstMatch
        let denied = app.staticTexts[AID.cameraPermissionDenied]
        let deniedKO = app.staticTexts[KO.cameraPermissionDenied]
        let shutter = app.buttons[AID.cameraShutterButton]
        let cancel = app.buttons[AID.cameraCancelButton]
        let unavailable = app.staticTexts[AID.cameraUnavailable]

        let anyState = [requesting, progress, denied, deniedKO, shutter, cancel, unavailable]
            .contains { $0.waitForExistence(timeout: 10) }
        XCTAssertTrue(
            anyState,
            "The capture screen must present a defined camera state (requesting / denied / preview / unavailable)."
        )

        // If denied or unavailable, the user must always have a way out.
        if denied.exists || deniedKO.exists || unavailable.exists {
            XCTAssertTrue(
                app.buttons[AID.cameraCancelButton].exists || app.buttons[KO.cameraCancel].exists,
                "A non-capturing camera state must offer a cancel control."
            )
        }
    }
}
