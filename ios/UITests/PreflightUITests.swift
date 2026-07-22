import XCTest

/// Fails before the post-login suite if workflow-provided session, local backend,
/// deterministic fixture, or shared-Keychain prerequisites are absent.
final class PreflightUITests: XCTestCase {
    func testWorkflowMintedSessionAndLocalBackendAreConfigured() throws {
        let baseURL = try RealBackendSession.baseURL()
        XCTAssertFalse(baseURL.isEmpty)
        let tokens = try RealBackendSession.tokens()
        XCTAssertFalse(tokens.accessToken.isEmpty, "Workflow-minted access token must be non-empty.")
        XCTAssertFalse(tokens.refreshToken.isEmpty, "Workflow-minted refresh token must be non-empty.")
    }

    func testDeterministicWorkOrderFixturesAreConfigured() throws {
        for key in [
            UITestFixture.detailWorkOrderID,
            UITestFixture.startWorkOrderID,
            UITestFixture.reportWorkOrderID,
            UITestFixture.reportSuccessWorkOrderID,
            UITestFixture.cameraWorkOrderID,
        ] {
            let workOrderID = try UITestFixture.requiredID(key)
            XCTAssertFalse(workOrderID.isEmpty, "Fixture \(key) must be non-empty.")
        }
        XCTAssertFalse(try UITestFixture.requiredID(UITestFixture.messengerThreadID).isEmpty)
        XCTAssertFalse(try UITestFixture.requiredID(UITestFixture.messengerInitialMessageID).isEmpty)
    }

    func testSharedKeychainGroupIsGranted() throws {
        XCTAssertNotNil(
            RealSessionSeed.resolvedAccessGroup(),
            "No shared keychain access group was granted. The Simulator build must carry the UITests shared-keychain entitlement."
        )
    }
}
