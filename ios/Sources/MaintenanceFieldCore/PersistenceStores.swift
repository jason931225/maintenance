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
    /// Removes the current pair before a rotating refresh request is sent.
    func consumeForRefresh() async throws -> AuthTokens?
    func save(_ tokens: AuthTokens) async throws
    func clear() async throws
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

    /// Optional legacy store (the app's default access group). When the primary
    /// store reads from a shared access group, a session written by an older
    /// build lives in the default group; this lets `load()` find and migrate it
    /// once so updating to a shared-group build does not log the user out.
    private let legacyKeychain: (any KeychainAccess)?

    public init(
        tokenProvider: CurrentTokenProvider,
        namespace: String = "maintenance.field",
        keychain: any KeychainAccess = SecKeychainAccess(),
        legacyKeychain: (any KeychainAccess)? = nil
    ) {
        self.tokenProvider = tokenProvider
        self.service = namespace
        self.account = "\(namespace).session"
        self.keychain = keychain
        self.legacyKeychain = legacyKeychain
        tokenProvider.set(Self.decode(Self.read(primary: keychain, legacy: legacyKeychain, service: service, account: account))?.accessToken)
    }

    public func load() -> AuthTokens? {
        // Primary (possibly shared-group) read first; fall back to the legacy
        // default-group item and migrate it into the primary store one time.
        if let tokens = Self.decode(keychain.read(service: service, account: account)) {
            tokenProvider.set(tokens.accessToken)
            return tokens
        }
        if let legacyKeychain,
           let legacyData = legacyKeychain.read(service: service, account: account),
           let tokens = Self.decode(legacyData) {
            if (try? keychain.write(legacyData, service: service, account: account)) != nil {
                try? legacyKeychain.delete(service: service, account: account)
            }
            tokenProvider.set(tokens.accessToken)
            return tokens
        }
        tokenProvider.set(nil)
        return nil
    }

    public func consumeForRefresh() throws -> AuthTokens? {
        let primaryData = keychain.read(service: service, account: account)
        let legacyData = legacyKeychain?.read(service: service, account: account)
        let tokens = Self.decode(primaryData ?? legacyData)
        tokenProvider.set(nil)
        do {
            try keychain.delete(service: service, account: account)
            try legacyKeychain?.delete(service: service, account: account)
            return tokens
        } catch {
            Self.restore(
                primaryData: primaryData,
                legacyData: legacyData,
                keychain: keychain,
                legacyKeychain: legacyKeychain,
                service: service,
                account: account
            )
            throw error
        }
    }

    public func save(_ tokens: AuthTokens) throws {
        let data = try JSONEncoder().encode(tokens)
        try keychain.write(data, service: service, account: account)
        tokenProvider.set(tokens.accessToken)
    }

    public func clear() throws {
        let primaryData = keychain.read(service: service, account: account)
        let legacyData = legacyKeychain?.read(service: service, account: account)
        do {
            try keychain.delete(service: service, account: account)
            try legacyKeychain?.delete(service: service, account: account)
            tokenProvider.set(nil)
        } catch {
            Self.restore(
                primaryData: primaryData,
                legacyData: legacyData,
                keychain: keychain,
                legacyKeychain: legacyKeychain,
                service: service,
                account: account
            )
            throw error
        }
    }

    /// Read the token blob, preferring the primary store and falling back to the
    /// legacy store (used by `init` to seed the token provider before the actor
    /// is available for `load()`).
    private static func read(
        primary: any KeychainAccess,
        legacy: (any KeychainAccess)?,
        service: String,
        account: String
    ) -> Data? {
        primary.read(service: service, account: account)
            ?? legacy?.read(service: service, account: account)
    }

    private static func decode(_ data: Data?) -> AuthTokens? {
        guard let data else { return nil }
        return try? JSONDecoder().decode(AuthTokens.self, from: data)
    }

    private static func restore(
        primaryData: Data?,
        legacyData: Data?,
        keychain: any KeychainAccess,
        legacyKeychain: (any KeychainAccess)?,
        service: String,
        account: String
    ) {
        if let primaryData { try? keychain.write(primaryData, service: service, account: account) }
        if let legacyData { try? legacyKeychain?.write(legacyData, service: service, account: account) }
    }
}

/// Abstraction over the Keychain so the session store is unit-testable without a
/// provisioned Keychain (the real `SecItem` APIs fail outside a signed app bundle).
public protocol KeychainAccess: Sendable {
    func read(service: String, account: String) -> Data?
    func write(_ data: Data, service: String, account: String) throws
    func delete(service: String, account: String) throws
}

public struct SecKeychainAccess: KeychainAccess {
    private let accessGroup: String?

    /// - Parameter accessGroup: when non-nil, every Keychain query is scoped to
    ///   this `kSecAttrAccessGroup`. A shared access group is the supported way
    ///   for two targets that ship the same `keychain-access-groups` entitlement
    ///   to read each other's items. The default (`nil`) preserves the original
    ///   behavior: items live in the app's default access group. This is what
    ///   lets the CI UITests target seed a real session into the same group the
    ///   app reads from, without any test-only branch in the app's launch path.
    public init(accessGroup: String? = nil) {
        self.accessGroup = accessGroup
    }

    public func read(service: String, account: String) -> Data? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    public func write(_ data: Data, service: String, account: String) throws {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { _, new in new }
            let addStatus = SecItemAdd(insert as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw PersistenceStoreError.writeFailed("session", "keychain status \(addStatus)")
            }
        } else if status != errSecSuccess {
            throw PersistenceStoreError.writeFailed("session", "keychain status \(status)")
        }
    }

    public func delete(service: String, account: String) throws {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PersistenceStoreError.writeFailed("session", "keychain delete status \(status)")
        }
    }
}

/// Resolves the app's *granted* shared keychain access group at runtime.
///
/// The fully-qualified group is `<AppIdentifierPrefix>.<suffix>`. The
/// `<AppIdentifierPrefix>` differs between a properly-signed device build (the
/// Team ID) and an ad-hoc-signed Simulator build, so it must not be reconstructed
/// in code. This adds a uniquely named throwaway item without specifying an
/// access group, causing Keychain Services to use the process's first (default)
/// entitled group, then reads back and validates the exact group the system
/// granted. Returns `nil` when that default group does not match the shared-group
/// suffix (the app then transparently uses its legacy default-group store).
public enum KeychainAccessGroup {
    public static func resolveShared(
        suffix: String,
        service: String = "maintenance.field",
        probeAccount: String = "maintenance.field.group.probe"
    ) -> String? {
        let uniqueProbeAccount = "\(probeAccount).\(UUID().uuidString.lowercased())"
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: uniqueProbeAccount,
            kSecValueData as String: Data("probe".utf8),
            kSecReturnAttributes as String: true,
        ]
        var result: CFTypeRef?
        let status = SecItemAdd(add as CFDictionary, &result)
        defer {
            SecItemDelete([
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: uniqueProbeAccount,
            ] as CFDictionary)
        }
        guard
            status == errSecSuccess,
            let attributes = result as? [String: Any],
            let granted = attributes[kSecAttrAccessGroup as String] as? String,
            granted == suffix || granted.hasSuffix(".\(suffix)")
        else {
            return nil
        }
        return granted
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
    public enum TestingFailureMode: Sendable {
        case fetch
        case save
    }

    private let container: NSPersistentContainer
    private let testingFailureMode: TestingFailureMode?

    public init(storeURL: URL, testingFailureMode: TestingFailureMode? = nil) throws {
        self.testingFailureMode = testingFailureMode
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

    public func upsert(_ mutation: QueuedMutation) throws {
        if testingFailureMode == .save {
            throw PersistenceStoreError.saveFailed("mutation_queue", "injected")
        }
        // Read the actor-isolated `testingFailureMode` into a Sendable local *before*
        // the `performAndWait` block. That block is `@Sendable` (see the CoreData
        // overlay); referencing `self.testingFailureMode` inside it would capture the
        // actor, merging `self`'s region with `context` and turning the
        // `@preconcurrency`-downgraded context capture into a hard Swift 6.1
        // "sending 'context' risks causing data races" error. Capturing only the
        // Sendable local keeps the block's captures value-typed.
        let failureMode = testingFailureMode
        let context = container.viewContext
        try context.performAndWait {
            let object = try Self.fetchObject(
                requestID: mutation.requestID,
                context: context,
                testingFailureMode: failureMode
            ) ?? NSManagedObject(
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
            try Self.save(context)
        }
    }

    public func pending() throws -> [QueuedMutation] {
        let failureMode = testingFailureMode
        let context = container.viewContext
        return try context.performAndWait {
            if failureMode == .fetch {
                throw PersistenceStoreError.fetchFailed("mutation_queue", "injected")
            }
            let request = NSFetchRequest<NSManagedObject>(entityName: "QueuedMutationEntity")
            request.predicate = NSPredicate(format: "syncState == %@", SyncState.pending.rawValue)
            request.sortDescriptors = [NSSortDescriptor(key: "requestID", ascending: true)]
            do {
                return try context.fetch(request).compactMap(Self.decodeMutation)
            } catch {
                throw PersistenceStoreError.fetchFailed(
                    "mutation_queue",
                    PersistenceStoreError.sanitizedUnderlyingDescription(error)
                )
            }
        }
    }

    public func get(_ requestID: String) throws -> QueuedMutation? {
        let failureMode = testingFailureMode
        let context = container.viewContext
        return try context.performAndWait {
            try Self.fetchObject(
                requestID: requestID,
                context: context,
                testingFailureMode: failureMode
            ).flatMap(Self.decodeMutation)
        }
    }

    public func markSynced(requestID: String, serverReplayed: Bool) throws {
        if testingFailureMode == .save {
            throw PersistenceStoreError.saveFailed("mutation_queue", "injected")
        }
        let failureMode = testingFailureMode
        let context = container.viewContext
        try context.performAndWait {
            guard let object = try Self.fetchObject(
                requestID: requestID,
                context: context,
                testingFailureMode: failureMode
            ) else { return }
            object.setValue(SyncState.synced.rawValue, forKey: "syncState")
            object.setValue(nil, forKey: "lastError")
            object.setValue(serverReplayed, forKey: "serverReplayed")
            try Self.save(context)
        }
    }

    public func markFailed(requestID: String, message: String) throws {
        if testingFailureMode == .save {
            throw PersistenceStoreError.saveFailed("mutation_queue", "injected")
        }
        let failureMode = testingFailureMode
        let context = container.viewContext
        try context.performAndWait {
            guard let object = try Self.fetchObject(
                requestID: requestID,
                context: context,
                testingFailureMode: failureMode
            ) else { return }
            object.setValue(SyncState.failed.rawValue, forKey: "syncState")
            object.setValue(message, forKey: "lastError")
            try Self.save(context)
        }
    }

    private static func fetchObject(
        requestID: String,
        context: NSManagedObjectContext,
        testingFailureMode: TestingFailureMode?
    ) throws -> NSManagedObject? {
        if testingFailureMode == .fetch {
            throw PersistenceStoreError.fetchFailed("mutation_queue", "injected")
        }
        let request = NSFetchRequest<NSManagedObject>(entityName: "QueuedMutationEntity")
        request.fetchLimit = 1
        request.predicate = NSPredicate(format: "requestID == %@", requestID)
        do {
            return try context.fetch(request).first
        } catch {
            throw PersistenceStoreError.fetchFailed(
                "mutation_queue",
                PersistenceStoreError.sanitizedUnderlyingDescription(error)
            )
        }
    }

    private static func save(_ context: NSManagedObjectContext) throws {
        guard context.hasChanges else { return }
        do {
            try context.save()
        } catch {
            throw PersistenceStoreError.saveFailed(
                "mutation_queue",
                PersistenceStoreError.sanitizedUnderlyingDescription(error)
            )
        }
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
