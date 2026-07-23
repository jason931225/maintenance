import XCTest

/// Signed-out production login validation against the same local backend URL as
/// the authenticated suite. CI-only.
@MainActor
final class LoginValidationUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        try RealSessionSeed.clear()
        app = try XCUIApplication.fieldUITestApp()
        app.launch()
    }

    override func tearDownWithError() throws {
        app?.terminate()
        app = nil
        try super.tearDownWithError()
    }

    func testLoginFormRendersInKorean() {
        XCTAssertTrue(app.staticTexts[KO.loginTitle].waitForExistence(timeout: 15), "패스키 로그인 title should render on the signed-out launch.")
        XCTAssertTrue(app.textFields[AID.loginUserIDField].exists, "The user-id field should be present.")
        XCTAssertTrue(app.buttons[AID.loginButton].exists, "The 로그인 button should be present.")
    }

    func testInvalidUserIDSurfacesRealValidationCopy() {
        let field = app.textFields[AID.loginUserIDField]
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        field.typeText("123")
        app.buttons[AID.loginButton].tap()
        let loginError = app.staticTexts[AID.loginErrorMessage]
        XCTAssertTrue(
            loginError.waitForExistence(timeout: 10),
            "An invalid user id should surface 올바른 사용자 ID 형식이 아닙니다."
        )
        XCTAssertEqual(
            loginError.label,
            KO.errorInvalidUserID,
            "The validation identifier must carry the exact Korean invalid-user-id copy."
        )
    }
}
