package com.maintenance.field.data.collaboration

import com.maintenance.api.client.model.ApprovalItemsPage
import com.maintenance.api.client.model.ApprovalItem
import com.maintenance.api.client.model.CalendarEventResponse
import com.maintenance.api.client.model.CalendarEventStatus
import com.maintenance.api.client.model.CollaborationScopePolicy
import com.maintenance.api.client.model.CollaborationScopeType
import com.maintenance.api.client.model.DevicePlatform
import com.maintenance.api.client.model.DeviceRegistrationResponse
import com.maintenance.api.client.model.LocationConsentState
import com.maintenance.api.client.model.LocationPingRequest
import com.maintenance.api.client.model.MailFolderView
import com.maintenance.api.client.model.MailThreadView
import com.maintenance.api.client.model.PasskeyStepUpAssertion
import com.maintenance.api.client.model.PollAnonymity
import com.maintenance.api.client.model.PollMyVote
import com.maintenance.api.client.model.PollOptionResponse
import com.maintenance.api.client.model.PollResponse
import com.maintenance.api.client.model.PollStatus
import com.maintenance.field.data.location.GpsCollectionState
import com.maintenance.field.data.offline.FixedClock
import java.io.IOException
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class MobileOperationsRepositoryTest {
    private val mailFolderId = UUID.fromString("66666666-6666-4666-8666-666666666666")
    private val mailThreadId = UUID.fromString("77777777-7777-4777-8777-777777777777")
    private val calendarEventId = UUID.fromString("88888888-8888-4888-8888-888888888888")
    private val pollId = UUID.fromString("99999999-9999-4999-8999-999999999999")
    private val pollOptionId = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    private val now = OffsetDateTime.parse("2026-06-12T12:00:00Z")

    @Test
    fun repositoryCachesProductionOperationsAndMutatesReadVoteDeviceSeams() = runTest {
        val gateway = RecordingMobileOperationsGateway(
            mailFolders = listOf(generatedMailFolder()),
            mailThreads = listOf(generatedMailThread()),
            calendarEvents = listOf(generatedCalendarEvent()),
            polls = listOf(generatedPoll(submitted = false, voteCount = 0)),
        )
        val repository = MobileOperationsRepository(
            gateway = gateway,
            cache = InMemoryMobileOperationsCacheStore(),
            clock = FixedClock(now),
        )

        val live = repository.refreshOverview()

        assertEquals(MobileOperationsSnapshotOrigin.LIVE, live.origin)
        assertEquals(0, live.snapshot.approvals.total)
        assertEquals("받은메일함", live.snapshot.mailFolders.single().name)
        assertEquals(2, live.snapshot.mailThreads.single().unreadCount)
        assertEquals("주간 정비 계획", live.snapshot.calendarEvents.single().title)
        assertEquals(false, live.snapshot.polls.single().myVote.submitted)
        assertEquals(listOf(ApprovalQuery(50, 0)), gateway.approvalQueries)

        gateway.failNextApproval = IOException("offline")
        val cached = repository.refreshOverview()

        assertEquals(MobileOperationsSnapshotOrigin.CACHED_AFTER_FAILURE, cached.origin)
        assertEquals(mailThreadId, cached.snapshot.mailThreads.single().id)
        assertTrue(cached.failureDescription?.isNotBlank() == true)

        val readOverview = repository.markMailThreadSeen(threadId = mailThreadId, seen = true)

        assertEquals(listOf(ReadStateRequest(mailThreadId, true)), gateway.readStateRequests)
        assertEquals(0, readOverview?.snapshot?.mailThreads?.single()?.unreadCount)

        val updatedPoll = repository.votePoll(pollId = pollId, selectedOptionIds = listOf(pollOptionId))

        assertEquals(listOf(PollVoteRequest(pollId, listOf(pollOptionId))), gateway.pollVoteRequests)
        assertEquals(true, updatedPoll.myVote.submitted)
        assertEquals(1, repository.cachedOverview()?.snapshot?.polls?.single()?.voteCount)

        val device = repository.registerPushDevice(
            deviceId = "android-device-a",
            appVersion = "0.1.0",
            pushToken = "fcm-token",
        )

        assertEquals("fcm-token", device.pushToken)
        assertEquals(listOf(DeviceRegistration("android-device-a", "0.1.0", "fcm-token")), gateway.deviceRegistrations)

        val stepUp = repository.stepUpEnvelope(
            actionKind = MobileSensitiveActionKind.POLL_VOTE,
            objectId = pollId,
            reasonKey = "passkey_step_up_poll_vote",
        )

        assertEquals(MobileSensitiveActionKind.POLL_VOTE, stepUp.actionKind)
        assertTrue(stepUp.requiresFreshPasskey)
        assertNotNull(stepUp.reasonKey)
    }

    @Test
    fun repositoryRoutesPushBadgesAndQueuesSensitiveMobileActionsUntilPasskeyOrReplay() = runTest {
        var nextRequest = 0
        val workOrderId = UUID.fromString("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
        val gateway = RecordingMobileOperationsGateway(
            mailFolders = listOf(generatedMailFolder()),
            mailThreads = listOf(generatedMailThread()),
            calendarEvents = listOf(generatedCalendarEvent()),
            polls = listOf(generatedPoll(submitted = false, voteCount = 0)),
        )
        val repository = MobileOperationsRepository(
            gateway = gateway,
            cache = InMemoryMobileOperationsCacheStore(),
            clock = FixedClock(now),
            requestIdFactory = { "queued-${++nextRequest}" },
        )

        gateway.failNextDeviceRegistration = IOException("offline")
        val queuedDevice = repository.registerOrQueuePushDevice(
            deviceId = "android-device-a",
            appVersion = "0.1.0",
            pushToken = "fcm-token",
        )

        assertEquals(MobileSensitiveActionKind.DEVICE_REGISTRATION, queuedDevice?.actionKind)
        assertEquals(1, repository.sensitiveActionQueueSummary().readyForReplayCount)

        val notification = repository.ingestPushNotification(
            MobilePushNotificationPayload(
                id = "push-approval-1",
                title = "긴급 승인",
                body = "계획업무 승인이 필요합니다.",
                category = "approval",
                priority = MobileNotificationPriority.CRITICAL,
                objectType = "work_order",
                objectId = workOrderId,
                receivedAt = now,
            ),
        )

        assertEquals(MobileNotificationRoute.OPERATIONS_APPROVAL, notification.route)
        assertEquals(1, repository.notificationInbox().urgentUnreadCount)
        assertEquals(0, repository.markNotificationRead("push-approval-1").unreadCount)

        val approval = MobileApprovalRow(
            id = "WORK_ORDER:$workOrderId",
            source = ApprovalItem.Source.WORK_ORDER,
            sourceId = workOrderId,
            title = "계획업무 승인",
            summary = "정비사가 현장 작업 결재를 요청했습니다.",
            actionHref = "/api/v1/work-orders/$workOrderId/approve",
        )

        val waitingApproval = repository.approveWorkOrder(
            approval = approval,
            comment = "현장 증빙 확인 후 승인",
            stepUpAssertion = null,
        )

        assertEquals(MobileQueuedActionStatus.WAITING_FOR_PASSKEY, waitingApproval?.status)
        assertEquals(1, repository.sensitiveActionQueueSummary().pendingPasskeyCount)
        assertTrue(gateway.approvedWorkOrders.isEmpty())

        val submittedApproval = repository.approveWorkOrder(
            approval = approval,
            comment = "패스키 확인 후 승인",
            stepUpAssertion = PasskeyStepUpAssertion(
                ceremonyId = UUID.fromString("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
                credential = emptyMap(),
            ),
        )

        assertEquals(null, submittedApproval)
        assertEquals(listOf(ApprovedWorkOrder(workOrderId, "패스키 확인 후 승인")), gateway.approvedWorkOrders)

        gateway.failNextLocationPing = IOException("offline")
        val queuedPing = repository.recordOnDutyPing(
            state = GpsCollectionState(consentState = LocationConsentState.GRANTED, onDuty = true),
            latitude = 37.5665,
            longitude = 126.9780,
            accuracyM = 5.0,
            recordedAt = now,
        )

        assertEquals(MobileSensitiveActionKind.ON_DUTY_PING, queuedPing?.actionKind)
        assertEquals(MobileQueuedActionStatus.READY_FOR_REPLAY, queuedPing?.status)
        assertEquals(2, repository.sensitiveActionQueueSummary().readyForReplayCount)
    }

    private fun generatedMailFolder(): MailFolderView = MailFolderView(
        id = mailFolderId,
        role = "INBOX",
        name = "받은메일함",
        unreadCount = 2,
        totalCount = 10,
    )

    private fun generatedMailThread(unreadCount: Long = 2): MailThreadView = MailThreadView(
        id = mailThreadId,
        subject = "승인 증빙 확인",
        lastMessageAt = OffsetDateTime.parse("2026-06-12T11:30:00Z"),
        messageCount = 4,
        unreadCount = unreadCount,
        hasAttachments = true,
        isFlagged = false,
    )

    private fun generatedPolicy(): CollaborationScopePolicy = CollaborationScopePolicy(
        enforcement = CollaborationScopePolicy.Enforcement.SERVER,
        scopeType = CollaborationScopeType.ORG,
        visibility = CollaborationScopePolicy.Visibility.ORG_MEMBERS,
    )

    private fun generatedCalendarEvent(): CalendarEventResponse = CalendarEventResponse(
        id = calendarEventId,
        scopeType = CollaborationScopeType.ORG,
        title = "주간 정비 계획",
        description = "현장 정비 캘린더",
        startsAt = OffsetDateTime.parse("2026-06-12T13:00:00Z"),
        endsAt = OffsetDateTime.parse("2026-06-12T14:00:00Z"),
        allDay = false,
        status = CalendarEventStatus.ACTIVE,
        createdAt = OffsetDateTime.parse("2026-06-12T10:00:00Z"),
        updatedAt = OffsetDateTime.parse("2026-06-12T10:00:00Z"),
        policy = generatedPolicy(),
        objectType = "work_order",
    )

    private fun generatedPoll(submitted: Boolean, voteCount: Long): PollResponse = PollResponse(
        id = pollId,
        targetScopeType = CollaborationScopeType.ORG,
        title = "작업 일정 투표",
        question = "오전 정비를 먼저 진행할까요?",
        status = PollStatus.OPEN,
        anonymity = PollAnonymity.NAMED,
        allowMultiple = false,
        options = listOf(
            PollOptionResponse(
                id = pollOptionId,
                label = "찬성",
                position = 0,
                voteCount = voteCount,
            ),
        ),
        voteCount = voteCount,
        myVote = PollMyVote(
            submitted = submitted,
            selectedOptionIds = if (submitted) listOf(pollOptionId) else emptyList(),
        ),
        createdAt = OffsetDateTime.parse("2026-06-12T10:00:00Z"),
        updatedAt = OffsetDateTime.parse("2026-06-12T10:00:00Z"),
        policy = generatedPolicy(),
        objectType = "work_order",
    )

    private fun generatedDevice(pushToken: String?): DeviceRegistrationResponse = DeviceRegistrationResponse(
        id = UUID.fromString("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        userId = UUID.fromString("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        deviceHash = "hash",
        platform = DevicePlatform.ANDROID,
        appVersion = "0.1.0",
        lastRegisteredAt = now,
        pushToken = pushToken,
    )

    private inner class RecordingMobileOperationsGateway(
        private val mailFolders: List<MailFolderView>,
        private var mailThreads: List<MailThreadView>,
        private val calendarEvents: List<CalendarEventResponse>,
        private var polls: List<PollResponse>,
    ) : MobileOperationsGateway {
        var failNextApproval: IOException? = null
        var failNextDeviceRegistration: IOException? = null
        var failNextLocationPing: IOException? = null
        val approvalQueries = mutableListOf<ApprovalQuery>()
        val approvedWorkOrders = mutableListOf<ApprovedWorkOrder>()
        val readStateRequests = mutableListOf<ReadStateRequest>()
        val pollVoteRequests = mutableListOf<PollVoteRequest>()
        val deviceRegistrations = mutableListOf<DeviceRegistration>()
        val locationPings = mutableListOf<LocationPingRequest>()

        override suspend fun listApprovalItems(limit: Long, offset: Long): ApprovalItemsPage {
            approvalQueries += ApprovalQuery(limit, offset)
            failNextApproval?.let {
                failNextApproval = null
                throw it
            }
            return ApprovalItemsPage(items = emptyList(), sources = emptyList(), limit = limit, offset = offset, total = 0)
        }

        override suspend fun approveWorkOrder(workOrderId: UUID, comment: String) {
            approvedWorkOrders += ApprovedWorkOrder(workOrderId, comment)
        }

        override suspend fun listMailFolders(): List<MailFolderView> = mailFolders

        override suspend fun listMailThreads(
            unread: Boolean?,
            query: String?,
            folderId: UUID?,
            before: Long?,
            limit: Long,
        ): List<MailThreadView> = mailThreads

        override suspend fun setMailThreadReadState(threadId: UUID, seen: Boolean) {
            readStateRequests += ReadStateRequest(threadId, seen)
        }

        override suspend fun listCalendarEvents(
            from: OffsetDateTime?,
            to: OffsetDateTime?,
            limit: Long,
        ): List<CalendarEventResponse> = calendarEvents

        override suspend fun listPolls(status: PollStatus?, limit: Long): List<PollResponse> = polls

        override suspend fun votePoll(pollId: UUID, selectedOptionIds: List<UUID>): PollResponse {
            pollVoteRequests += PollVoteRequest(pollId, selectedOptionIds)
            val updated = generatedPoll(submitted = true, voteCount = selectedOptionIds.size.toLong())
            polls = listOf(updated)
            return updated
        }

        override suspend fun registerAndroidDevice(
            deviceId: String,
            appVersion: String,
            pushToken: String?,
        ): DeviceRegistrationResponse {
            failNextDeviceRegistration?.let {
                failNextDeviceRegistration = null
                throw it
            }
            deviceRegistrations += DeviceRegistration(deviceId, appVersion, pushToken)
            return generatedDevice(pushToken)
        }

        override suspend fun recordLocationPing(request: LocationPingRequest) {
            failNextLocationPing?.let {
                failNextLocationPing = null
                throw it
            }
            locationPings += request
        }
    }
}

private data class ApprovalQuery(val limit: Long, val offset: Long)
private data class ApprovedWorkOrder(val workOrderId: UUID, val comment: String)
private data class ReadStateRequest(val threadId: UUID, val seen: Boolean)
private data class PollVoteRequest(val pollId: UUID, val selectedOptionIds: List<UUID>)
private data class DeviceRegistration(val deviceId: String, val appVersion: String, val pushToken: String?)
