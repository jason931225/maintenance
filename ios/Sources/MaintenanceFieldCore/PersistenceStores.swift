import CoreData
import Foundation
import MaintenanceAPIClient
import Security

public final class CurrentTokenProvider: @unchecked Sendable {
    private let lock = NSLock()
    private var accessToken: String?

    public init(accessToken: String? = nil) {
        self.accessToken = accessToken
    }

    public func get() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return accessToken
    }

    public func set(_ accessToken: String?) {
        lock.lock()
        self.accessToken = accessToken
        lock.unlock()
    }
}

public struct AuthTokens: Codable, Hashable, Sendable {
    public var accessToken: String
    public var refreshToken: String

    public init(accessToken: String, refreshToken: String) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
    }
}

public protocol SessionTokenStore: Sendable {
    func load() async -> AuthTokens?
    func save(_ tokens: AuthTokens) async
    func clear() async
}

/// Stores the access/refresh token pair in the Keychain rather than UserDefaults.
///
/// The 30-day refresh token must not live in a UserDefaults plist (those are included
/// in iCloud/Finder backups). Both tokens are persisted as a single JSON-encoded
/// generic-password item with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, so the
/// item is reachable only while the device is unlocked and never leaves the device.
public actor KeychainSessionTokenStore: SessionTokenStore {
    private let tokenProvider: CurrentTokenProvider
    private let service: String
    private let account: String
    private let keychain: any KeychainAccess

    public init(
        tokenProvider: CurrentTokenProvider,
        namespace: String = "maintenance.field",
        keychain: any KeychainAccess = SecKeychainAccess()
    ) {
        self.tokenProvider = tokenProvider
        self.service = namespace
        self.account = "\(namespace).session"
        self.keychain = keychain
        tokenProvider.set(Self.decode(keychain.read(service: service, account: account))?.accessToken)
    }

    public func load() -> AuthTokens? {
        guard let tokens = Self.decode(keychain.read(service: service, account: account)) else {
            tokenProvider.set(nil)
            return nil
        }
        tokenProvider.set(tokens.accessToken)
        return tokens
    }

    public func save(_ tokens: AuthTokens) {
        if let data = try? JSONEncoder().encode(tokens) {
            keychain.write(data, service: service, account: account)
        }
        tokenProvider.set(tokens.accessToken)
    }

    public func clear() {
        keychain.delete(service: service, account: account)
        tokenProvider.set(nil)
    }

    private static func decode(_ data: Data?) -> AuthTokens? {
        guard let data else { return nil }
        return try? JSONDecoder().decode(AuthTokens.self, from: data)
    }
}

/// Abstraction over the Keychain so the session store is unit-testable without a
/// provisioned Keychain (the real `SecItem` APIs fail outside a signed app bundle).
public protocol KeychainAccess: Sendable {
    func read(service: String, account: String) -> Data?
    func write(_ data: Data, service: String, account: String)
    func delete(service: String, account: String)
}

public struct SecKeychainAccess: KeychainAccess {
    public init() {}

    public func read(service: String, account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    public func write(_ data: Data, service: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { _, new in new }
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    public func delete(service: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

public protocol DeviceIDStore: Sendable {
    func loadOrCreate() async -> String
}

public actor UserDefaultsDeviceIDStore: DeviceIDStore {
    private let userDefaults: UserDefaults
    private let key: String

    public init(userDefaults: UserDefaults = .standard, namespace: String = "maintenance.field") {
        self.userDefaults = userDefaults
        self.key = "\(namespace).deviceID"
    }

    public func loadOrCreate() -> String {
        if let existing = userDefaults.string(forKey: key) {
            return existing
        }
        let created = UUID().uuidString.lowercased()
        userDefaults.set(created, forKey: key)
        return created
    }
}

public actor CoreDataMutationQueueStore: MutationQueueStore {
    private let container: NSPersistentContainer

    public init(storeURL: URL) throws {
        container = NSPersistentContainer(
            name: "MaintenanceFieldOfflineQueue",
            managedObjectModel: Self.makeModel()
        )
        let description = NSPersistentStoreDescription(url: storeURL)
        description.type = NSSQLiteStoreType
        container.persistentStoreDescriptions = [description]

        var loadError: Error?
        container.loadPersistentStores { _, error in
            loadError = error
        }
        if let loadError {
            throw loadError
        }
        container.viewContext.mergePolicy = NSMergePolicy(merge: .mergeByPropertyObjectTrumpMergePolicyType)
    }

    public static func defaultStoreURL() throws -> URL {
        let root = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appendingPathComponent("MaintenanceField", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root.appendingPathComponent("offline-queue.sqlite")
    }

    public func upsert(_ mutation: QueuedMutation) {
        let context = container.viewContext
        context.performAndWait {
            let object = Self.fetchObject(requestID: mutation.requestID, context: context) ?? NSManagedObject(
                entity: Self.entityDescription(in: context),
                insertInto: context
            )
            object.setValue(mutation.requestID, forKey: "requestID")
            object.setValue(mutation.kind.rawValue, forKey: "kind")
            object.setValue(mutation.workOrderID, forKey: "workOrderID")
            object.setValue(mutation.createdAt, forKey: "createdAt")
            object.setValue(mutation.resultType?.rawValue, forKey: "resultType")
            object.setValue(mutation.diagnosis, forKey: "diagnosis")
            object.setValue(mutation.actionTaken, forKey: "actionTaken")
            object.setValue(mutation.syncState.rawValue, forKey: "syncState")
            object.setValue(mutation.lastError, forKey: "lastError")
            object.setValue(mutation.serverReplayed, forKey: "serverReplayed")
            Self.save(context)
        }
    }

    public func pending() -> [QueuedMutation] {
        let context = container.viewContext
        return context.performAndWait {
            let request = NSFetchRequest<NSManagedObject>(entityName: "QueuedMutationEntity")
            request.predicate = NSPredicate(format: "syncState == %@", SyncState.pending.rawValue)
            request.sortDescriptors = [NSSortDescriptor(key: "requestID", ascending: true)]
            return (try? context.fetch(request).compactMap(Self.decodeMutation)) ?? []
        }
    }

    public func get(_ requestID: String) -> QueuedMutation? {
        let context = container.viewContext
        return context.performAndWait {
            Self.fetchObject(requestID: requestID, context: context).flatMap(Self.decodeMutation)
        }
    }

    public func markSynced(requestID: String, serverReplayed: Bool) {
        let context = container.viewContext
        context.performAndWait {
            guard let object = Self.fetchObject(requestID: requestID, context: context) else { return }
            object.setValue(SyncState.synced.rawValue, forKey: "syncState")
            object.setValue(nil, forKey: "lastError")
            object.setValue(serverReplayed, forKey: "serverReplayed")
            Self.save(context)
        }
    }

    public func markFailed(requestID: String, message: String) {
        let context = container.viewContext
        context.performAndWait {
            guard let object = Self.fetchObject(requestID: requestID, context: context) else { return }
            object.setValue(SyncState.failed.rawValue, forKey: "syncState")
            object.setValue(message, forKey: "lastError")
            Self.save(context)
        }
    }

    private static func fetchObject(requestID: String, context: NSManagedObjectContext) -> NSManagedObject? {
        let request = NSFetchRequest<NSManagedObject>(entityName: "QueuedMutationEntity")
        request.fetchLimit = 1
        request.predicate = NSPredicate(format: "requestID == %@", requestID)
        return try? context.fetch(request).first
    }

    private static func save(_ context: NSManagedObjectContext) {
        guard context.hasChanges else { return }
        try? context.save()
    }

    private static func decodeMutation(_ object: NSManagedObject) -> QueuedMutation? {
        guard
            let requestID = object.value(forKey: "requestID") as? String,
            let kindRaw = object.value(forKey: "kind") as? String,
            let kind = QueuedMutationKind(rawValue: kindRaw),
            let workOrderID = object.value(forKey: "workOrderID") as? String,
            let createdAt = object.value(forKey: "createdAt") as? Date,
            let syncStateRaw = object.value(forKey: "syncState") as? String,
            let syncState = SyncState(rawValue: syncStateRaw)
        else {
            return nil
        }

        let resultType = (object.value(forKey: "resultType") as? String).flatMap {
            Components.Schemas.WorkResultType(rawValue: $0)
        }
        return QueuedMutation(
            requestID: requestID,
            kind: kind,
            workOrderID: workOrderID,
            createdAt: createdAt,
            resultType: resultType,
            diagnosis: object.value(forKey: "diagnosis") as? String,
            actionTaken: object.value(forKey: "actionTaken") as? String,
            syncState: syncState,
            lastError: object.value(forKey: "lastError") as? String,
            serverReplayed: (object.value(forKey: "serverReplayed") as? Bool) ?? false
        )
    }

    private static func entityDescription(in context: NSManagedObjectContext) -> NSEntityDescription {
        context.persistentStoreCoordinator!.managedObjectModel.entitiesByName["QueuedMutationEntity"]!
    }

    private static func makeModel() -> NSManagedObjectModel {
        let entity = NSEntityDescription()
        entity.name = "QueuedMutationEntity"
        entity.managedObjectClassName = NSStringFromClass(NSManagedObject.self)

        func attribute(_ name: String, _ type: NSAttributeType, optional: Bool = false) -> NSAttributeDescription {
            let attribute = NSAttributeDescription()
            attribute.name = name
            attribute.attributeType = type
            attribute.isOptional = optional
            return attribute
        }

        entity.properties = [
            attribute("requestID", .stringAttributeType),
            attribute("kind", .stringAttributeType),
            attribute("workOrderID", .stringAttributeType),
            attribute("createdAt", .dateAttributeType),
            attribute("resultType", .stringAttributeType, optional: true),
            attribute("diagnosis", .stringAttributeType, optional: true),
            attribute("actionTaken", .stringAttributeType, optional: true),
            attribute("syncState", .stringAttributeType),
            attribute("lastError", .stringAttributeType, optional: true),
            attribute("serverReplayed", .booleanAttributeType),
        ]

        let model = NSManagedObjectModel()
        model.entities = [entity]
        return model
    }
}
