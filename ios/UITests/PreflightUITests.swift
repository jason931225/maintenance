import XCTest

/// Anti-false-green guard. The post-login suite seeds a real session in `setUp`
/// and `XCTSkip`s when no real session source / shared keychain group is
/// available — correct for local and fork runs, but it means an all-skipped run
/// looks green. This preflight FAILS (does not skip) when CI explicitly requires
/// the real suite to run, so a misconfigured CI job (missing secrets, dropped
/// entitlement, signing regression) can never pass silently.
///
/// Gate: only enforced when `MNT_UITEST_REQUIRE_REAL=1` is set (CI sets it for
/// push/protected contexts where the real suite must execute). Without the flag
/// this test no-ops, so local/PR runs without secrets stay green.
final class PreflightUITests: XCTestCase {
    private var requireReal: Bool {
        ProcessInfo.processInfo.environment["MNT_UITEST_REQUIRE_REAL"] == "1"
    }

    func testRealSessionSourceIsConfiguredWhenRequired() async throws {
        guard requireReal else {
            throw XCTSkip("MNT_UITEST_REQUIRE_REAL not set; real-suite enforcement is off for this run.")
        }
        // Must obtain a real backend token pair — throws (fails) if unconfigured.
        let tokens = try await RealBackendSession.fetch()
        XCTAssertFalse(tokens.accessToken.isEmpty, "Real access token must be non-empty.")
        XCTAssertFalse(tokens.refreshToken.isEmpty, "Real refresh token must be non-empty.")
    }

    func testSharedKeychainGroupIsGrantedWhenRequired() throws {
        guard requireReal else {
            throw XCTSkip("MNT_UITEST_REQUIRE_REAL not set; keychain-group enforcement is off for this run.")
        }
        // The build must be entitled to the shared group, or cross-process
        // seeding is impossible and the whole suite would silently skip.
        let group = RealSessionSeed.resolvedAccessGroup()
        XCTAssertNotNil(
            group,
            """
            No shared keychain access group was granted. The Simulator build must be ad-hoc \
            signed with Config/MaintenanceFieldUITests.entitlements so the real session can be \
            seeded. Without it the entire post-login suite skips and verifies nothing.
            """
        )
    }
}
