import XCTest

/// Signed-out login-screen behavior. This is the one automatable slice of the
/// auth surface: the client-side validation the production view model performs
/// BEFORE the passkey ceremony (the ceremony itself is the manual smoke). No
/// session is seeded here — the app starts at the real login form.
///
/// CI-ONLY.
@MainActor
final class LoginValidationUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        // Ensure no seeded session lingers from another spec on the same host.
        RealSessionSeed.clear()
        app = XCUIApplication()
        app.launch()
    }

    override func tearDown() {
        app = nil
        super.tearDown()
    }

    func testLoginFormRendersInKorean() {
        XCTAssertTrue(
            app.staticTexts[KO.loginTitle].waitForExistence(timeout: 15),
            "패스키 로그인 title should render on the signed-out launch."
        )
        XCTAssertTrue(
            app.textFields[AID.loginUserIDField].exists,
            "The user-id field should be present."
        )
        XCTAssertTrue(
            app.buttons[AID.loginButton].exists,
            "The 로그인 button should be present."
        )
    }

    func testInvalidUserIDSurfacesRealValidationCopy() {
        let field = app.textFields[AID.loginUserIDField]
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        field.typeText("not-a-uuid")
        app.buttons[AID.loginButton].tap()

        // The production view model rejects a non-UUID id with error_invalid_user_id
        // BEFORE any network/passkey work — a real, automatable outcome.
        XCTAssertTrue(
            app.staticTexts[AID.loginErrorMessage].waitForExistence(timeout: 5)
                || app.staticTexts[KO.errorInvalidUserID].waitForExistence(timeout: 1),
            "An invalid user id should surface 올바른 사용자 ID 형식이 아닙니다."
        )
    }
}
