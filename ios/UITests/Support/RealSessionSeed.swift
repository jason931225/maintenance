import Foundation
import Security
import XCTest

/// Seeds a **real** session token pair into the **real** Keychain so the app's
/// normal launch path (`KeychainSessionTokenStore.init` / `restore()`) restores
/// an authenticated session — with **no fake `AuthRepository`** and **no
/// test-only branch** in the app.
///
/// ## How "no fakes" is honored
///
/// 1. A real session is obtained from the real backend (`RealBackendSession`).
/// 2. The token pair is written into the Keychain using the exact same
///    `kSecClassGenericPassword` item layout the app reads
///    (`service`/`account`/JSON `AuthTokens` blob — see
///    `PersistenceStores.swift`), under the **shared access group** that both the
///    app target and this UITests target ship via their
///    `keychain-access-groups` entitlement.
/// 3. The app launches normally and `restore()` reads that item back. The app
///    never knows a test wrote it.
///
/// ## Honest feasibility note
///
/// This cross-process seeding only works because both targets declare the **same**
/// `keychain-access-groups` entitlement (`$(AppIdentifierPrefix)com.maintenance.field.shared`).
/// Without the shared group, a separate test process cannot read/write the app's
/// Keychain item, and the only real alternative is to drive the passkey ceremony
/// manually (see `E2E-MANUAL-SMOKE.md`). The seeding here is therefore gated on
/// the signed, entitled build that CI produces; on a fully unsigned build it is
/// skipped and the dependent tests are skipped with a clear message rather than
/// silently faking auth.
enum RealSessionSeed {
    /// Keychain coordinates — must mirror `KeychainSessionTokenStore`'s
    /// `namespace` defaults exactly.
    static let service = "maintenance.field"
    static let account = "maintenance.field.session"

    /// The shared access group's suffix (the part after the Team-ID prefix).
    /// Must match `MNT_IOS_KEYCHAIN_GROUP` in `ios/Config/App.xcconfig`:
    /// `$(AppIdentifierPrefix)com.maintenance.field.shared`.
    static let accessGroupSuffix = "com.maintenance.field.shared"

    /// Resolve the fully-qualified shared access group the system actually
    /// granted, exactly as the app does (`KeychainAccessGroup.resolveShared`):
    /// probe with the suffixed group and read back the resolved
    /// `kSecAttrAccessGroup`. The CI-provided `MNT_IOS_KEYCHAIN_GROUP` is honored
    /// first only as an explicit override. Probing — rather than reconstructing
    /// `<prefix>.<suffix>` by string surgery — guarantees the seeder and the app
    /// agree on one value on both device and the ad-hoc-signed Simulator (where
    /// the AppIdentifierPrefix is not the Team ID). Returns nil if the build is
    /// not entitled to the group, so dependent tests skip honestly.
    static func resolvedAccessGroup() -> String? {
        if let provided = ProcessInfo.processInfo.environment["MNT_IOS_KEYCHAIN_GROUP"],
           provided.isEmpty == false,
           probeSucceeds(group: provided) {
            return provided
        }
        return grantedSharedGroup()
    }

    /// Add a throwaway item declaring `accessGroupSuffix`, read back the resolved
    /// group, and return it. Mirrors the production resolver so both sides land
    /// on the identical granted string.
    private static func grantedSharedGroup() -> String? {
        let probeAccount = "maintenance.field.uitest.group.probe"
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: probeAccount,
            kSecAttrAccessGroup as String: accessGroupSuffix,
            kSecValueData as String: Data("probe".utf8),
            kSecReturnAttributes as String: true,
        ]
        var result: CFTypeRef?
        var status = SecItemAdd(add as CFDictionary, &result)
        if status == errSecDuplicateItem {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: probeAccount,
                kSecAttrAccessGroup as String: accessGroupSuffix,
                kSecReturnAttributes as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ]
            status = SecItemCopyMatching(query as CFDictionary, &result)
        }
        defer {
            SecItemDelete([
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: probeAccount,
                kSecAttrAccessGroup as String: accessGroupSuffix,
            ] as CFDictionary)
        }
        guard
            status == errSecSuccess,
            let attributes = result as? [String: Any],
            let granted = attributes[kSecAttrAccessGroup as String] as? String
        else {
            return nil
        }
        return granted
    }

    /// Confirm the process is actually entitled to write `group` (an explicit
    /// override is only trustworthy if a probe write to it succeeds).
    private static func probeSucceeds(group: String) -> Bool {
        let probeAccount = "maintenance.field.uitest.override.probe"
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: probeAccount,
            kSecAttrAccessGroup as String: group,
            kSecValueData as String: Data("probe".utf8),
        ]
        let status = SecItemAdd(add as CFDictionary, nil)
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: probeAccount,
            kSecAttrAccessGroup as String: group,
        ] as CFDictionary)
        return status == errSecSuccess || status == errSecDuplicateItem
    }

    /// Write the token pair into the shared-group Keychain in the app's exact
    /// item layout. Returns the access group it used so the test can verify and
    /// clean up. Throws `XCTSkip` if the shared group is unavailable (unsigned
    /// build) so dependent tests skip honestly rather than fake a session.
    @discardableResult
    static func seed(_ tokens: SeedTokens) throws -> String {
        guard let accessGroup = resolvedAccessGroup() else {
            throw XCTSkip(
                """
                No shared keychain-access-group is present in this build's entitlements, \
                so a real session cannot be seeded cross-process. This is expected on a \
                fully unsigned build. Run the entitled CI Simulator build, or perform the \
                passkey ceremony manually per E2E-MANUAL-SMOKE.md.
                """
            )
        }

        // Encode in the EXACT shape KeychainSessionTokenStore decodes:
        // { "accessToken": "...", "refreshToken": "..." }
        let blob = try JSONEncoder().encode(tokens)

        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        SecItemDelete(base as CFDictionary)

        var insert = base
        insert[kSecValueData as String] = blob
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(insert as CFDictionary, nil)
        if status == errSecMissingEntitlement {
            // -34018: the build lacks the keychain-access-groups entitlement for
            // this group, so cross-process seeding is impossible. Skip honestly
            // rather than fail red or fake a session. CI must sign the Simulator
            // build with the shared-group entitlement for these tests to run.
            throw XCTSkip(
                """
                SecItemAdd returned errSecMissingEntitlement (-34018) for group \(accessGroup). \
                The build is not entitled to the shared keychain access group, so a real \
                session cannot be seeded cross-process. Sign the CI Simulator build with the \
                shared-group entitlement (Config/MaintenanceFieldUITests.entitlements), or run \
                the manual passkey smoke (E2E-MANUAL-SMOKE.md).
                """
            )
        }
        guard status == errSecSuccess else {
            throw NSError(
                domain: "RealSessionSeed",
                code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "SecItemAdd failed (OSStatus \(status))"]
            )
        }

        // Verify the item is actually readable back under the same group — proves
        // the seed will be visible to the app's restore() path, not silently lost.
        let verify: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var readBack: CFTypeRef?
        guard SecItemCopyMatching(verify as CFDictionary, &readBack) == errSecSuccess else {
            throw NSError(
                domain: "RealSessionSeed",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Seeded item could not be read back under \(accessGroup)."]
            )
        }
        return accessGroup
    }

    /// Remove the seeded item so each test starts from a clean Keychain.
    static func clear() {
        guard let accessGroup = resolvedAccessGroup() else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// The exact JSON shape the app's `AuthTokens` encodes/decodes. Kept as a local
/// mirror (not an import) because the UITests bundle links against the app's UI,
/// not its Core module's internal store types; the field names are the contract.
struct SeedTokens: Encodable {
    let accessToken: String
    let refreshToken: String
}
