import Foundation
import MaintenanceFieldCore

struct FieldAppContainer {
    let authRepository: PasskeyAuthRepository
    let workOrderRepository: WorkOrderRepository
    let evidenceRepository: EvidenceRepository
    let messengerRepository: MessengerRepository
    let locationConsentRepository: LocationConsentRepository
    let mobileOperationsRepository: MobileOperationsRepository
    let passkeyStepUpRepository: PasskeyStepUpRepository

    /// Suffix of the shared keychain access group (the part after the
    /// AppIdentifierPrefix). Must match the `keychain-access-groups` entitlement
    /// (`$(AppIdentifierPrefix)com.maintenance.field.shared`) in
    /// `Config/MaintenanceFieldApp.entitlements`. The session lives in this
    /// shared group so a real session can be restored by the app's normal launch
    /// path; the CI UI-test suite seeds into the same group (no fakes).
    static let sharedKeychainGroupSuffix = "com.maintenance.field.shared"

    static func live() -> FieldAppContainer {
        let tokenProvider = CurrentTokenProvider()
        // Persist the session in the shared access group when the build is
        // entitled to it; otherwise fall back to the default group. A legacy
        // default-group store is always provided so a session written by a
        // pre-shared-group build is found once and migrated forward (no logout
        // on update).
        let sessionStore: KeychainSessionTokenStore
        if let sharedGroup = KeychainAccessGroup.resolveShared(suffix: sharedKeychainGroupSuffix) {
            sessionStore = KeychainSessionTokenStore(
                tokenProvider: tokenProvider,
                keychain: SecKeychainAccess(accessGroup: sharedGroup),
                legacyKeychain: SecKeychainAccess()
            )
        } else {
            sessionStore = KeychainSessionTokenStore(tokenProvider: tokenProvider)
        }
        let deviceIDStore = UserDefaultsDeviceIDStore()
        let serverURL = Self.resolveServerURL()
        let gateway = GeneratedMaintenanceAPIGateway(serverURL: serverURL, tokenProvider: tokenProvider)
        let mutationStore: any MutationQueueStore
        do {
            mutationStore = try CoreDataMutationQueueStore(storeURL: CoreDataMutationQueueStore.defaultStoreURL())
        } catch {
            preconditionFailure("Offline queue initialization failed: \(error)")
        }
        let offlineQueue = OfflineQueueRepository(
            store: mutationStore,
            syncGateway: gateway,
            deviceIDProvider: {
                let key = "maintenance.field.deviceID"
                if let existing = UserDefaults.standard.string(forKey: key) {
                    return existing
                }
                let created = UUID().uuidString.lowercased()
                UserDefaults.standard.set(created, forKey: key)
                return created
            }
        )
        let workOrders = WorkOrderRepository(
            gateway: gateway,
            cache: WorkOrderCacheStore(),
            offlineQueue: offlineQueue
        )
        let evidenceStore: any EvidenceUploadStore
        do {
            evidenceStore = try FileEvidenceUploadStore(fileURL: FileEvidenceUploadStore.defaultStoreURL())
        } catch {
            preconditionFailure("Evidence queue initialization failed: \(error)")
        }
        let evidence = EvidenceRepository(gateway: gateway, store: evidenceStore)
        let messengerStore: any MessengerOutboxStore
        do {
            messengerStore = try FileMessengerOutboxStore(fileURL: FileMessengerOutboxStore.defaultStoreURL())
        } catch {
            preconditionFailure("Messenger outbox initialization failed: \(error)")
        }
        let messenger = MessengerRepository(gateway: gateway, outbox: messengerStore)
        let mobileOperationsCache: any MobileOperationsCacheStore
        let mobileNotificationStore: any MobileNotificationStore
        let mobileSensitiveActionStore: any MobileSensitiveActionStore
        do {
            mobileOperationsCache = try FileMobileOperationsCacheStore(fileURL: FileMobileOperationsCacheStore.defaultStoreURL())
            mobileNotificationStore = try FileMobileNotificationStore(fileURL: FileMobileNotificationStore.defaultStoreURL())
            mobileSensitiveActionStore = try FileMobileSensitiveActionStore(fileURL: FileMobileSensitiveActionStore.defaultStoreURL())
        } catch {
            preconditionFailure("Mobile operations store initialization failed: \(error)")
        }
        let passkeys = AuthorizationPasskeyCredentialProvider(relyingPartyIdentifier: serverURL.host ?? "localhost")

        return FieldAppContainer(
            authRepository: PasskeyAuthRepository(
                gateway: gateway,
                credentialProvider: passkeys,
                sessionStore: sessionStore,
                deviceIDStore: deviceIDStore,
                appVersion: MaintenanceFieldCoreVersion.value
            ),
            workOrderRepository: workOrders,
            evidenceRepository: evidence,
            messengerRepository: messenger,
            locationConsentRepository: LocationConsentRepository(gateway: gateway),
            mobileOperationsRepository: MobileOperationsRepository(
                gateway: gateway,
                cache: mobileOperationsCache,
                notificationStore: mobileNotificationStore,
                sensitiveActionStore: mobileSensitiveActionStore
            ),
            passkeyStepUpRepository: PasskeyStepUpRepository(
                gateway: gateway,
                credentialProvider: passkeys
            )
        )
    }

    /// Production is the safe default so a release build on a real device reaches
    /// the live backend; local, simulator, and CI runs override via the
    /// `MAINTENANCE_API_BASE_URL` environment variable. The previous default
    /// (`http://localhost:8080`) failed closed on device — there is no host
    /// loopback to a backend there.
    static let productionAPIBaseURL = URL(string: "https://fsm.knllogistic.com")!

    static func resolveServerURL() -> URL {
        guard
            let override = ProcessInfo.processInfo.environment["MAINTENANCE_API_BASE_URL"],
            let overrideURL = URL(string: override)
        else {
            return productionAPIBaseURL
        }
        return overrideURL
    }
}
