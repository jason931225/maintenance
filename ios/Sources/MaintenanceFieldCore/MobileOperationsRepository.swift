import Foundation
import MaintenanceAPIClient

public protocol MobileOperationsGateway: Sendable {
    func listApprovalItems(limit: Int64, offset: Int64) async throws -> Components.Schemas.ApprovalItemsPage
    func approveWorkOrder(workOrderID: Components.Schemas.Uuid, comment: String) async throws
    func listMailFolders() async throws -> [Components.Schemas.MailFolderView]
    func listMailThreads(
        unread: Bool?,
        query: String?,
        folderID: Components.Schemas.Uuid?,
        before: Int64?,
        limit: Int64
    ) async throws -> [Components.Schemas.MailThreadView]
    func setMailThreadReadState(threadID: Components.Schemas.Uuid, seen: Bool) async throws
    func listCalendarEvents(
        from: Components.Schemas.Timestamp?,
        to: Components.Schemas.Timestamp?,
        limit: Int64
    ) async throws -> [Components.Schemas.CalendarEventResponse]
    func listPolls(
        status: Components.Schemas.PollStatus?,
        limit: Int64
    ) async throws -> [Components.Schemas.PollResponse]
    func votePoll(
        pollID: Components.Schemas.Uuid,
        selectedOptionIDs: [Components.Schemas.Uuid]
    ) async throws -> Components.Schemas.PollResponse
    func registerDevice(
        deviceID: String,
        appVersion: String,
        pushToken: String?
    ) async throws -> Components.Schemas.DeviceRegistrationResponse
    func recordLocationPing(_ request: Components.Schemas.LocationPingRequest) async throws
}

public enum MobileSensitiveActionKind: String, Codable, Hashable, Sendable, CaseIterable {
    case approvalDecision
    case mailSend
    case pollVote
    case workflowStepUp
    case deviceRegistration
    case onDutyPing
}

public struct MobilePasskeyStepUpEnvelope: Codable, Hashable, Sendable {
    public let actionKind: MobileSensitiveActionKind
    public let objectID: Components.Schemas.Uuid?
    public let reasonKey: String
    public let assertion: Components.Schemas.PasskeyStepUpAssertion?

    public init(
        actionKind: MobileSensitiveActionKind,
        objectID: Components.Schemas.Uuid?,
        reasonKey: String,
        assertion: Components.Schemas.PasskeyStepUpAssertion?
    ) {
        self.actionKind = actionKind
        self.objectID = objectID
        self.reasonKey = reasonKey
        self.assertion = assertion
    }

    public var requiresFreshPasskey: Bool { assertion == nil }
}

public struct MobileOperationsSnapshot: Codable, Hashable, Sendable {
    public let approvals: Components.Schemas.ApprovalItemsPage
    public let mailFolders: [Components.Schemas.MailFolderView]
    public let mailThreads: [Components.Schemas.MailThreadView]
    public let calendarEvents: [Components.Schemas.CalendarEventResponse]
    public let polls: [Components.Schemas.PollResponse]
    public let refreshedAt: Date

    public init(
        approvals: Components.Schemas.ApprovalItemsPage,
        mailFolders: [Components.Schemas.MailFolderView],
        mailThreads: [Components.Schemas.MailThreadView],
        calendarEvents: [Components.Schemas.CalendarEventResponse],
        polls: [Components.Schemas.PollResponse],
        refreshedAt: Date
    ) {
        self.approvals = approvals
        self.mailFolders = mailFolders
        self.mailThreads = mailThreads
        self.calendarEvents = calendarEvents
        self.polls = polls
        self.refreshedAt = refreshedAt
    }
}

public enum MobileNotificationPriority: String, Codable, Hashable, Sendable, CaseIterable {
    case low
    case normal
    case high
    case critical
}

public enum MobileNotificationRoute: String, Codable, Hashable, Sendable, CaseIterable {
    case workHub
    case operationsApproval
    case workOrderDetail
    case messengerThread
    case mailThread
    case calendarEvent
    case poll
}

public struct MobilePushNotificationPayload: Codable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let body: String
    public let category: String
    public let priority: MobileNotificationPriority
    public let objectType: String?
    public let objectID: Components.Schemas.Uuid?
    public let receivedAt: Date

    public init(
        id: String,
        title: String,
        body: String,
        category: String,
        priority: MobileNotificationPriority = .normal,
        objectType: String? = nil,
        objectID: Components.Schemas.Uuid? = nil,
        receivedAt: Date
    ) {
        self.id = id
        self.title = title
        self.body = body
        self.category = category
        self.priority = priority
        self.objectType = objectType
        self.objectID = objectID
        self.receivedAt = receivedAt
    }

    public var isUrgent: Bool {
        priority == .critical || priority == .high || category == "urgent_work" || category == "approval"
    }

    public var route: MobileNotificationRoute {
        switch category {
        case "approval":
            return .operationsApproval
        case "work_order", "urgent_work":
            return .workOrderDetail
        case "messenger":
            return .messengerThread
        case "mail":
            return .mailThread
        case "calendar":
            return .calendarEvent
        case "poll":
            return .poll
        default:
            return .workHub
        }
    }
}

public struct MobileRoutedNotification: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let body: String
    public let category: String
    public let priority: MobileNotificationPriority
    public let route: MobileNotificationRoute
    public let objectID: Components.Schemas.Uuid?
    public let receivedAt: Date
    public var readAt: Date?

    public init(payload: MobilePushNotificationPayload) {
        self.id = payload.id
        self.title = payload.title
        self.body = payload.body
        self.category = payload.category
        self.priority = payload.priority
        self.route = payload.route
        self.objectID = payload.objectID
        self.receivedAt = payload.receivedAt
        self.readAt = nil
    }

    public var isUnread: Bool { readAt == nil }
    public var isUrgent: Bool { priority == .critical || priority == .high || category == "urgent_work" || category == "approval" }
}

public struct MobileNotificationInbox: Codable, Hashable, Sendable {
    public let notifications: [MobileRoutedNotification]

    public init(notifications: [MobileRoutedNotification]) {
        self.notifications = notifications.sorted { $0.receivedAt > $1.receivedAt }
    }

    public var unreadCount: Int { notifications.filter(\.isUnread).count }
    public var urgentUnreadCount: Int { notifications.filter { $0.isUnread && $0.isUrgent }.count }
    public var badgeCount: Int { unreadCount + urgentUnreadCount }
}

public protocol MobileNotificationStore: Sendable {
    func loadNotifications() async -> [MobileRoutedNotification]
    func saveNotification(_ notification: MobileRoutedNotification) async
    func markRead(id: String, at: Date) async
}

public actor InMemoryMobileNotificationStore: MobileNotificationStore {
    private var notifications: [String: MobileRoutedNotification]

    public init(notifications: [MobileRoutedNotification] = []) {
        self.notifications = Dictionary(uniqueKeysWithValues: notifications.map { ($0.id, $0) })
    }

    public func loadNotifications() -> [MobileRoutedNotification] {
        Array(notifications.values).sorted { $0.receivedAt > $1.receivedAt }
    }

    public func saveNotification(_ notification: MobileRoutedNotification) {
        notifications[notification.id] = notification
    }

    public func markRead(id: String, at: Date) {
        guard var notification = notifications[id] else { return }
        notification.readAt = at
        notifications[id] = notification
    }
}

public enum MobileQueuedActionStatus: String, Codable, Hashable, Sendable, CaseIterable {
    case waitingForPasskey
    case readyForReplay
    case submitted
    case failed
}

public struct MobileQueuedSensitiveAction: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let actionKind: MobileSensitiveActionKind
    public let objectID: Components.Schemas.Uuid?
    public let reasonKey: String
    public let comment: String?
    public let deviceID: String?
    public let appVersion: String?
    public let pushToken: String?
    public let locationPing: Components.Schemas.LocationPingRequest?
    public let createdAt: Date
    public var status: MobileQueuedActionStatus
    public var lastError: String?

    public init(
        id: String,
        actionKind: MobileSensitiveActionKind,
        objectID: Components.Schemas.Uuid?,
        reasonKey: String,
        comment: String? = nil,
        deviceID: String? = nil,
        appVersion: String? = nil,
        pushToken: String? = nil,
        locationPing: Components.Schemas.LocationPingRequest? = nil,
        createdAt: Date,
        status: MobileQueuedActionStatus,
        lastError: String? = nil
    ) {
        self.id = id
        self.actionKind = actionKind
        self.objectID = objectID
        self.reasonKey = reasonKey
        self.comment = comment
        self.deviceID = deviceID
        self.appVersion = appVersion
        self.pushToken = pushToken
        self.locationPing = locationPing
        self.createdAt = createdAt
        self.status = status
        self.lastError = lastError
    }

    public var requiresPasskey: Bool {
        actionKind == .approvalDecision || actionKind == .pollVote || actionKind == .workflowStepUp
    }
}

public struct MobileSensitiveActionQueueSummary: Codable, Hashable, Sendable {
    public let pendingPasskeyCount: Int
    public let readyForReplayCount: Int
    public let failedCount: Int

    public init(actions: [MobileQueuedSensitiveAction]) {
        self.pendingPasskeyCount = actions.filter { $0.status == .waitingForPasskey }.count
        self.readyForReplayCount = actions.filter { $0.status == .readyForReplay }.count
        self.failedCount = actions.filter { $0.status == .failed }.count
    }
}

public protocol MobileSensitiveActionStore: Sendable {
    func upsert(_ action: MobileQueuedSensitiveAction) async
    func pending() async -> [MobileQueuedSensitiveAction]
    func get(_ id: String) async -> MobileQueuedSensitiveAction?
    func markSubmitted(id: String) async
    func markFailed(id: String, message: String) async
}

public actor InMemoryMobileSensitiveActionStore: MobileSensitiveActionStore {
    private var actions: [String: MobileQueuedSensitiveAction] = [:]

    public init(actions: [MobileQueuedSensitiveAction] = []) {
        self.actions = Dictionary(uniqueKeysWithValues: actions.map { ($0.id, $0) })
    }

    public func upsert(_ action: MobileQueuedSensitiveAction) {
        actions[action.id] = action
    }

    public func pending() -> [MobileQueuedSensitiveAction] {
        actions.values
            .filter { $0.status != .submitted }
            .sorted { $0.createdAt < $1.createdAt }
    }

    public func get(_ id: String) -> MobileQueuedSensitiveAction? {
        actions[id]
    }

    public func markSubmitted(id: String) {
        guard var action = actions[id] else { return }
        action.status = .submitted
        action.lastError = nil
        actions[id] = action
    }

    public func markFailed(id: String, message: String) {
        guard var action = actions[id] else { return }
        action.status = .failed
        action.lastError = message
        actions[id] = action
    }
}

public struct MobileReplaySummary: Equatable, Sendable {
    public let attempted: Int
    public let submitted: Int
    public let failed: Int
    public let waitingForPasskey: Int

    public init(attempted: Int, submitted: Int, failed: Int, waitingForPasskey: Int) {
        self.attempted = attempted
        self.submitted = submitted
        self.failed = failed
        self.waitingForPasskey = waitingForPasskey
    }
}

public enum MobileOperationsSnapshotOrigin: String, Codable, Hashable, Sendable {
    case live
    case cachedAfterFailure
}

public struct MobileOperationsOverview: Codable, Hashable, Sendable {
    public let snapshot: MobileOperationsSnapshot
    public let origin: MobileOperationsSnapshotOrigin
    public let failureDescription: String?

    public init(
        snapshot: MobileOperationsSnapshot,
        origin: MobileOperationsSnapshotOrigin,
        failureDescription: String? = nil
    ) {
        self.snapshot = snapshot
        self.origin = origin
        self.failureDescription = failureDescription
    }
}

public protocol MobileOperationsCacheStore: Sendable {
    func loadSnapshot() async -> MobileOperationsSnapshot?
    func saveSnapshot(_ snapshot: MobileOperationsSnapshot) async
}

public actor InMemoryMobileOperationsCacheStore: MobileOperationsCacheStore {
    private var snapshot: MobileOperationsSnapshot?

    public init(snapshot: MobileOperationsSnapshot? = nil) {
        self.snapshot = snapshot
    }

    public func loadSnapshot() async -> MobileOperationsSnapshot? {
        snapshot
    }

    public func saveSnapshot(_ snapshot: MobileOperationsSnapshot) async {
        self.snapshot = snapshot
    }
}



public struct MobileOperationsDashboard: Codable, Hashable, Sendable {
    public let approvalCount: Int
    public let approvals: [MobileApprovalRow]
    public let approvalTitles: [String]
    public let unreadMailCount: Int
    public let mailThreads: [MobileMailThreadRow]
    public let calendarEvents: [MobileCalendarEventRow]
    public let polls: [MobilePollRow]

    public init(snapshot: MobileOperationsSnapshot) {
        self.approvalCount = Int(snapshot.approvals.total)
        self.approvals = snapshot.approvals.items.map(MobileApprovalRow.init(item:))
        self.approvalTitles = approvals.prefix(3).map(\.title)
        self.unreadMailCount = Int(snapshot.mailFolders.reduce(Int64(0)) { $0 + $1.unreadCount })
        self.mailThreads = snapshot.mailThreads.map(MobileMailThreadRow.init(thread:))
        self.calendarEvents = snapshot.calendarEvents.map(MobileCalendarEventRow.init(event:))
        self.polls = snapshot.polls.map(MobilePollRow.init(poll:))
    }

    public var hasActionablePolls: Bool {
        polls.contains { $0.canVote }
    }
}

public struct MobileApprovalRow: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let source: Components.Schemas.ApprovalItem.SourcePayload
    public let sourceID: Components.Schemas.Uuid
    public let title: String
    public let summary: String
    public let actionHref: String

    public init(item: Components.Schemas.ApprovalItem) {
        self.id = item.id
        self.source = item.source
        self.sourceID = item.sourceId
        self.title = item.title
        self.summary = item.summary
        self.actionHref = item.actionHref
    }

    public var canExecuteOnMobile: Bool {
        source == .workOrder
    }
}

public struct MobileMailThreadRow: Codable, Hashable, Identifiable, Sendable {
    public let id: Components.Schemas.Uuid
    public let subject: String
    public let unreadCount: Int
    public let hasAttachments: Bool
    public let isFlagged: Bool
    public let lastMessageAt: Date

    public init(thread: Components.Schemas.MailThreadView) {
        self.id = thread.id
        self.subject = thread.subject
        self.unreadCount = Int(thread.unreadCount)
        self.hasAttachments = thread.hasAttachments
        self.isFlagged = thread.isFlagged
        self.lastMessageAt = thread.lastMessageAt
    }
}

public struct MobileCalendarEventRow: Codable, Hashable, Identifiable, Sendable {
    public let id: Components.Schemas.Uuid
    public let title: String
    public let description: String
    public let scopeType: Components.Schemas.CollaborationScopeType
    public let startsAt: Date
    public let endsAt: Date
    public let isAllDay: Bool
    public let isCancelled: Bool
    public let objectType: String?

    public init(event: Components.Schemas.CalendarEventResponse) {
        self.id = event.id
        self.title = event.title
        self.description = event.description
        self.scopeType = event.scopeType
        self.startsAt = event.startsAt
        self.endsAt = event.endsAt
        self.isAllDay = event.allDay
        self.isCancelled = event.status == .cancelled
        self.objectType = event.objectType
    }
}

public struct MobilePollRow: Codable, Hashable, Identifiable, Sendable {
    public let id: Components.Schemas.Uuid
    public let title: String
    public let question: String
    public let status: Components.Schemas.PollStatus
    public let anonymity: Components.Schemas.PollAnonymity
    public let allowMultiple: Bool
    public let voteCount: Int
    public let hasSubmittedVote: Bool
    public let firstOptionID: Components.Schemas.Uuid?
    public let firstOptionLabel: String?

    public init(poll: Components.Schemas.PollResponse) {
        self.id = poll.id
        self.title = poll.title
        self.question = poll.question
        self.status = poll.status
        self.anonymity = poll.anonymity
        self.allowMultiple = poll.allowMultiple
        self.voteCount = Int(poll.voteCount)
        self.hasSubmittedVote = poll.myVote.submitted
        self.firstOptionID = poll.options.first?.id
        self.firstOptionLabel = poll.options.first?.label
    }

    public var canVote: Bool {
        status == .open && hasSubmittedVote == false && firstOptionID != nil
    }
}

public struct MobileOperationsRepository: Sendable {
    private let gateway: any MobileOperationsGateway
    private let cache: any MobileOperationsCacheStore
    private let notificationStore: any MobileNotificationStore
    private let sensitiveActionStore: any MobileSensitiveActionStore
    private let requestIDFactory: any RequestIDFactory
    private let clock: any FieldClock

    public init(
        gateway: any MobileOperationsGateway,
        cache: any MobileOperationsCacheStore = InMemoryMobileOperationsCacheStore(),
        notificationStore: any MobileNotificationStore = InMemoryMobileNotificationStore(),
        sensitiveActionStore: any MobileSensitiveActionStore = InMemoryMobileSensitiveActionStore(),
        requestIDFactory: any RequestIDFactory = ULIDRequestIDFactory(),
        clock: any FieldClock = SystemFieldClock()
    ) {
        self.gateway = gateway
        self.cache = cache
        self.notificationStore = notificationStore
        self.sensitiveActionStore = sensitiveActionStore
        self.requestIDFactory = requestIDFactory
        self.clock = clock
    }

    public func cachedOverview() async -> MobileOperationsOverview? {
        guard let snapshot = await cache.loadSnapshot() else { return nil }
        return MobileOperationsOverview(snapshot: snapshot, origin: .cachedAfterFailure)
    }

    public func refreshOverview(
        approvalLimit: Int64 = 50,
        mailThreadLimit: Int64 = 50,
        calendarLimit: Int64 = 30,
        pollLimit: Int64 = 30
    ) async throws -> MobileOperationsOverview {
        do {
            let snapshot = MobileOperationsSnapshot(
                approvals: try await gateway.listApprovalItems(limit: approvalLimit, offset: 0),
                mailFolders: try await gateway.listMailFolders(),
                mailThreads: try await gateway.listMailThreads(
                    unread: nil,
                    query: nil,
                    folderID: nil,
                    before: nil,
                    limit: mailThreadLimit
                ),
                calendarEvents: try await gateway.listCalendarEvents(from: nil, to: nil, limit: calendarLimit),
                polls: try await gateway.listPolls(status: nil, limit: pollLimit),
                refreshedAt: clock.now()
            )
            await cache.saveSnapshot(snapshot)
            return MobileOperationsOverview(snapshot: snapshot, origin: .live)
        } catch {
            if let cached = await cache.loadSnapshot() {
                return MobileOperationsOverview(
                    snapshot: cached,
                    origin: .cachedAfterFailure,
                    failureDescription: String(describing: error)
                )
            }
            throw error
        }
    }

    @discardableResult
    public func markMailThreadSeen(threadID: Components.Schemas.Uuid, seen: Bool) async throws -> MobileOperationsOverview? {
        try await gateway.setMailThreadReadState(threadID: threadID, seen: seen)
        guard let cached = await cache.loadSnapshot() else { return nil }
        let updatedThreads = cached.mailThreads.map { thread in
            thread.id == threadID ? thread.updatingUnreadCount(seen ? 0 : max(thread.unreadCount, 1)) : thread
        }
        let updated = MobileOperationsSnapshot(
            approvals: cached.approvals,
            mailFolders: cached.mailFolders,
            mailThreads: updatedThreads,
            calendarEvents: cached.calendarEvents,
            polls: cached.polls,
            refreshedAt: clock.now()
        )
        await cache.saveSnapshot(updated)
        return MobileOperationsOverview(snapshot: updated, origin: .live)
    }

    @discardableResult
    public func votePoll(
        pollID: Components.Schemas.Uuid,
        selectedOptionIDs: [Components.Schemas.Uuid]
    ) async throws -> Components.Schemas.PollResponse {
        let updatedPoll = try await gateway.votePoll(pollID: pollID, selectedOptionIDs: selectedOptionIDs)
        if let cached = await cache.loadSnapshot() {
            let updated = MobileOperationsSnapshot(
                approvals: cached.approvals,
                mailFolders: cached.mailFolders,
                mailThreads: cached.mailThreads,
                calendarEvents: cached.calendarEvents,
                polls: cached.polls.map { $0.id == pollID ? updatedPoll : $0 },
                refreshedAt: clock.now()
            )
            await cache.saveSnapshot(updated)
        }
        return updatedPoll
    }

    public func registerPushDevice(
        deviceID: String,
        appVersion: String,
        pushToken: String
    ) async throws -> Components.Schemas.DeviceRegistrationResponse {
        try await gateway.registerDevice(deviceID: deviceID, appVersion: appVersion, pushToken: pushToken)
    }

    @discardableResult
    public func registerOrQueuePushDevice(
        deviceID: String,
        appVersion: String,
        pushToken: String
    ) async -> MobileQueuedSensitiveAction? {
        do {
            _ = try await gateway.registerDevice(deviceID: deviceID, appVersion: appVersion, pushToken: pushToken)
            return nil
        } catch {
            let action = MobileQueuedSensitiveAction(
                id: requestIDFactory.nextID(),
                actionKind: .deviceRegistration,
                objectID: nil,
                reasonKey: "operations_push_device_registration",
                deviceID: deviceID,
                appVersion: appVersion,
                pushToken: pushToken,
                createdAt: clock.now(),
                status: .readyForReplay,
                lastError: String(describing: error)
            )
            await sensitiveActionStore.upsert(action)
            return action
        }
    }

    @discardableResult
    public func ingestPushNotification(_ payload: MobilePushNotificationPayload) async -> MobileRoutedNotification {
        let notification = MobileRoutedNotification(payload: payload)
        await notificationStore.saveNotification(notification)
        return notification
    }

    public func notificationInbox() async -> MobileNotificationInbox {
        MobileNotificationInbox(notifications: await notificationStore.loadNotifications())
    }

    public func markNotificationRead(id: String) async -> MobileNotificationInbox {
        await notificationStore.markRead(id: id, at: clock.now())
        return await notificationInbox()
    }

    public func queueApprovalDecision(
        approval: MobileApprovalRow,
        comment: String
    ) async -> MobileQueuedSensitiveAction {
        let action = MobileQueuedSensitiveAction(
            id: requestIDFactory.nextID(),
            actionKind: .approvalDecision,
            objectID: approval.sourceID,
            reasonKey: "operations_passkey_approval_decision",
            comment: comment.trimmedForSubmission,
            createdAt: clock.now(),
            status: .waitingForPasskey
        )
        await sensitiveActionStore.upsert(action)
        return action
    }

    @discardableResult
    public func approveWorkOrder(
        approval: MobileApprovalRow,
        comment: String,
        stepUpAssertion: Components.Schemas.PasskeyStepUpAssertion?
    ) async throws -> MobileQueuedSensitiveAction? {
        guard approval.canExecuteOnMobile, let stepUpAssertion else {
            return await queueApprovalDecision(approval: approval, comment: comment)
        }
        _ = stepUpAssertion
        do {
            try await gateway.approveWorkOrder(workOrderID: approval.sourceID, comment: comment.trimmedForSubmission)
            let refreshed = try await refreshOverview()
            await cache.saveSnapshot(refreshed.snapshot)
            return nil
        } catch {
            let action = MobileQueuedSensitiveAction(
                id: requestIDFactory.nextID(),
                actionKind: .approvalDecision,
                objectID: approval.sourceID,
                reasonKey: "operations_passkey_approval_decision",
                comment: comment.trimmedForSubmission,
                createdAt: clock.now(),
                status: .readyForReplay,
                lastError: String(describing: error)
            )
            await sensitiveActionStore.upsert(action)
            return action
        }
    }

    @discardableResult
    public func recordOnDutyPing(
        state: GPSCollectionState,
        latitude: Double,
        longitude: Double,
        accuracyM: Double?,
        recordedAt: Date
    ) async -> MobileQueuedSensitiveAction? {
        let request = Components.Schemas.LocationPingRequest(
            latitude: latitude,
            longitude: longitude,
            accuracyM: accuracyM,
            recordedAt: recordedAt,
            onDuty: state.onDuty
        )
        guard state.mayCollect else {
            return MobileQueuedSensitiveAction(
                id: requestIDFactory.nextID(),
                actionKind: .onDutyPing,
                objectID: nil,
                reasonKey: "operations_on_duty_not_collecting",
                locationPing: request,
                createdAt: clock.now(),
                status: .waitingForPasskey
            )
        }
        do {
            try await gateway.recordLocationPing(request)
            return nil
        } catch {
            let action = MobileQueuedSensitiveAction(
                id: requestIDFactory.nextID(),
                actionKind: .onDutyPing,
                objectID: nil,
                reasonKey: "operations_on_duty_location_ping",
                locationPing: request,
                createdAt: clock.now(),
                status: .readyForReplay,
                lastError: String(describing: error)
            )
            await sensitiveActionStore.upsert(action)
            return action
        }
    }

    public func sensitiveActionQueueSummary() async -> MobileSensitiveActionQueueSummary {
        MobileSensitiveActionQueueSummary(actions: await sensitiveActionStore.pending())
    }

    public func replaySensitiveActions(
        stepUpAssertion: Components.Schemas.PasskeyStepUpAssertion?
    ) async -> MobileReplaySummary {
        let actions = await sensitiveActionStore.pending()
        var attempted = 0
        var submitted = 0
        var failed = 0
        var waiting = 0

        for action in actions where action.status == .readyForReplay {
            attempted += 1
            do {
                switch action.actionKind {
                case .deviceRegistration:
                    guard let deviceID = action.deviceID,
                          let appVersion = action.appVersion,
                          let pushToken = action.pushToken else {
                        throw MaintenanceGatewayError.unexpectedResponse("missing_device_registration_payload")
                    }
                    _ = try await gateway.registerDevice(deviceID: deviceID, appVersion: appVersion, pushToken: pushToken)
                case .approvalDecision:
                    guard let stepUpAssertion, let objectID = action.objectID else {
                        waiting += 1
                        continue
                    }
                    _ = stepUpAssertion
                    try await gateway.approveWorkOrder(workOrderID: objectID, comment: action.comment ?? "")
                case .onDutyPing:
                    guard let locationPing = action.locationPing else {
                        throw MaintenanceGatewayError.unexpectedResponse("missing_on_duty_payload")
                    }
                    try await gateway.recordLocationPing(locationPing)
                case .mailSend, .pollVote, .workflowStepUp:
                    waiting += 1
                    continue
                }
                await sensitiveActionStore.markSubmitted(id: action.id)
                submitted += 1
            } catch {
                await sensitiveActionStore.markFailed(id: action.id, message: String(describing: error))
                failed += 1
            }
        }

        return MobileReplaySummary(
            attempted: attempted,
            submitted: submitted,
            failed: failed,
            waitingForPasskey: waiting
        )
    }

    public func stepUpEnvelope(
        actionKind: MobileSensitiveActionKind,
        objectID: Components.Schemas.Uuid?,
        reasonKey: String,
        assertion: Components.Schemas.PasskeyStepUpAssertion? = nil
    ) -> MobilePasskeyStepUpEnvelope {
        MobilePasskeyStepUpEnvelope(
            actionKind: actionKind,
            objectID: objectID,
            reasonKey: reasonKey,
            assertion: assertion
        )
    }
}

private extension Components.Schemas.MailThreadView {
    func updatingUnreadCount(_ unreadCount: Int64) -> Self {
        .init(
            id: id,
            subject: subject,
            lastMessageAt: lastMessageAt,
            messageCount: messageCount,
            unreadCount: unreadCount,
            hasAttachments: hasAttachments,
            isFlagged: isFlagged
        )
    }
}
