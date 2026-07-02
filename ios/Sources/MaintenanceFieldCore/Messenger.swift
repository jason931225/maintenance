import Foundation
import MaintenanceAPIClient

public struct MessengerThread: Identifiable, Hashable, Sendable {
    public let id: Components.Schemas.Uuid
    public let kind: Components.Schemas.MessengerThreadKind
    public let branchID: Components.Schemas.Uuid
    public let title: String?
    public let workOrderID: Components.Schemas.Uuid?
    public let lastMessageID: Components.Schemas.Uuid?
    public let lastMessageAt: Date?
    public let memberCount: Int64
    public let createdAt: Date
    public let updatedAt: Date

    public init(
        id: Components.Schemas.Uuid,
        kind: Components.Schemas.MessengerThreadKind,
        branchID: Components.Schemas.Uuid,
        title: String?,
        workOrderID: Components.Schemas.Uuid?,
        lastMessageID: Components.Schemas.Uuid?,
        lastMessageAt: Date?,
        memberCount: Int64,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.kind = kind
        self.branchID = branchID
        self.title = title
        self.workOrderID = workOrderID
        self.lastMessageID = lastMessageID
        self.lastMessageAt = lastMessageAt
        self.memberCount = memberCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public extension MessengerThread {
    var displayTitle: String {
        if let title, title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            return title
        }
        switch kind {
        case .workOrder:
            return "WO \(workOrderID ?? id)"
        case .team:
            return "팀 채널"
        case .dm:
            return "1:1 대화"
        case .group:
            return "그룹 대화"
        }
    }
}

public struct MessengerMessage: Identifiable, Hashable, Sendable {
    public let id: Components.Schemas.Uuid
    public let threadID: Components.Schemas.Uuid
    public let branchID: Components.Schemas.Uuid
    public let senderID: Components.Schemas.Uuid
    public let body: String
    public let readCount: Int64
    public let readTargetCount: Int64
    public let attachmentEvidenceIDs: [Components.Schemas.Uuid]
    public let sentAt: Date
    public let createdAt: Date

    public init(
        id: Components.Schemas.Uuid,
        threadID: Components.Schemas.Uuid,
        branchID: Components.Schemas.Uuid,
        senderID: Components.Schemas.Uuid,
        body: String,
        readCount: Int64,
        readTargetCount: Int64,
        attachmentEvidenceIDs: [Components.Schemas.Uuid],
        sentAt: Date,
        createdAt: Date
    ) {
        self.id = id
        self.threadID = threadID
        self.branchID = branchID
        self.senderID = senderID
        self.body = body
        self.readCount = readCount
        self.readTargetCount = readTargetCount
        self.attachmentEvidenceIDs = attachmentEvidenceIDs
        self.sentAt = sentAt
        self.createdAt = createdAt
    }
}

public struct MessengerMessagePage: Hashable, Sendable {
    public let items: [MessengerMessage]
    public let nextCursor: Components.Schemas.Uuid?

    public init(items: [MessengerMessage], nextCursor: Components.Schemas.Uuid?) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

public struct MessengerState: Hashable, Sendable {
    public var threads: [MessengerThread]
    public var selectedThreadID: Components.Schemas.Uuid?
    public var messagesByThread: [Components.Schemas.Uuid: [MessengerMessage]]
    public var nextCursorByThread: [Components.Schemas.Uuid: Components.Schemas.Uuid?]
    public var lastMessageIDByThread: [Components.Schemas.Uuid: Components.Schemas.Uuid]
    public var searchResults: [MessengerMessage]

    public init(
        threads: [MessengerThread] = [],
        selectedThreadID: Components.Schemas.Uuid? = nil,
        messagesByThread: [Components.Schemas.Uuid: [MessengerMessage]] = [:],
        nextCursorByThread: [Components.Schemas.Uuid: Components.Schemas.Uuid?] = [:],
        lastMessageIDByThread: [Components.Schemas.Uuid: Components.Schemas.Uuid] = [:],
        searchResults: [MessengerMessage] = []
    ) {
        self.threads = threads
        self.selectedThreadID = selectedThreadID
        self.messagesByThread = messagesByThread
        self.nextCursorByThread = nextCursorByThread
        self.lastMessageIDByThread = lastMessageIDByThread
        self.searchResults = searchResults
    }

    public func resumeCursor() -> Components.Schemas.Uuid? {
        messagesByThread.values
            .flatMap(\.self)
            .sortedForDisplay()
            .last?
            .id
    }
}

public enum MessengerAction: Sendable {
    case threadsLoaded([MessengerThread])
    case threadSelected(Components.Schemas.Uuid)
    case messagesPageLoaded(threadID: Components.Schemas.Uuid, page: MessengerMessagePage)
    case liveMessageReceived(MessengerMessage)
    case messageSent(MessengerMessage)
    case searchResultsLoaded([MessengerMessage])
}

public struct MessengerReducer: Sendable {
    public init() {}

    public func reduce(_ state: MessengerState, _ action: MessengerAction) -> MessengerState {
        switch action {
        case let .threadsLoaded(threads):
            var next = state
            next.threads = threads.sortedForDisplay()
            next.selectedThreadID = state.selectedThreadID ?? next.threads.first?.id
            return next
        case let .threadSelected(threadID):
            var next = state
            next.selectedThreadID = threadID
            return next
        case let .messagesPageLoaded(threadID, page):
            var next = state
            let messages = mergeMessages(
                existing: state.messagesByThread[threadID, default: []],
                incoming: page.items
            )
            next.messagesByThread[threadID] = messages
            next.nextCursorByThread[threadID] = page.nextCursor
            if let last = messages.last {
                next.lastMessageIDByThread[threadID] = last.id
            }
            return next
        case let .liveMessageReceived(message), let .messageSent(message):
            return upsert(message: message, into: state)
        case let .searchResultsLoaded(messages):
            var next = state
            next.searchResults = messages.sortedForDisplay()
            return next
        }
    }

    private func upsert(message: MessengerMessage, into state: MessengerState) -> MessengerState {
        var next = state
        next.messagesByThread[message.threadID] = mergeMessages(
            existing: state.messagesByThread[message.threadID, default: []],
            incoming: [message]
        )
        next.lastMessageIDByThread[message.threadID] = message.id
        next.threads = state.threads
            .map { thread in
                guard thread.id == message.threadID else { return thread }
                return MessengerThread(
                    id: thread.id,
                    kind: thread.kind,
                    branchID: thread.branchID,
                    title: thread.title,
                    workOrderID: thread.workOrderID,
                    lastMessageID: message.id,
                    lastMessageAt: message.sentAt,
                    memberCount: thread.memberCount,
                    createdAt: thread.createdAt,
                    updatedAt: message.createdAt
                )
            }
            .sortedForDisplay()
        return next
    }

    private func mergeMessages(
        existing: [MessengerMessage],
        incoming: [MessengerMessage]
    ) -> [MessengerMessage] {
        var messagesByID = [Components.Schemas.Uuid: MessengerMessage]()
        for message in existing + incoming {
            messagesByID[message.id] = message
        }
        return Array(messagesByID.values).sortedForDisplay()
    }
}

public enum MessengerSendState: String, Codable, Sendable {
    case sent
    case pending
    case failed
}

public struct MessengerSendResult: Sendable {
    public let requestID: String?
    public let state: MessengerSendState
    public let message: MessengerMessage?

    public init(requestID: String?, state: MessengerSendState, message: MessengerMessage? = nil) {
        self.requestID = requestID
        self.state = state
        self.message = message
    }
}

public struct QueuedMessengerMessage: Identifiable, Codable, Hashable, Sendable {
    public let requestID: String
    public let threadID: Components.Schemas.Uuid
    public let body: String
    public let attachmentEvidenceIDs: [Components.Schemas.Uuid]
    public let createdAt: Date
    public let state: MessengerSendState
    public let lastError: String?

    public var id: String { requestID }
    public var isSynced: Bool { state == .sent }

    public init(
        requestID: String,
        threadID: Components.Schemas.Uuid,
        body: String,
        attachmentEvidenceIDs: [Components.Schemas.Uuid],
        createdAt: Date,
        state: MessengerSendState = .pending,
        lastError: String? = nil
    ) {
        self.requestID = requestID
        self.threadID = threadID
        self.body = body
        self.attachmentEvidenceIDs = attachmentEvidenceIDs
        self.createdAt = createdAt
        self.state = state
        self.lastError = lastError
    }
}

public struct MessengerReplaySummary: Equatable, Sendable {
    public let attempted: Int
    public let sent: Int
    public let failed: Int

    public init(attempted: Int, sent: Int, failed: Int) {
        self.attempted = attempted
        self.sent = sent
        self.failed = failed
    }
}

public protocol MessengerGateway: Sendable {
    func listThreads(limit: Int64) async throws -> [MessengerThread]
    func listMessages(
        threadID: Components.Schemas.Uuid,
        beforeMessageID: Components.Schemas.Uuid?,
        limit: Int64
    ) async throws -> MessengerMessagePage
    func sendMessage(
        threadID: Components.Schemas.Uuid,
        body: String,
        attachmentEvidenceIDs: [Components.Schemas.Uuid]
    ) async throws -> MessengerMessage
    func markRead(threadID: Components.Schemas.Uuid, lastReadMessageID: Components.Schemas.Uuid) async throws
    func search(query: String, limit: Int64) async throws -> [MessengerMessage]
}

public protocol MessengerOutboxStore: Sendable {
    func upsert(_ message: QueuedMessengerMessage) async throws
    func pending() async throws -> [QueuedMessengerMessage]
    func get(requestID: String) async throws -> QueuedMessengerMessage?
    func markSent(requestID: String) async throws
    func markFailed(requestID: String, message: String) async throws
}

public actor InMemoryMessengerOutboxStore: MessengerOutboxStore {
    private var messages: [String: QueuedMessengerMessage] = [:]

    public init() {}

    public func upsert(_ message: QueuedMessengerMessage) {
        messages[message.requestID] = message
    }

    public func pending() -> [QueuedMessengerMessage] {
        messages.values
            .filter { $0.state == .pending }
            .sorted { $0.createdAt < $1.createdAt }
    }

    public func get(requestID: String) -> QueuedMessengerMessage? {
        messages[requestID]
    }

    public func markSent(requestID: String) {
        guard let message = messages[requestID] else { return }
        messages[requestID] = QueuedMessengerMessage(
            requestID: message.requestID,
            threadID: message.threadID,
            body: message.body,
            attachmentEvidenceIDs: message.attachmentEvidenceIDs,
            createdAt: message.createdAt,
            state: .sent,
            lastError: nil
        )
    }

    public func markFailed(requestID: String, message errorMessage: String) {
        guard let message = messages[requestID] else { return }
        messages[requestID] = QueuedMessengerMessage(
            requestID: message.requestID,
            threadID: message.threadID,
            body: message.body,
            attachmentEvidenceIDs: message.attachmentEvidenceIDs,
            createdAt: message.createdAt,
            state: .failed,
            lastError: errorMessage
        )
    }
}

public protocol MessengerRequestIDFactory: Sendable {
    func nextID() -> String
}

public struct UUIDMessengerRequestIDFactory: MessengerRequestIDFactory {
    public init() {}
    public func nextID() -> String { UUID().uuidString.lowercased() }
}

public struct MessengerRepository: Sendable {
    private let gateway: any MessengerGateway
    private let outbox: any MessengerOutboxStore
    private let requestIDFactory: any MessengerRequestIDFactory
    private let clock: any FieldClock

    public init(
        gateway: any MessengerGateway,
        outbox: any MessengerOutboxStore,
        requestIDFactory: any MessengerRequestIDFactory = UUIDMessengerRequestIDFactory(),
        clock: any FieldClock = SystemFieldClock()
    ) {
        self.gateway = gateway
        self.outbox = outbox
        self.requestIDFactory = requestIDFactory
        self.clock = clock
    }

    public func loadThreads(limit: Int64 = 50) async throws -> [MessengerThread] {
        try await gateway.listThreads(limit: limit)
    }

    public func loadMessages(
        threadID: Components.Schemas.Uuid,
        beforeMessageID: Components.Schemas.Uuid? = nil,
        limit: Int64 = 50
    ) async throws -> MessengerMessagePage {
        try await gateway.listMessages(threadID: threadID, beforeMessageID: beforeMessageID, limit: limit)
    }

    public func search(query: String, limit: Int64 = 50) async throws -> [MessengerMessage] {
        try await gateway.search(query: query, limit: limit)
    }

    public func markRead(threadID: Components.Schemas.Uuid, lastReadMessageID: Components.Schemas.Uuid) async throws {
        try await gateway.markRead(threadID: threadID, lastReadMessageID: lastReadMessageID)
    }

    public func sendOrQueue(
        threadID: Components.Schemas.Uuid,
        body: String,
        attachmentEvidenceIDs: [Components.Schemas.Uuid]
    ) async throws -> MessengerSendResult {
        let trimmedBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let message = try await gateway.sendMessage(
                threadID: threadID,
                body: trimmedBody,
                attachmentEvidenceIDs: attachmentEvidenceIDs
            )
            return MessengerSendResult(requestID: nil, state: .sent, message: message)
        } catch {
            let requestID = requestIDFactory.nextID()
            try await outbox.upsert(
                QueuedMessengerMessage(
                    requestID: requestID,
                    threadID: threadID,
                    body: trimmedBody,
                    attachmentEvidenceIDs: attachmentEvidenceIDs,
                    createdAt: clock.now()
                )
            )
            return MessengerSendResult(requestID: requestID, state: .pending)
        }
    }

    public func replayPending() async -> MessengerReplaySummary {
        let pending = (try? await outbox.pending()) ?? []
        var sent = 0
        var failed = 0

        for message in pending {
            do {
                _ = try await gateway.sendMessage(
                    threadID: message.threadID,
                    body: message.body,
                    attachmentEvidenceIDs: message.attachmentEvidenceIDs
                )
                try await outbox.markSent(requestID: message.requestID)
                sent += 1
            } catch {
                try? await outbox.markFailed(requestID: message.requestID, message: error.localizedDescription)
                failed += 1
            }
        }

        return MessengerReplaySummary(attempted: pending.count, sent: sent, failed: failed)
    }
}

public struct MessengerRealtimeRequest: Equatable, Sendable {
    public let url: URL
    public let headers: [String: String]

    public init(url: URL, headers: [String: String]) {
        self.url = url
        self.headers = headers
    }
}

public struct MessengerRealtimeRequestFactory: Sendable {
    private let baseURL: URL
    private let accessToken: String

    public init(baseURL: URL, accessToken: String) {
        self.baseURL = baseURL
        self.accessToken = accessToken
    }

    public func build(lastMessageID: Components.Schemas.Uuid? = nil) -> MessengerRealtimeRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/api/v1/ws"
        if let lastMessageID {
            components.queryItems = [URLQueryItem(name: "last_message_id", value: lastMessageID)]
        }
        return MessengerRealtimeRequest(
            url: components.url!,
            headers: ["Authorization": "Bearer \(accessToken)"]
        )
    }
}

public final class MessengerRealtimeClient: @unchecked Sendable {
    private let urlSession: URLSession
    private let requestFactory: MessengerRealtimeRequestFactory

    public init(
        urlSession: URLSession = .shared,
        requestFactory: MessengerRealtimeRequestFactory
    ) {
        self.urlSession = urlSession
        self.requestFactory = requestFactory
    }

    public func connect(
        lastMessageID: Components.Schemas.Uuid? = nil,
        onMessage: @escaping @Sendable (String) -> Void,
        onDisconnect: @escaping @Sendable () -> Void,
        onFailure: @escaping @Sendable (Error) -> Void
    ) -> URLSessionWebSocketTask {
        let realtimeRequest = requestFactory.build(lastMessageID: lastMessageID)
        var request = URLRequest(url: realtimeRequest.url)
        for (name, value) in realtimeRequest.headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let task = urlSession.webSocketTask(with: request)
        task.resume()
        receive(task: task, onMessage: onMessage, onDisconnect: onDisconnect, onFailure: onFailure)
        return task
    }

    private func receive(
        task: URLSessionWebSocketTask,
        onMessage: @escaping @Sendable (String) -> Void,
        onDisconnect: @escaping @Sendable () -> Void,
        onFailure: @escaping @Sendable (Error) -> Void
    ) {
        task.receive { [weak self] result in
            switch result {
            case let .success(message):
                switch message {
                case let .string(text):
                    onMessage(text)
                case let .data(data):
                    if let text = String(data: data, encoding: .utf8) {
                        onMessage(text)
                    }
                @unknown default:
                    break
                }
                self?.receive(task: task, onMessage: onMessage, onDisconnect: onDisconnect, onFailure: onFailure)
            case let .failure(error):
                if (error as NSError).code == NSURLErrorCancelled {
                    onDisconnect()
                } else {
                    onFailure(error)
                }
            }
        }
    }
}

public extension Components.Schemas.MessengerThreadSummary {
    func toMessengerThread() -> MessengerThread {
        MessengerThread(
            id: id,
            kind: kind,
            branchID: branchId,
            title: title,
            workOrderID: workOrderId,
            lastMessageID: lastMessageId,
            lastMessageAt: lastMessageAt,
            memberCount: memberCount,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }
}

public extension Components.Schemas.MessengerMessageSummary {
    func toMessengerMessage() -> MessengerMessage {
        MessengerMessage(
            id: id,
            threadID: threadId,
            branchID: branchId,
            senderID: senderId,
            body: body,
            readCount: readCount,
            readTargetCount: readTargetCount,
            attachmentEvidenceIDs: attachmentEvidenceIds,
            sentAt: sentAt,
            createdAt: createdAt
        )
    }
}

private extension Array where Element == MessengerMessage {
    func sortedForDisplay() -> [MessengerMessage] {
        sorted {
            if $0.sentAt != $1.sentAt {
                return $0.sentAt < $1.sentAt
            }
            return $0.id < $1.id
        }
    }
}

private extension Array where Element == MessengerThread {
    func sortedForDisplay() -> [MessengerThread] {
        sorted {
            let lhsDate = $0.lastMessageAt ?? $0.updatedAt
            let rhsDate = $1.lastMessageAt ?? $1.updatedAt
            if lhsDate != rhsDate {
                return lhsDate > rhsDate
            }
            return $0.id < $1.id
        }
    }
}
