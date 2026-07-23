import Foundation
import MaintenanceFieldCore
import SwiftUI

/// A small, separately signed app used only by the XCUITest bundle to prove that
/// session seeding crosses a real process boundary. It deliberately exposes no
/// UI beyond its machine-readable status: tokens are accepted only through its
/// launch environment and are never rendered or logged.
@main
struct MaintenanceFieldUITestSeederApp: App {
    var body: some Scene {
        WindowGroup {
            SeederStatusView()
        }
    }
}

private struct SeederStatusView: View {
    @State private var status: String?

    var body: some View {
        Group {
            if let status {
                Text(status)
                    .accessibilityIdentifier(SeederStatus.identifier)
            } else {
                ProgressView()
            }
        }
        .task {
            status = await SeederOperation.run(
                environment: ProcessInfo.processInfo.environment
            )
        }
    }
}

private enum SeederStatus {
    static let identifier = "uitestSeeder.status"
}

/// Parses the narrow launch-environment protocol and performs a real
/// KeychainSessionTokenStore operation. Every status is intentionally safe for
/// an XCUITest assertion: successful statuses bind the workflow nonce exactly,
/// and failures use fixed, non-secret categories only.
private enum SeederOperation {
    private static let actionKey = "MNT_UITEST_SEED_ACTION"
    private static let nonceKey = "MNT_UITEST_SEED_NONCE"
    private static let accessTokenKey = "MNT_UITEST_ACCESS_TOKEN"
    private static let refreshTokenKey = "MNT_UITEST_REFRESH_TOKEN"
    private static let sharedGroupSuffix = "com.maintenance.field.shared"

    private enum Action: String {
        case seed
        case clear
    }

    static func run(environment: [String: String]) async -> String {
        let suppliedNonce = environment[nonceKey] ?? ""
        guard isValidNonce(suppliedNonce) else {
            return "error:invalid"
        }
        let nonce = suppliedNonce
        guard
            let actionValue = environment[actionKey],
            let action = Action(rawValue: actionValue)
        else {
            return "error:\(nonce)"
        }

        let tokens: AuthTokens?
        switch action {
        case .seed:
            guard
                let accessToken = environment[accessTokenKey],
                let refreshToken = environment[refreshTokenKey],
                isValidToken(accessToken),
                isValidToken(refreshToken)
            else {
                return "error:\(nonce)"
            }
            tokens = AuthTokens(accessToken: accessToken, refreshToken: refreshToken)
        case .clear:
            tokens = nil
        }

        guard let accessGroup = KeychainAccessGroup.resolveShared(suffix: sharedGroupSuffix) else {
            return "error:\(nonce)"
        }

        let store = KeychainSessionTokenStore(
            tokenProvider: CurrentTokenProvider(),
            keychain: SecKeychainAccess(accessGroup: accessGroup)
        )

        do {
            switch action {
            case .seed:
                guard let tokens else { return "error:\(nonce)" }
                try await store.save(tokens)
                guard await store.load() == tokens else {
                    return "error:\(nonce)"
                }
                return "seeded:\(nonce)"
            case .clear:
                try await store.clear()
                guard await store.load() == nil else {
                    return "error:\(nonce)"
                }
                return "cleared:\(nonce)"
            }
        } catch {
            return "error:\(nonce)"
        }
    }

    private static func isValidNonce(_ value: String) -> Bool {
        guard (1...128).contains(value.utf8.count) else { return false }
        return value.utf8.allSatisfy { byte in
            (48...57).contains(byte) ||
                (65...90).contains(byte) ||
                (97...122).contains(byte) ||
                byte == 45 || byte == 46 || byte == 95
        }
    }

    private static func isValidToken(_ value: String) -> Bool {
        guard (1...16_384).contains(value.utf8.count) else { return false }
        return value.utf8.allSatisfy { byte in
            byte >= 33 && byte <= 126
        }
    }
}
