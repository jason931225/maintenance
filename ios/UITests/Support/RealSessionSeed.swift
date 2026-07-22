import Foundation
import XCTest

/// Drives the repository-owned seeder app that owns the app's production
/// Keychain entitlement.  UI-test code deliberately never calls Keychain
/// Services: the XCTest runner is a different process and must not become an
/// alternate privileged session writer.
///
/// The protocol is intentionally small and fail-closed:
/// - launch the dedicated app by its fixed bundle identifier;
/// - provide an action and a fresh nonce (and token pair for `seed`);
/// - accept only the stable status element whose accessibility label is the
///   exact action-specific nonce result;
/// - terminate the seeder on every outcome.
///
/// Tokens are passed only through the launch environment and are never placed
/// in an assertion, error, or log message.
enum RealSessionSeed {
    enum SeedError: Error, LocalizedError {
        case missingSeederResult
        case resultNonceMismatch
        case seederReportedError
        case unexpectedSeederResult

        var errorDescription: String? {
            switch self {
            case .missingSeederResult:
                return "The UI-test session seeder did not report a completion result."
            case .resultNonceMismatch:
                return "The UI-test session seeder completion result did not match this request nonce."
            case .seederReportedError:
                return "The UI-test session seeder reported an error."
            case .unexpectedSeederResult:
                return "The UI-test session seeder reported an unrecognized completion result."
            }
        }
    }

    /// The helper is a repository-owned app target, deliberately separate from
    /// the UI-test runner. Its identifier is a test-only sibling of the real
    /// app's bundle identifier, not a workflow-provided value.
    static let seederBundleIdentifier = "com.maintenance.field.UITestSeeder"

    private enum EnvironmentKey {
        static let action = "MNT_UITEST_SEED_ACTION"
        static let nonce = "MNT_UITEST_SEED_NONCE"
        static let accessToken = "MNT_UITEST_ACCESS_TOKEN"
        static let refreshToken = "MNT_UITEST_REFRESH_TOKEN"
    }

    private enum Action: String {
        case seed
        case clear
    }

    /// A stable identifier is essential: the nonce is carried in the element's
    /// label so every operation is bound to its own completion, rather than to
    /// a stale success view left behind by another launch.
    private static let statusAccessibilityIdentifier = "uitestSeeder.status"

    static func seed(_ tokens: RealBackendSession.TokenPair) throws {
        try perform(.seed, tokens: tokens)
    }

    static func clear() throws {
        try perform(.clear, tokens: nil)
    }

    private static func perform(_ action: Action, tokens: RealBackendSession.TokenPair?) throws {
        let nonce = UUID().uuidString.lowercased()
        let seeder = XCUIApplication(bundleIdentifier: seederBundleIdentifier)
        seeder.launchEnvironment[EnvironmentKey.action] = action.rawValue
        seeder.launchEnvironment[EnvironmentKey.nonce] = nonce
        if let tokens {
            seeder.launchEnvironment[EnvironmentKey.accessToken] = tokens.accessToken
            seeder.launchEnvironment[EnvironmentKey.refreshToken] = tokens.refreshToken
        }

        defer { seeder.terminate() }
        seeder.launch()

        let status = seeder.staticTexts[statusAccessibilityIdentifier]
        guard status.waitForExistence(timeout: 15) else {
            throw SeedError.missingSeederResult
        }
        let expected = "\(action == .seed ? "seeded" : "cleared"):\(nonce)"
        switch status.label {
        case expected:
            return
        case "error:\(nonce)":
            throw SeedError.seederReportedError
        default:
            if status.label.hasSuffix(":\(nonce)") {
                throw SeedError.unexpectedSeederResult
            }
            throw SeedError.resultNonceMismatch
        }
    }
}
