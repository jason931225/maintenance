import Foundation
import MaintenanceFieldCore

struct FieldAppContainer {
    let authRepository: PasskeyAuthRepository
    let workOrderRepository: WorkOrderRepository
    let evidenceRepository: EvidenceRepository
    let locationConsentRepository: LocationConsentRepository

    static func live() -> FieldAppContainer {
        let tokenProvider = CurrentTokenProvider()
        let sessionStore = UserDefaultsSessionTokenStore(tokenProvider: tokenProvider)
        let deviceIDStore = UserDefaultsDeviceIDStore()
        let serverURL = URL(string: ProcessInfo.processInfo.environment["MAINTENANCE_API_BASE_URL"] ?? "http://localhost:8080")!
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
            locationConsentRepository: LocationConsentRepository(gateway: gateway)
        )
    }
}
