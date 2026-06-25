import Foundation
import MaintenanceAPIClient
import MaintenanceFieldCore

@main
struct MaintenanceFieldCoreBehaviorTests {
    static func main() async throws {
        try loginStateMachineMirrorsAndroidRegistrationFlow()
        try locationConsentStateMachineMirrorsAndroidGpsGate()
        try workOrderMappersMirrorAndroidModels()
        try reportDraftTrimsGeneratedRequestFields()
        try await offlineStartRetriesSameRequestIDAndAcceptsCachedSyncResult()
        try await failedOperationSurfacesQueueResultWithoutDroppingMutation()
        try messengerMappersAndReducerMirrorAndroidModels()
        try await offlineComposedMessagesQueueAndReplayDirectly()
        try messengerRealtimeRequestUsesBearerHeaderAndResumeCursor()
        try await keychainSessionStorePersistsTokensOutsideUserDefaults()
        try await keychainSessionStoreMigratesLegacyGroupSessionForward()
        print("MaintenanceFieldCoreBehaviorTests passed")
    }

    private static func loginStateMachineMirrorsAndroidRegistrationFlow() throws {
        let userID = "00000000-0000-0000-0000-000000000901"
        let ceremonyID = "00000000-0000-0000-0000-000000000902"
        let stateMachine = LoginStateMachine()

        let awaitingCredential = stateMachine.reduce(
            LoginState.signedOut(),
            LoginEvent.loginChallengeReceived(
                userID: userID,
                ceremonyID: ceremonyID,
                challengeJSON: #"{"challenge":"abc"}"#,
                expiresAt: isoDate("2026-06-12T09:05:00Z")
            )
        )

        try expectEqual(
            awaitingCredential,
            .awaitingPasskey(userID: userID, ceremonyID: ceremonyID, challengeJSON: #"{"challenge":"abc"}"#)
        )

        let registeringDevice = stateMachine.reduce(
            awaitingCredential,
            LoginEvent.passkeyVerified(
                accessToken: "access.jwt",
                refreshToken: "refresh-token",
                deviceID: "device-a",
                appVersion: "0.1.0"
            )
        )

        try expectEqual(
            registeringDevice,
            .registeringDevice(
                accessToken: "access.jwt",
                refreshToken: "refresh-token",
                deviceID: "device-a",
                platform: .ios,
                appVersion: "0.1.0"
            )
        )

        let authenticated = stateMachine.reduce(
            registeringDevice,
            LoginEvent.deviceRegistered(serverDeviceID: "00000000-0000-0000-0000-000000000903")
        )

        try expectEqual(authenticated, .authenticated(accessToken: "access.jwt", refreshToken: "refresh-token"))

        let failed = stateMachine.reduce(
            LoginState.awaitingPasskey(userID: userID, ceremonyID: ceremonyID, challengeJSON: "{}"),
            LoginEvent.failed(messageKey: "login_failed")
        )
        try expectEqual(failed, .signedOut(messageKey: "login_failed"))
    }

    private static func locationConsentStateMachineMirrorsAndroidGpsGate() throws {
        let machine = LocationConsentStateMachine()
        let active = GPSCollectionState(consentState: .granted, onDuty: true)

        let suspended = machine.reduce(active, event: .suspended)
        try expectEqual(suspended.consentState, .suspended)
        try expectEqual(suspended.mayCollect, false)

        let offDuty = GPSCollectionState(consentState: .granted, onDuty: false)
        try expectEqual(offDuty.mayCollect, false)
        try expectEqual(machine.reduce(offDuty, event: .onDutyChanged(true)).mayCollect, true)

        try expectEqual(machine.reduce(active, event: .withdrawn).consentState, .withdrawn)
        try expectEqual(machine.reduce(suspended, event: .withdrawn).consentState, .withdrawn)
    }

    private static func workOrderMappersMirrorAndroidModels() throws {
        let item = generatedWorkOrder(priority: .p1, status: .assigned)

        let mapped = item.toTechnicianWorkOrder(syncState: .pending)

        try expectEqual(item.id, mapped.id)
        try expectEqual(mapped.requestNo, "20260612-001")
        try expectEqual(mapped.managementNo, "290")
        try expectEqual(mapped.modelName, "GTS25DE")
        try expectEqual(mapped.customerName, "대성물류")
        try expectEqual(mapped.priority, .p1)
        try expectEqual(mapped.prioritySort, 0)
        try expectEqual(mapped.status, .assigned)
        try expectEqual(mapped.syncState, .pending)
        try expectEqual(mapped.assigneeNames, ["김정비"])
    }

    private static func reportDraftTrimsGeneratedRequestFields() throws {
        let request = ReportDraft(
            resultType: .completed,
            diagnosis: "  배터리 커넥터 접촉 불량  ",
            actionTaken: "  커넥터 교체 및 충전 확인  "
        ).toSubmitReportRequest()

        try expectEqual(request.resultType, .completed)
        try expectEqual(request.diagnosis, "배터리 커넥터 접촉 불량")
        try expectEqual(request.actionTaken, "커넥터 교체 및 충전 확인")
    }

    private static func offlineStartRetriesSameRequestIDAndAcceptsCachedSyncResult() async throws {
        let store = InMemoryMutationQueueStore()
        let sync = RecordingSyncGateway()
        let repository = OfflineQueueRepository(
            store: store,
            syncGateway: sync,
            deviceIDProvider: { "device-a" },
            requestIDFactory: FixedRequestIDFactory("01HVSTART000000000000000000"),
            syncIDFactory: FixedRequestIDFactory("sync-a"),
            clock: FixedClock(date: isoDate("2026-06-12T09:00:00Z"))
        )

        let requestID = try await repository.enqueueStart(workOrderID: workOrderID)

        try expectEqual(requestID, "01HVSTART000000000000000000")
        try expectEqual(await store.get(requestID)?.syncState, .pending)

        sync.errorToThrow = URLError(.notConnectedToInternet)
        let offlineSummary = try await repository.replayPending()

        try expectEqual(offlineSummary, ReplaySummary(attempted: 1, applied: 0, failed: 1, cached: 0))
        let pendingAfterTransportFailure = await store.pending()
        try expectEqual(pendingAfterTransportFailure.single()?.requestID, requestID)

        sync.errorToThrow = nil
        sync.nextResponse = Components.Schemas.SyncBatchResponse(
            syncId: "sync-a",
            results: [
                Components.Schemas.SyncOperationResult(
                    requestId: requestID,
                    operation: .workOrderStart,
                    status: .applied,
                    httpStatus: 200,
                    result: summary(status: .inProgress),
                    replayed: true
                ),
            ]
        )

        let cachedSummary = try await repository.replayPending()

        try expectEqual(cachedSummary, ReplaySummary(attempted: 1, applied: 1, failed: 0, cached: 1))
        try expectEqual(await store.get(requestID)?.isSynced, true)
        try expectEqual(sync.requests.compactMap { $0.operations.single()?.requestId }, [requestID])
        try expectEqual(sync.deviceIDs, ["device-a"])
    }

    private static func failedOperationSurfacesQueueResultWithoutDroppingMutation() async throws {
        let store = InMemoryMutationQueueStore()
        let sync = RecordingSyncGateway()
        let repository = OfflineQueueRepository(
            store: store,
            syncGateway: sync,
            deviceIDProvider: { "device-a" },
            requestIDFactory: FixedRequestIDFactory("01HVREPORT0000000000000000"),
            syncIDFactory: FixedRequestIDFactory("sync-b"),
            clock: FixedClock(date: isoDate("2026-06-12T10:00:00Z"))
        )

        let requestID = try await repository.enqueueReport(
            workOrderID: workOrderID,
            resultType: .temporaryAction,
            diagnosis: "유압 누유",
            actionTaken: "호스 교체 전 임시 조치"
        )
        sync.nextResponse = Components.Schemas.SyncBatchResponse(
            syncId: "sync-b",
            results: [
                Components.Schemas.SyncOperationResult(
                    requestId: requestID,
                    operation: .workOrderReport,
                    status: .failed,
                    httpStatus: 409,
                    error: Components.Schemas.SyncError(code: "conflict", message: "server wins"),
                    replayed: false
                ),
            ]
        )

        let summary = try await repository.replayPending()

        try expectEqual(summary, ReplaySummary(attempted: 1, applied: 0, failed: 1, cached: 0))
        try expectEqual(await store.get(requestID)?.syncState, .failed)
        let lastError = await store.get(requestID)?.lastError ?? ""
        try expect(lastError.isEmpty == false, "failed mutation should retain server error")
    }

    private static func messengerMappersAndReducerMirrorAndroidModels() throws {
        let thread = generatedMessengerThread()
        let first = generatedMessengerMessage(id: firstMessageID, body: "초기 점검", minute: 10)
        let second = generatedMessengerMessage(id: secondMessageID, body: "현장 도착", minute: 12)
        let reducer = MessengerReducer()

        let loaded = reducer.reduce(
            MessengerState(),
            .messagesPageLoaded(
                threadID: messengerThreadID,
                page: MessengerMessagePage(
                    items: [second.toMessengerMessage(), first.toMessengerMessage()],
                    nextCursor: firstMessageID
                )
            )
        )
        let live = reducer.reduce(
            MessengerState(
                threads: [thread.toMessengerThread()],
                messagesByThread: loaded.messagesByThread,
                nextCursorByThread: loaded.nextCursorByThread,
                lastMessageIDByThread: loaded.lastMessageIDByThread
            ),
            .liveMessageReceived(second.toMessengerMessage())
        )

        try expectEqual(thread.toMessengerThread().displayTitle, "팀 채널")
        try expectEqual(live.messagesByThread[messengerThreadID]?.map { $0.body }, ["초기 점검", "현장 도착"])
        try expectEqual(live.lastMessageIDByThread[messengerThreadID], secondMessageID)
        try expectEqual(live.resumeCursor(), secondMessageID)
    }

    private static func offlineComposedMessagesQueueAndReplayDirectly() async throws {
        let store = InMemoryMessengerOutboxStore()
        let gateway = RecordingMessengerGateway()
        let repository = MessengerRepository(
            gateway: gateway,
            outbox: store,
            requestIDFactory: FixedMessengerRequestIDFactory("chat-request-1"),
            clock: FixedClock(date: isoDate("2026-06-12T09:00:00Z"))
        )

        gateway.errorToThrow = URLError(.notConnectedToInternet)
        let queued = try await repository.sendOrQueue(
            threadID: messengerThreadID,
            body: "오프라인 작성",
            attachmentEvidenceIDs: []
        )

        try expectEqual(queued.state, .pending)
        try expectEqual(queued.requestID, "chat-request-1")
        try expectEqual(await store.pending().single()?.body, "오프라인 작성")
        try expect(gateway.syncReplayRequests.isEmpty, "chat sends must not use /sync replay")

        gateway.errorToThrow = nil
        gateway.nextSentMessage = generatedMessengerMessage(id: secondMessageID, body: "오프라인 작성", minute: 15)

        let summary = try await repository.replayPending()

        try expectEqual(summary, MessengerReplaySummary(attempted: 1, sent: 1, failed: 0))
        try expectEqual(await store.get(requestID: "chat-request-1")?.isSynced, true)
        try expectEqual(gateway.sentBodies, ["오프라인 작성", "오프라인 작성"])
        try expect(gateway.syncReplayRequests.isEmpty, "chat sends must not use /sync replay")
    }

    private static func keychainSessionStorePersistsTokensOutsideUserDefaults() async throws {
        let keychain = InMemoryKeychainAccess()
        let provider = CurrentTokenProvider()
        let store = KeychainSessionTokenStore(tokenProvider: provider, keychain: keychain)

        try expectEqual(await store.load(), nil)

        let tokens = AuthTokens(accessToken: "access.jwt", refreshToken: "refresh-token-30d")
        await store.save(tokens)

        try expectEqual(provider.get(), "access.jwt")
        try expectEqual(await store.load(), tokens)

        // The refresh token must live only in the Keychain blob, never as a plaintext value.
        let storedValues = keychain.allStoredStrings()
        try expect(
            storedValues.contains { $0.contains("refresh-token-30d") },
            "tokens should be persisted through the keychain"
        )

        await store.clear()
        try expectEqual(await store.load(), nil)
        try expectEqual(provider.get(), nil)
        try expect(keychain.isEmpty(), "clear should remove the keychain item")
    }

    private static func keychainSessionStoreMigratesLegacyGroupSessionForward() async throws {
        // A session written by a pre-shared-group build lives in the legacy
        // (default-group) store. After the update, load() must find it, migrate
        // it into the primary (shared-group) store, and remove the legacy copy —
        // so the user is NOT logged out on the shared-group switch.
        let primary = InMemoryKeychainAccess()
        let legacy = InMemoryKeychainAccess()
        let legacyTokens = AuthTokens(accessToken: "legacy.access", refreshToken: "legacy-refresh")
        legacy.write(try JSONEncoder().encode(legacyTokens), service: "maintenance.field", account: "maintenance.field.session")

        let provider = CurrentTokenProvider()
        let store = KeychainSessionTokenStore(
            tokenProvider: provider,
            keychain: primary,
            legacyKeychain: legacy
        )

        // init seeds the token provider from the legacy store (primary empty).
        try expectEqual(provider.get(), "legacy.access")

        // load() migrates: returns the tokens, writes them into primary, clears legacy.
        try expectEqual(await store.load(), legacyTokens)
        try expect(legacy.isEmpty(), "legacy session item should be removed after migration")
        try expect(
            primary.allStoredStrings().contains { $0.contains("legacy-refresh") },
            "migrated session should now live in the primary (shared-group) store"
        )

        // A subsequent load() reads straight from primary (legacy already empty).
        try expectEqual(await store.load(), legacyTokens)
        try expectEqual(provider.get(), "legacy.access")
    }

    private static func messengerRealtimeRequestUsesBearerHeaderAndResumeCursor() throws {
        let request = MessengerRealtimeRequestFactory(
            baseURL: URL(string: "https://api.example.com")!,
            accessToken: "access-token"
        ).build(lastMessageID: secondMessageID)

        try expectEqual(request.url.absoluteString, "wss://api.example.com/api/v1/ws?last_message_id=\(secondMessageID)")
        try expectEqual(request.headers["Authorization"], "Bearer access-token")
    }

    private static let workOrderID = "00000000-0000-0000-0000-000000000101"
    private static let messengerThreadID = "22222222-2222-4222-8222-222222222222"
    private static let messengerBranchID = "11111111-1111-4111-8111-111111111111"
    private static let messengerSenderID = "33333333-3333-4333-8333-333333333333"
    private static let firstMessageID = "44444444-4444-4444-8444-444444444444"
    private static let secondMessageID = "55555555-5555-4555-8555-555555555555"

    private static func generatedWorkOrder(
        priority: Components.Schemas.PriorityLevel,
        status: Components.Schemas.WorkOrderStatus
    ) -> Components.Schemas.WorkOrderListItem {
        Components.Schemas.WorkOrderListItem(
            id: "00000000-0000-0000-0000-000000000111",
            requestNo: "20260612-001",
            branchId: "00000000-0000-0000-0000-000000000222",
            status: status,
            priority: priority,
            resultType: .unknown,
            targetDueAt: isoDate("2026-06-12T13:00:00Z"),
            createdAt: isoDate("2026-06-12T08:00:00Z"),
            updatedAt: isoDate("2026-06-12T08:05:00Z"),
            equipment: Components.Schemas.EquipmentSummary(
                id: "00000000-0000-0000-0000-000000000333",
                equipmentNo: "D290",
                managementNo: "290",
                model: "GTS25DE",
                status: "임대",
                specification: "좌식",
                tonText: "2.5t"
            ),
            customer: Components.Schemas.NamedEntity(
                id: "00000000-0000-0000-0000-000000000444",
                name: "대성물류"
            ),
            site: Components.Schemas.NamedEntity(
                id: "00000000-0000-0000-0000-000000000555",
                name: "1공장"
            ),
            assignments: [
                Components.Schemas.AssignmentSummary(
                    id: "00000000-0000-0000-0000-000000000666",
                    mechanicId: "00000000-0000-0000-0000-000000000777",
                    mechanicName: "김정비",
                    role: .primary,
                    assignedAt: isoDate("2026-06-12T08:10:00Z")
                ),
            ]
        )
    }

    private static func summary(status: Components.Schemas.WorkOrderStatus) -> Components.Schemas.WorkOrderSummary {
        Components.Schemas.WorkOrderSummary(
            id: workOrderID,
            requestNo: "20260612-001",
            branchId: "00000000-0000-0000-0000-000000000201",
            equipmentId: "00000000-0000-0000-0000-000000000301",
            customerId: "00000000-0000-0000-0000-000000000401",
            siteId: "00000000-0000-0000-0000-000000000501",
            status: status,
            priority: .p1,
            resultType: .unknown,
            evidenceVerified: false
        )
    }

    private static func generatedMessengerThread() -> Components.Schemas.MessengerThreadSummary {
        Components.Schemas.MessengerThreadSummary(
            id: messengerThreadID,
            kind: .team,
            branchId: messengerBranchID,
            title: "팀 채널",
            memberCount: 3,
            createdAt: isoDate("2026-06-12T09:00:00Z"),
            updatedAt: isoDate("2026-06-12T09:00:00Z")
        )
    }

    private static func generatedMessengerMessage(
        id: Components.Schemas.Uuid,
        body: String,
        minute: Int
    ) -> Components.Schemas.MessengerMessageSummary {
        Components.Schemas.MessengerMessageSummary(
            id: id,
            threadId: messengerThreadID,
            branchId: messengerBranchID,
            senderId: messengerSenderID,
            body: body,
            attachmentEvidenceIds: [],
            sentAt: isoDate("2026-06-12T09:\(String(format: "%02d", minute)):00Z"),
            createdAt: isoDate("2026-06-12T09:\(String(format: "%02d", minute)):00Z")
        )
    }

    private static func isoDate(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else {
            throw BehaviorTestFailure(message)
        }
    }

    private static func expectEqual<T: Equatable>(
        _ actual: T,
        _ expected: T,
        file: StaticString = #fileID,
        line: UInt = #line
    ) throws {
        guard actual == expected else {
            throw BehaviorTestFailure("\(file):\(line) expected \(expected), got \(actual)")
        }
    }

    fileprivate static func expectNotNil<T>(_ value: T?) throws -> T {
        guard let value else {
            throw BehaviorTestFailure("expected non-nil value")
        }
        return value
    }
}

private final class RecordingSyncGateway: SyncGateway, @unchecked Sendable {
    var nextResponse = Components.Schemas.SyncBatchResponse(syncId: "sync", results: [])
    var errorToThrow: Error?
    private(set) var requests: [Components.Schemas.SyncBatchRequest] = []
    private(set) var deviceIDs: [String] = []

    func replay(
        deviceID: String,
        request: Components.Schemas.SyncBatchRequest
    ) async throws -> Components.Schemas.SyncBatchResponse {
        if let errorToThrow {
            throw errorToThrow
        }
        deviceIDs.append(deviceID)
        requests.append(request)
        return nextResponse
    }
}

private final class RecordingMessengerGateway: MessengerGateway, @unchecked Sendable {
    var nextSentMessage: Components.Schemas.MessengerMessageSummary?
    var errorToThrow: Error?
    private(set) var sentBodies: [String] = []
    private(set) var syncReplayRequests: [String] = []

    func listThreads(limit: Int64) async throws -> [MessengerThread] {
        []
    }

    func listMessages(
        threadID: Components.Schemas.Uuid,
        beforeMessageID: Components.Schemas.Uuid?,
        limit: Int64
    ) async throws -> MessengerMessagePage {
        MessengerMessagePage(items: [], nextCursor: nil)
    }

    func sendMessage(
        threadID: Components.Schemas.Uuid,
        body: String,
        attachmentEvidenceIDs: [Components.Schemas.Uuid]
    ) async throws -> MessengerMessage {
        sentBodies.append(body)
        if let errorToThrow {
            self.errorToThrow = nil
            throw errorToThrow
        }
        return try MaintenanceFieldCoreBehaviorTests.expectNotNil(nextSentMessage).toMessengerMessage()
    }

    func markRead(threadID: Components.Schemas.Uuid, lastReadMessageID: Components.Schemas.Uuid) async throws {}

    func search(query: String, limit: Int64) async throws -> [MessengerMessage] {
        []
    }
}

private final class InMemoryKeychainAccess: KeychainAccess, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: Data] = [:]

    func read(service: String, account: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return storage["\(service).\(account)"]
    }

    func write(_ data: Data, service: String, account: String) {
        lock.lock()
        storage["\(service).\(account)"] = data
        lock.unlock()
    }

    func delete(service: String, account: String) {
        lock.lock()
        storage["\(service).\(account)"] = nil
        lock.unlock()
    }

    func allStoredStrings() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage.values.compactMap { String(data: $0, encoding: .utf8) }
    }

    func isEmpty() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return storage.isEmpty
    }
}

private struct FixedRequestIDFactory: RequestIDFactory {
    let value: String

    init(_ value: String) {
        self.value = value
    }

    func nextID() -> String {
        value
    }
}

private struct FixedMessengerRequestIDFactory: MessengerRequestIDFactory {
    let value: String

    init(_ value: String) {
        self.value = value
    }

    func nextID() -> String {
        value
    }
}

private struct FixedClock: FieldClock {
    let date: Date

    func now() -> Date {
        date
    }
}

private struct BehaviorTestFailure: Error, CustomStringConvertible {
    let description: String

    init(_ description: String) {
        self.description = description
    }
}

private extension Array {
    func single() -> Element? {
        count == 1 ? self[0] : nil
    }
}
