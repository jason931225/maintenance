import XCTest

/// Host-side `check-ios-ui-test-fail-closed.mjs` compares the production and
/// UITest identifier enums directly. XCTest cannot import the app module, so a
/// test-local literal allowlist would only compare two independently maintained
/// copies rather than prove parity.
final class FieldAccessibilityIDParityTests: XCTestCase {
}

extension FieldAccessibilityIDParityTests {
    func testHermeticRunnerConfigurationRequiresMintedPairAndNamedFixtures() throws {
        let environment = [
            "MNT_UITEST_BASE_URL": "http://127.0.0.1:48123",
            "MNT_UITEST_ACCESS_TOKEN": "real-access-token",
            "MNT_UITEST_REFRESH_TOKEN": "real-refresh-token",
            UITestFixture.detailWorkOrderID: "00000000-0000-0000-0000-000000000001",
            UITestFixture.startWorkOrderID: "00000000-0000-0000-0000-000000000002",
            UITestFixture.reportWorkOrderID: "00000000-0000-0000-0000-000000000003",
            UITestFixture.reportSuccessWorkOrderID: "00000000-0000-0000-0000-000000000004",
            UITestFixture.cameraWorkOrderID: "00000000-0000-0000-0000-000000000005",
            UITestFixture.messengerThreadID: "00000000-0000-0000-0000-000000000006",
            UITestFixture.messengerInitialMessageID: "00000000-0000-0000-0000-000000000007",
        ]

        XCTAssertEqual(try RealBackendSession.baseURL(environment: environment), "http://127.0.0.1:48123")
        XCTAssertEqual(try RealBackendSession.tokens(environment: environment).accessToken, "real-access-token")
        XCTAssertEqual(try RealBackendSession.tokens(environment: environment).refreshToken, "real-refresh-token")
        for key in [
            UITestFixture.detailWorkOrderID,
            UITestFixture.startWorkOrderID,
            UITestFixture.reportWorkOrderID,
            UITestFixture.reportSuccessWorkOrderID,
            UITestFixture.cameraWorkOrderID,
        ] {
            XCTAssertFalse(try UITestFixture.requiredID(key, environment: environment).isEmpty)
        }
        XCTAssertFalse(try UITestFixture.requiredID(UITestFixture.messengerThreadID, environment: environment).isEmpty)
        XCTAssertFalse(try UITestFixture.requiredID(UITestFixture.messengerInitialMessageID, environment: environment).isEmpty)

        XCTAssertThrowsError(try RealBackendSession.tokens(environment: [:]))
        XCTAssertThrowsError(try UITestFixture.requiredID(UITestFixture.cameraWorkOrderID, environment: [:]))
        XCTAssertThrowsError(try UITestFixture.requiredID(UITestFixture.messengerThreadID, environment: [:]))
    }
}
