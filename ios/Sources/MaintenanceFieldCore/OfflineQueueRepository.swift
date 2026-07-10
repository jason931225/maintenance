import Foundation
import MaintenanceAPIClient

public protocol FieldClock: Sendable {
    func now() -> Date
}

public struct SystemFieldClock: FieldClock {
    public init() {}

    public func now() -> Date {
        Date()
    }
}

public protocol RequestIDFactory: Sendable {
    func nextID() -> String
}

public struct ULIDRequestIDFactory: RequestIDFactory {
    private let timestampProvider: @Sendable () -> Date
    private let randomByteProvider: @Sendable (Int) -> [UInt8]

    public init(
        timestampProvider: @escaping @Sendable () -> Date = { Date() },
        randomByteProvider: @escaping @Sendable (Int) -> [UInt8] = { count in
            (0..<count).map { _ in UInt8.random(in: UInt8.min...UInt8.max) }
        }
    ) {
        self.timestampProvider = timestampProvider
        self.randomByteProvider = randomByteProvider
    }

    public func nextID() -> String {
        let milliseconds = UInt64(timestampProvider().timeIntervalSince1970 * 1_000)
        let timeChars = encode(value: milliseconds, length: 10)
        let randomBytes = randomByteProvider(10)
        let randomValue = randomBytes.reduce(UInt64(0)) { partial, byte in
            ((partial << 8) | UInt64(byte)) & 0xFFFF_FFFF_FFFF_FFFF
        }
        let entropyChars = encode(value: randomValue, length: 16)
        return timeChars + entropyChars
    }

    private func encode(value: UInt64, length: Int) -> String {
        let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        var value = value
        var output = Array(repeating: alphabet[0], count: length)
        for index in stride(from: length - 1, through: 0, by: -1) {
            output[index] = alphabet[Int(value & 31)]
            value >>= 5
        }
        return String(output)
    }
}

public enum QueuedMutationKind: String, Codable, Hashable, Sendable {
    case workOrderStart
    case workOrderReport
}

public struct QueuedMutation: Codable, Hashable, Sendable {
    public var requestID: String
    public var kind: QueuedMutationKind
    public var workOrderID: Components.Schemas.Uuid
    public var createdAt: Date
    public var resultType: Components.Schemas.WorkResultType?
    public var diagnosis: String?
    public var actionTaken: String?
    public var syncState: SyncState
    public var lastError: String?
    public var serverReplayed: Bool

    public init(
        requestID: String,
        kind: QueuedMutationKind,
        workOrderID: Components.Schemas.Uuid,
        createdAt: Date,
        resultType: Components.Schemas.WorkResultType? = nil,
        diagnosis: String? = nil,
        actionTaken: String? = nil,
        syncState: SyncState = .pending,
        lastError: String? = nil,
        serverReplayed: Bool = false
    ) {
        self.requestID = requestID
        self.kind = kind
        self.workOrderID = workOrderID
        self.createdAt = createdAt
        self.resultType = resultType
        self.diagnosis = diagnosis
        self.actionTaken = actionTaken
        self.syncState = syncState
        self.lastError = lastError
        self.serverReplayed = serverReplayed
    }

    public var isSynced: Bool {
        syncState == .synced
    }

    public func toSyncOperationRequest() -> Components.Schemas.SyncOperationRequest {
        switch kind {
        case .workOrderStart:
            return Components.Schemas.SyncOperationRequest(
                requestId: requestID,
                operation: .workOrderStart,
                createdAt: createdAt,
                payload: .SyncWorkOrderStartPayload(
                    Components.Schemas.SyncWorkOrderStartPayload(workOrderId: workOrderID)
                )
            )
        case .workOrderReport:
            return Components.Schemas.SyncOperationRequest(
                requestId: requestID,
                operation: .workOrderReport,
                createdAt: createdAt,
                payload: .SyncWorkOrderReportPayload(
                    Components.Schemas.SyncWorkOrderReportPayload(
                        workOrderId: workOrderID,
                        resultType: resultType ?? .unknown,
                        diagnosis: diagnosis ?? "",
                        actionTaken: actionTaken ?? ""
                    )
                )
            )
        }
    }
}

public protocol MutationQueueStore: Sendable {
    func upsert(_ mutation: QueuedMutation) async throws
    func pending() async throws -> [QueuedMutation]
    func get(_ requestID: String) async throws -> QueuedMutation?
    func markSynced(requestID: String, serverReplayed: Bool) async throws
    func markFailed(requestID: String, message: String) async throws
}

public protocol SyncGateway: Sendable {
    func replay(
        deviceID: String,
        request: Components.Schemas.SyncBatchRequest
    ) async throws -> Components.Schemas.SyncBatchResponse
}

public struct ReplaySummary: Equatable, Sendable {
    public var attempted: Int
    public var applied: Int
    public var failed: Int
    public var cached: Int

    public init(attempted: Int, applied: Int, failed: Int, cached: Int) {
        self.attempted = attempted
        self.applied = applied
        self.failed = failed
        self.cached = cached
    }

    public static let empty = ReplaySummary(attempted: 0, applied: 0, failed: 0, cached: 0)
}

public struct OfflineQueueRepository: Sendable {
    private let store: any MutationQueueStore
    private let syncGateway: any SyncGateway
    private let deviceIDProvider: @Sendable () -> String
    private let requestIDFactory: any RequestIDFactory
    private let syncIDFactory: any RequestIDFactory
    private let clock: any FieldClock

    public init(
        store: any MutationQueueStore,
        syncGateway: any SyncGateway,
        deviceIDProvider: @escaping @Sendable () -> String,
        requestIDFactory: any RequestIDFactory = ULIDRequestIDFactory(),
        syncIDFactory: any RequestIDFactory = ULIDRequestIDFactory(),
        clock: any FieldClock = SystemFieldClock()
    ) {
        self.store = store
        self.syncGateway = syncGateway
        self.deviceIDProvider = deviceIDProvider
        self.requestIDFactory = requestIDFactory
        self.syncIDFactory = syncIDFactory
        self.clock = clock
    }

    @discardableResult
    public func enqueueStart(workOrderID: Components.Schemas.Uuid) async throws -> String {
        let requestID = requestIDFactory.nextID()
        try await store.upsert(
            QueuedMutation(
                requestID: requestID,
                kind: .workOrderStart,
                workOrderID: workOrderID,
                createdAt: clock.now()
            )
        )
        return requestID
    }

    @discardableResult
    public func enqueueReport(
        workOrderID: Components.Schemas.Uuid,
        resultType: Components.Schemas.WorkResultType,
        diagnosis: String,
        actionTaken: String
    ) async throws -> String {
        let requestID = requestIDFactory.nextID()
        try await store.upsert(
            QueuedMutation(
                requestID: requestID,
                kind: .workOrderReport,
                workOrderID: workOrderID,
                createdAt: clock.now(),
                resultType: resultType,
                diagnosis: diagnosis.trimmedForSubmission,
                actionTaken: actionTaken.trimmedForSubmission
            )
        )
        return requestID
    }

    public func replayPending() async throws -> ReplaySummary {
        let pending = try await store.pending()
        guard !pending.isEmpty else { return .empty }

        let request = Components.Schemas.SyncBatchRequest(
            syncId: syncIDFactory.nextID(),
            operations: pending.map { $0.toSyncOperationRequest() }
        )

        let response: Components.Schemas.SyncBatchResponse
        do {
            response = try await syncGateway.replay(deviceID: deviceIDProvider(), request: request)
        } catch {
            return ReplaySummary(attempted: pending.count, applied: 0, failed: pending.count, cached: 0)
        }

        var applied = 0
        var failed = 0
        var cached = 0

        for result in response.results {
            switch result.status {
            case .applied:
                applied += 1
                if result.replayed {
                    cached += 1
                }
                try await store.markSynced(requestID: result.requestId, serverReplayed: result.replayed)
            case .failed:
                failed += 1
                let message = result.error?.message ?? "offline_sync_failed"
                try await store.markFailed(requestID: result.requestId, message: message)
            }
        }

        return ReplaySummary(attempted: pending.count, applied: applied, failed: failed, cached: cached)
    }
}

public actor InMemoryMutationQueueStore: MutationQueueStore {
    private var mutations: [String: QueuedMutation] = [:]

    public init() {}

    public func upsert(_ mutation: QueuedMutation) {
        mutations[mutation.requestID] = mutation
    }

    public func pending() -> [QueuedMutation] {
        mutations.values
            .filter { $0.syncState == .pending }
            .sorted { $0.requestID < $1.requestID }
    }

    public func get(_ requestID: String) -> QueuedMutation? {
        mutations[requestID]
    }

    public func markSynced(requestID: String, serverReplayed: Bool) {
        guard var mutation = mutations[requestID] else { return }
        mutation.syncState = .synced
        mutation.lastError = nil
        mutation.serverReplayed = serverReplayed
        mutations[requestID] = mutation
    }

    public func markFailed(requestID: String, message: String) {
        guard var mutation = mutations[requestID] else { return }
        mutation.syncState = .failed
        mutation.lastError = message
        mutations[requestID] = mutation
    }
}
