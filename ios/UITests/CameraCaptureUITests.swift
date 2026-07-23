import XCTest

/// Camera-capture UI states reached from the deterministic seeded work order.
/// CI-only.
final class CameraCaptureUITests: FieldUITestCase {
    func testCaptureSheetPresentsAGracefulRealStateOnSimulator() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.cameraWorkOrderID)

        guard let capture = scrollToDetailElement(app.buttons[AID.detailCaptureEvidenceButton]) else {
            XCTFail("증빙 촬영 button should be reachable in the lazy detail form.")
            return
        }

        // Resolve the one-time system prompt into the same explicit denied
        // terminal state asserted below. The monitor is only input handling;
        // it is never counted as a successful camera outcome.
        let permissionMonitor = addUIInterruptionMonitor(withDescription: "Camera permission") { alert in
            for label in ["Don’t Allow", "Don't Allow", "허용 안 함", "허용하지 않음"] {
                let deny = alert.buttons[label]
                if deny.exists {
                    deny.tap()
                    return true
                }
            }
            return false
        }
        defer { removeUIInterruptionMonitor(permissionMonitor) }

        capture.tap()
        app.tap()

        // The Simulator can deterministically reach either a camera preview or
        // a denied/unavailable state. Permission-requesting/progress UI is
        // deliberately not a terminal success: it has no usable escape path.
        let denied = app.staticTexts[AID.cameraPermissionDenied]
        let shutter = app.buttons[AID.cameraShutterButton]
        let cancel = app.buttons[AID.cameraCancelButton]
        let unavailable = app.staticTexts[AID.cameraUnavailable]

        var reachedTerminalState = false
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            let previewIsUsable = shutter.exists && cancel.exists
            let deniedIsEscapable = denied.exists && cancel.exists
            let unavailableIsEscapable = unavailable.exists && cancel.exists
            if previewIsUsable {
                reachedTerminalState = true
                break
            }
            if deniedIsEscapable || unavailableIsEscapable {
                reachedTerminalState = true
                break
            }
            try await Task.sleep(for: .milliseconds(200))
        }

        guard reachedTerminalState else {
            XCTFail(
                "Camera capture must reach a bounded usable terminal state: preview with shutter+cancel, or denied/unavailable with cancel."
            )
            return
        }

        cancel.tap()
        XCTAssertFalse(
            cancel.waitForExistence(timeout: 5),
            "Cancelling any usable camera terminal state must dismiss the camera sheet."
        )
        XCTAssertFalse(
            denied.exists || unavailable.exists || shutter.exists,
            "No camera terminal controls should remain after cancelling the camera sheet."
        )
    }
}
