package com.maintenance.field.data.collaboration

import com.maintenance.api.client.model.ApprovalItemsPage
import com.maintenance.api.client.model.ApprovalItem
import com.maintenance.api.client.model.CalendarEventResponse
import com.maintenance.api.client.model.DeviceRegistrationResponse
import com.maintenance.api.client.model.LocationPingRequest
import com.maintenance.api.client.model.MailFolderView
import com.maintenance.api.client.model.MailThreadView
import com.maintenance.api.client.model.PasskeyStepUpAssertion
import com.maintenance.api.client.model.PollResponse
import com.maintenance.api.client.model.PollStatus
import com.maintenance.field.data.offline.FieldClock
import com.maintenance.field.data.offline.SystemFieldClock
import java.time.OffsetDateTime
import java.util.UUID

interface MobileOperationsGateway {
    suspend fun listApprovalItems(limit: Long, offset: Long): ApprovalItemsPage

    suspend fun approveWorkOrder(workOrderId: UUID, comment: String)

    suspend fun listMailFolders(): List<MailFolderView>

    suspend fun listMailThreads(
        unread: Boolean?,
        query: String?,
        folderId: UUID?,
        before: Long?,
        limit: Long,
    ): List<MailThreadView>

    suspend fun setMailThreadReadState(threadId: UUID, seen: Boolean)

    suspend fun listCalendarEvents(
        from: OffsetDateTime?,
        to: OffsetDateTime?,
        limit: Long,
    ): List<CalendarEventResponse>

    suspend fun listPolls(status: PollStatus?, limit: Long): List<PollResponse>

    suspend fun votePoll(pollId: UUID, selectedOptionIds: List<UUID>): PollResponse

    suspend fun registerAndroidDevice(
        deviceId: String,
        appVersion: String,
        pushToken: String? = null,
    ): DeviceRegistrationResponse

    suspend fun recordLocationPing(request: LocationPingRequest)
}

enum class MobileSensitiveActionKind {
    APPROVAL_DECISION,
    MAIL_SEND,
    POLL_VOTE,
    WORKFLOW_STEP_UP,
    DEVICE_REGISTRATION,
    ON_DUTY_PING,
}

data class MobilePasskeyStepUpEnvelope(
    val actionKind: MobileSensitiveActionKind,
    val objectId: UUID?,
    val reasonKey: String,
    val assertion: PasskeyStepUpAssertion?,
) {
    val requiresFreshPasskey: Boolean get() = assertion == null
}

data class MobileOperationsSnapshot(
    val approvals: ApprovalItemsPage,
    val mailFolders: List<MailFolderView>,
    val mailThreads: List<MailThreadView>,
    val calendarEvents: List<CalendarEventResponse>,
    val polls: List<PollResponse>,
    val refreshedAt: OffsetDateTime,
)

enum class MobileOperationsSnapshotOrigin {
    LIVE,
    CACHED_AFTER_FAILURE,
}

data class MobileOperationsOverview(
    val snapshot: MobileOperationsSnapshot,
    val origin: MobileOperationsSnapshotOrigin,
    val failureDescription: String? = null,
)

interface MobileOperationsCacheStore {
    suspend fun loadSnapshot(): MobileOperationsSnapshot?
    suspend fun saveSnapshot(snapshot: MobileOperationsSnapshot)
}

class InMemoryMobileOperationsCacheStore(
    initialSnapshot: MobileOperationsSnapshot? = null,
) : MobileOperationsCacheStore {
    private val lock = Any()
    private var snapshot: MobileOperationsSnapshot? = initialSnapshot

    override suspend fun loadSnapshot(): MobileOperationsSnapshot? = synchronized(lock) { snapshot }

    override suspend fun saveSnapshot(snapshot: MobileOperationsSnapshot) {
        synchronized(lock) {
            this.snapshot = snapshot
        }
    }
}

enum class MobileNotificationPriority {
    LOW,
    NORMAL,
    HIGH,
    CRITICAL,
}

enum class MobileNotificationRoute {
    WORK_HUB,
    OPERATIONS_APPROVAL,
    WORK_ORDER_DETAIL,
    MESSENGER_THREAD,
    MAIL_THREAD,
    CALENDAR_EVENT,
    POLL,
}

data class MobilePushNotificationPayload(
    val id: String,
    val title: String,
    val body: String,
    val category: String,
    val priority: MobileNotificationPriority = MobileNotificationPriority.NORMAL,
    val objectType: String? = null,
    val objectId: UUID? = null,
    val receivedAt: OffsetDateTime,
) {
    val isUrgent: Boolean
        get() = priority == MobileNotificationPriority.CRITICAL ||
            priority == MobileNotificationPriority.HIGH ||
            category == "urgent_work" ||
            category == "approval"

    val route: MobileNotificationRoute
        get() = when (category) {
            "approval" -> MobileNotificationRoute.OPERATIONS_APPROVAL
            "work_order", "urgent_work" -> MobileNotificationRoute.WORK_ORDER_DETAIL
            "messenger" -> MobileNotificationRoute.MESSENGER_THREAD
            "mail" -> MobileNotificationRoute.MAIL_THREAD
            "calendar" -> MobileNotificationRoute.CALENDAR_EVENT
            "poll" -> MobileNotificationRoute.POLL
            else -> MobileNotificationRoute.WORK_HUB
        }
}

data class MobileRoutedNotification(
    val id: String,
    val title: String,
    val body: String,
    val category: String,
    val priority: MobileNotificationPriority,
    val route: MobileNotificationRoute,
    val objectId: UUID?,
    val receivedAt: OffsetDateTime,
    val readAt: OffsetDateTime? = null,
) {
    constructor(payload: MobilePushNotificationPayload) : this(
        id = payload.id,
        title = payload.title,
        body = payload.body,
        category = payload.category,
        priority = payload.priority,
        route = payload.route,
        objectId = payload.objectId,
        receivedAt = payload.receivedAt,
    )

    val isUnread: Boolean get() = readAt == null
    val isUrgent: Boolean
        get() = priority == MobileNotificationPriority.CRITICAL ||
            priority == MobileNotificationPriority.HIGH ||
            category == "urgent_work" ||
            category == "approval"
}

data class MobileNotificationInbox(
    val notifications: List<MobileRoutedNotification>,
) {
    val unreadCount: Int get() = notifications.count { it.isUnread }
    val urgentUnreadCount: Int get() = notifications.count { it.isUnread && it.isUrgent }
    val badgeCount: Int get() = unreadCount + urgentUnreadCount
}

interface MobileNotificationStore {
    suspend fun loadNotifications(): List<MobileRoutedNotification>
    suspend fun saveNotification(notification: MobileRoutedNotification)
    suspend fun markRead(id: String, at: OffsetDateTime)
}

class InMemoryMobileNotificationStore(
    notifications: List<MobileRoutedNotification> = emptyList(),
) : MobileNotificationStore {
    private val lock = Any()
    private val notifications = notifications.associateBy { it.id }.toMutableMap()

    override suspend fun loadNotifications(): List<MobileRoutedNotification> =
        synchronized(lock) { notifications.values.sortedByDescending { it.receivedAt } }

    override suspend fun saveNotification(notification: MobileRoutedNotification) {
        synchronized(lock) {
            notifications[notification.id] = notification
        }
    }

    override suspend fun markRead(id: String, at: OffsetDateTime) {
        synchronized(lock) {
            notifications[id]?.let { notifications[id] = it.copy(readAt = at) }
        }
    }
}

enum class MobileQueuedActionStatus {
    WAITING_FOR_PASSKEY,
    READY_FOR_REPLAY,
    SUBMITTED,
    FAILED,
}

data class MobileQueuedSensitiveAction(
    val id: String,
    val actionKind: MobileSensitiveActionKind,
    val objectId: UUID?,
    val reasonKey: String,
    val comment: String? = null,
    val deviceId: String? = null,
    val appVersion: String? = null,
    val pushToken: String? = null,
    val locationPing: LocationPingRequest? = null,
    val createdAt: OffsetDateTime,
    val status: MobileQueuedActionStatus,
    val lastError: String? = null,
) {
    val requiresPasskey: Boolean
        get() = actionKind == MobileSensitiveActionKind.APPROVAL_DECISION ||
            actionKind == MobileSensitiveActionKind.POLL_VOTE ||
            actionKind == MobileSensitiveActionKind.WORKFLOW_STEP_UP
}

data class MobileSensitiveActionQueueSummary(
    val pendingPasskeyCount: Int,
    val readyForReplayCount: Int,
    val failedCount: Int,
) {
    constructor(actions: List<MobileQueuedSensitiveAction>) : this(
        pendingPasskeyCount = actions.count { it.status == MobileQueuedActionStatus.WAITING_FOR_PASSKEY },
        readyForReplayCount = actions.count { it.status == MobileQueuedActionStatus.READY_FOR_REPLAY },
        failedCount = actions.count { it.status == MobileQueuedActionStatus.FAILED },
    )
}

interface MobileSensitiveActionStore {
    suspend fun upsert(action: MobileQueuedSensitiveAction)
    suspend fun pending(): List<MobileQueuedSensitiveAction>
    suspend fun get(id: String): MobileQueuedSensitiveAction?
    suspend fun markSubmitted(id: String)
    suspend fun markFailed(id: String, message: String)
}

class InMemoryMobileSensitiveActionStore(
    actions: List<MobileQueuedSensitiveAction> = emptyList(),
) : MobileSensitiveActionStore {
    private val lock = Any()
    private val actions = actions.associateBy { it.id }.toMutableMap()

    override suspend fun upsert(action: MobileQueuedSensitiveAction) {
        synchronized(lock) {
            actions[action.id] = action
        }
    }

    override suspend fun pending(): List<MobileQueuedSensitiveAction> =
        synchronized(lock) {
            actions.values.filter { it.status != MobileQueuedActionStatus.SUBMITTED }.sortedBy { it.createdAt }
        }

    override suspend fun get(id: String): MobileQueuedSensitiveAction? =
        synchronized(lock) { actions[id] }

    override suspend fun markSubmitted(id: String) {
        synchronized(lock) {
            actions[id]?.let { actions[id] = it.copy(status = MobileQueuedActionStatus.SUBMITTED, lastError = null) }
        }
    }

    override suspend fun markFailed(id: String, message: String) {
        synchronized(lock) {
            actions[id]?.let { actions[id] = it.copy(status = MobileQueuedActionStatus.FAILED, lastError = message) }
        }
    }
}

data class MobileReplaySummary(
    val attempted: Int,
    val submitted: Int,
    val failed: Int,
    val waitingForPasskey: Int,
)



data class MobileOperationsDashboard(
    val approvalCount: Int,
    val approvals: List<MobileApprovalRow>,
    val approvalTitles: List<String>,
    val unreadMailCount: Int,
    val mailThreads: List<MobileMailThreadRow>,
    val calendarEvents: List<MobileCalendarEventRow>,
    val polls: List<MobilePollRow>,
) {
    constructor(snapshot: MobileOperationsSnapshot) : this(
        approvalCount = snapshot.approvals.total.toInt(),
        approvals = snapshot.approvals.items.map(::MobileApprovalRow),
        approvalTitles = snapshot.approvals.items.take(3).map { it.title },
        unreadMailCount = snapshot.mailFolders.sumOf { it.unreadCount }.toInt(),
        mailThreads = snapshot.mailThreads.map(::MobileMailThreadRow),
        calendarEvents = snapshot.calendarEvents.map(::MobileCalendarEventRow),
        polls = snapshot.polls.map(::MobilePollRow),
    )

    val hasActionablePolls: Boolean get() = polls.any { it.canVote }
}

data class MobileApprovalRow(
    val id: String,
    val source: ApprovalItem.Source,
    val sourceId: UUID,
    val title: String,
    val summary: String,
    val actionHref: String,
) {
    constructor(item: ApprovalItem) : this(
        id = item.id,
        source = item.source,
        sourceId = item.sourceId,
        title = item.title,
        summary = item.summary,
        actionHref = item.actionHref,
    )

    val canExecuteOnMobile: Boolean get() = source == ApprovalItem.Source.WORK_ORDER
}

data class MobileMailThreadRow(
    val id: UUID,
    val subject: String,
    val unreadCount: Int,
    val hasAttachments: Boolean,
    val isFlagged: Boolean,
    val lastMessageAt: OffsetDateTime,
) {
    constructor(thread: MailThreadView) : this(
        id = thread.id,
        subject = thread.subject,
        unreadCount = thread.unreadCount.toInt(),
        hasAttachments = thread.hasAttachments,
        isFlagged = thread.isFlagged,
        lastMessageAt = thread.lastMessageAt,
    )
}

data class MobileCalendarEventRow(
    val id: UUID,
    val title: String,
    val description: String,
    val scopeType: com.maintenance.api.client.model.CollaborationScopeType,
    val startsAt: OffsetDateTime,
    val endsAt: OffsetDateTime,
    val isAllDay: Boolean,
    val isCancelled: Boolean,
    val objectType: String?,
) {
    constructor(event: CalendarEventResponse) : this(
        id = event.id,
        title = event.title,
        description = event.description,
        scopeType = event.scopeType,
        startsAt = event.startsAt,
        endsAt = event.endsAt,
        isAllDay = event.allDay,
        isCancelled = event.status == com.maintenance.api.client.model.CalendarEventStatus.CANCELLED,
        objectType = event.objectType,
    )
}

data class MobilePollRow(
    val id: UUID,
    val title: String,
    val question: String,
    val status: PollStatus,
    val anonymity: com.maintenance.api.client.model.PollAnonymity,
    val allowMultiple: Boolean,
    val voteCount: Int,
    val hasSubmittedVote: Boolean,
    val firstOptionId: UUID?,
    val firstOptionLabel: String?,
) {
    constructor(poll: PollResponse) : this(
        id = poll.id,
        title = poll.title,
        question = poll.question,
        status = poll.status,
        anonymity = poll.anonymity,
        allowMultiple = poll.allowMultiple,
        voteCount = poll.voteCount.toInt(),
        hasSubmittedVote = poll.myVote.submitted,
        firstOptionId = poll.options.firstOrNull()?.id,
        firstOptionLabel = poll.options.firstOrNull()?.label,
    )

    val canVote: Boolean get() = status == PollStatus.OPEN && !hasSubmittedVote && firstOptionId != null
}

class MobileOperationsRepository(
    private val gateway: MobileOperationsGateway,
    private val cache: MobileOperationsCacheStore = InMemoryMobileOperationsCacheStore(),
    private val notificationStore: MobileNotificationStore = InMemoryMobileNotificationStore(),
    private val sensitiveActionStore: MobileSensitiveActionStore = InMemoryMobileSensitiveActionStore(),
    private val requestIdFactory: () -> String = { UUID.randomUUID().toString() },
    private val clock: FieldClock = SystemFieldClock,
) {
    suspend fun cachedOverview(): MobileOperationsOverview? =
        cache.loadSnapshot()?.let { MobileOperationsOverview(it, MobileOperationsSnapshotOrigin.CACHED_AFTER_FAILURE) }

    suspend fun refreshOverview(
        approvalLimit: Long = 50,
        mailThreadLimit: Long = 50,
        calendarLimit: Long = 30,
        pollLimit: Long = 30,
    ): MobileOperationsOverview = try {
        val snapshot = MobileOperationsSnapshot(
            approvals = gateway.listApprovalItems(limit = approvalLimit, offset = 0),
            mailFolders = gateway.listMailFolders(),
            mailThreads = gateway.listMailThreads(
                unread = null,
                query = null,
                folderId = null,
                before = null,
                limit = mailThreadLimit,
            ),
            calendarEvents = gateway.listCalendarEvents(from = null, to = null, limit = calendarLimit),
            polls = gateway.listPolls(status = null, limit = pollLimit),
            refreshedAt = clock.now(),
        )
        cache.saveSnapshot(snapshot)
        MobileOperationsOverview(snapshot, MobileOperationsSnapshotOrigin.LIVE)
    } catch (error: Exception) {
        val cached = cache.loadSnapshot() ?: throw error
        MobileOperationsOverview(cached, MobileOperationsSnapshotOrigin.CACHED_AFTER_FAILURE, error.toString())
    }

    suspend fun markMailThreadSeen(threadId: UUID, seen: Boolean): MobileOperationsOverview? {
        gateway.setMailThreadReadState(threadId = threadId, seen = seen)
        val cached = cache.loadSnapshot() ?: return null
        val updated = cached.copy(
            mailThreads = cached.mailThreads.map { thread ->
                if (thread.id == threadId) thread.copy(unreadCount = if (seen) 0 else maxOf(thread.unreadCount, 1)) else thread
            },
            refreshedAt = clock.now(),
        )
        cache.saveSnapshot(updated)
        return MobileOperationsOverview(updated, MobileOperationsSnapshotOrigin.LIVE)
    }

    suspend fun votePoll(pollId: UUID, selectedOptionIds: List<UUID>): PollResponse {
        val updatedPoll = gateway.votePoll(pollId = pollId, selectedOptionIds = selectedOptionIds)
        cache.loadSnapshot()?.let { cached ->
            cache.saveSnapshot(
                cached.copy(
                    polls = cached.polls.map { poll -> if (poll.id == pollId) updatedPoll else poll },
                    refreshedAt = clock.now(),
                ),
            )
        }
        return updatedPoll
    }

    suspend fun registerPushDevice(
        deviceId: String,
        appVersion: String,
        pushToken: String,
    ): DeviceRegistrationResponse = gateway.registerAndroidDevice(
        deviceId = deviceId,
        appVersion = appVersion,
        pushToken = pushToken,
    )

    suspend fun registerOrQueuePushDevice(
        deviceId: String,
        appVersion: String,
        pushToken: String,
    ): MobileQueuedSensitiveAction? = try {
        gateway.registerAndroidDevice(deviceId = deviceId, appVersion = appVersion, pushToken = pushToken)
        null
    } catch (error: Exception) {
        MobileQueuedSensitiveAction(
            id = requestIdFactory(),
            actionKind = MobileSensitiveActionKind.DEVICE_REGISTRATION,
            objectId = null,
            reasonKey = "operations_push_device_registration",
            deviceId = deviceId,
            appVersion = appVersion,
            pushToken = pushToken,
            createdAt = clock.now(),
            status = MobileQueuedActionStatus.READY_FOR_REPLAY,
            lastError = error.toString(),
        ).also { sensitiveActionStore.upsert(it) }
    }

    suspend fun ingestPushNotification(payload: MobilePushNotificationPayload): MobileRoutedNotification =
        MobileRoutedNotification(payload).also { notificationStore.saveNotification(it) }

    suspend fun notificationInbox(): MobileNotificationInbox =
        MobileNotificationInbox(notificationStore.loadNotifications())

    suspend fun markNotificationRead(id: String): MobileNotificationInbox {
        notificationStore.markRead(id = id, at = clock.now())
        return notificationInbox()
    }

    suspend fun approveWorkOrder(
        approval: MobileApprovalRow,
        comment: String,
        stepUpAssertion: PasskeyStepUpAssertion?,
    ): MobileQueuedSensitiveAction? {
        if (!approval.canExecuteOnMobile || stepUpAssertion == null) {
            return queueApprovalDecision(approval = approval, comment = comment)
        }
        return try {
            gateway.approveWorkOrder(workOrderId = approval.sourceId, comment = comment.trim())
            cache.saveSnapshot(refreshOverview().snapshot)
            null
        } catch (error: Exception) {
            MobileQueuedSensitiveAction(
                id = requestIdFactory(),
                actionKind = MobileSensitiveActionKind.APPROVAL_DECISION,
                objectId = approval.sourceId,
                reasonKey = "operations_passkey_approval_decision",
                comment = comment.trim(),
                createdAt = clock.now(),
                status = MobileQueuedActionStatus.READY_FOR_REPLAY,
                lastError = error.toString(),
            ).also { sensitiveActionStore.upsert(it) }
        }
    }

    suspend fun queueApprovalDecision(
        approval: MobileApprovalRow,
        comment: String,
    ): MobileQueuedSensitiveAction =
        MobileQueuedSensitiveAction(
            id = requestIdFactory(),
            actionKind = MobileSensitiveActionKind.APPROVAL_DECISION,
            objectId = approval.sourceId,
            reasonKey = "operations_passkey_approval_decision",
            comment = comment.trim(),
            createdAt = clock.now(),
            status = MobileQueuedActionStatus.WAITING_FOR_PASSKEY,
        ).also { sensitiveActionStore.upsert(it) }

    suspend fun recordOnDutyPing(
        state: com.maintenance.field.data.location.GpsCollectionState,
        latitude: Double,
        longitude: Double,
        accuracyM: Double?,
        recordedAt: OffsetDateTime,
    ): MobileQueuedSensitiveAction? {
        val request = LocationPingRequest(
            latitude = latitude,
            longitude = longitude,
            recordedAt = recordedAt,
            onDuty = state.onDuty,
            branchId = null,
            accuracyM = accuracyM,
        )
        if (!state.mayCollect) {
            return MobileQueuedSensitiveAction(
                id = requestIdFactory(),
                actionKind = MobileSensitiveActionKind.ON_DUTY_PING,
                objectId = null,
                reasonKey = "operations_on_duty_not_collecting",
                locationPing = request,
                createdAt = clock.now(),
                status = MobileQueuedActionStatus.WAITING_FOR_PASSKEY,
            )
        }
        return try {
            gateway.recordLocationPing(request)
            null
        } catch (error: Exception) {
            MobileQueuedSensitiveAction(
                id = requestIdFactory(),
                actionKind = MobileSensitiveActionKind.ON_DUTY_PING,
                objectId = null,
                reasonKey = "operations_on_duty_location_ping",
                locationPing = request,
                createdAt = clock.now(),
                status = MobileQueuedActionStatus.READY_FOR_REPLAY,
                lastError = error.toString(),
            ).also { sensitiveActionStore.upsert(it) }
        }
    }

    suspend fun sensitiveActionQueueSummary(): MobileSensitiveActionQueueSummary =
        MobileSensitiveActionQueueSummary(sensitiveActionStore.pending())

    suspend fun replaySensitiveActions(stepUpAssertion: PasskeyStepUpAssertion?): MobileReplaySummary {
        var attempted = 0
        var submitted = 0
        var failed = 0
        var waiting = 0

        sensitiveActionStore.pending()
            .filter { it.status == MobileQueuedActionStatus.READY_FOR_REPLAY }
            .forEach { action ->
                attempted += 1
                try {
                    when (action.actionKind) {
                        MobileSensitiveActionKind.DEVICE_REGISTRATION -> {
                            gateway.registerAndroidDevice(
                                deviceId = requireNotNull(action.deviceId),
                                appVersion = requireNotNull(action.appVersion),
                                pushToken = requireNotNull(action.pushToken),
                            )
                        }
                        MobileSensitiveActionKind.APPROVAL_DECISION -> {
                            if (stepUpAssertion == null) {
                                waiting += 1
                                return@forEach
                            }
                            gateway.approveWorkOrder(
                                workOrderId = requireNotNull(action.objectId),
                                comment = action.comment.orEmpty(),
                            )
                        }
                        MobileSensitiveActionKind.ON_DUTY_PING -> {
                            gateway.recordLocationPing(requireNotNull(action.locationPing))
                        }
                        MobileSensitiveActionKind.MAIL_SEND,
                        MobileSensitiveActionKind.POLL_VOTE,
                        MobileSensitiveActionKind.WORKFLOW_STEP_UP,
                        -> {
                            waiting += 1
                            return@forEach
                        }
                    }
                    sensitiveActionStore.markSubmitted(action.id)
                    submitted += 1
                } catch (error: Exception) {
                    sensitiveActionStore.markFailed(action.id, error.toString())
                    failed += 1
                }
            }
        return MobileReplaySummary(
            attempted = attempted,
            submitted = submitted,
            failed = failed,
            waitingForPasskey = waiting,
        )
    }

    fun stepUpEnvelope(
        actionKind: MobileSensitiveActionKind,
        objectId: UUID?,
        reasonKey: String,
        assertion: PasskeyStepUpAssertion? = null,
    ): MobilePasskeyStepUpEnvelope = MobilePasskeyStepUpEnvelope(
        actionKind = actionKind,
        objectId = objectId,
        reasonKey = reasonKey,
        assertion = assertion,
    )
}
