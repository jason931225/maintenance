package com.maintenance.field.data.collaboration

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
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
import com.maintenance.api.client.model.MobilePasskeyStepUpBinding
import com.maintenance.api.client.model.MobilePasskeyStepUpEnvelope
import com.maintenance.api.client.model.MobilePasskeyStepUpStartResponse
import com.maintenance.api.client.model.MobileStepUpActionKind
import com.maintenance.api.client.model.PasskeyStepUpAssertion
import com.maintenance.api.client.model.PollAnonymity
import com.maintenance.api.client.model.PollMyVote
import com.maintenance.api.client.model.PollOptionResponse
import com.maintenance.api.client.model.PollResponse
import com.maintenance.api.client.model.PollStatus
import com.maintenance.field.data.location.GpsCollectionState
import com.maintenance.field.data.local.FieldDatabase
import com.maintenance.field.data.local.RoomMobileNotificationStore
import com.maintenance.field.data.local.RoomMobileOperationsCacheStore
import com.maintenance.field.data.local.RoomMobileSensitiveActionStore
import com.maintenance.field.data.offline.FixedClock
import java.io.IOException
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
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
            notificationStore = InMemoryMobileNotificationStore(),
            sensitiveActionStore = InMemoryMobileSensitiveActionStore(),
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

        val pollBinding = repository.stepUpBinding(
            actionKind = MobileSensitiveActionKind.POLL_VOTE,
            objectId = pollId,
        )
        val queuedPoll = repository.votePoll(
            pollId = pollId,
            selectedOptionIds = listOf(pollOptionId),
            stepUp = generatedEnvelope(pollBinding),
        )

        assertEquals(null, queuedPoll)
        assertEquals(listOf(PollVoteRequest(pollId, listOf(pollOptionId), pollBinding)), gateway.pollVoteRequests)
        assertEquals(1, repository.cachedOverview()?.snapshot?.polls?.single()?.voteCount)

        val device = repository.registerPushDevice(
            deviceId = "android-device-a",
            appVersion = "0.1.0",
            pushToken = "fcm-token",
        )

        assertEquals("fcm-token", device.pushToken)
        assertEquals(listOf(DeviceRegistration("android-device-a", "0.1.0", "fcm-token")), gateway.deviceRegistrations)
        assertEquals(MobileStepUpActionKind.POLL_VOTE, pollBinding.actionKind)
        assertEquals(MobilePasskeyStepUpBinding.ReasonKey.OPERATIONS_PASSKEY_POLL_VOTE, pollBinding.reasonKey)
        assertEquals(null, pollBinding.replayAttempt)
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
            notificationStore = InMemoryMobileNotificationStore(),
            sensitiveActionStore = InMemoryMobileSensitiveActionStore(),
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
            stepUp = null,
        )

        assertEquals(MobileQueuedActionStatus.WAITING_FOR_PASSKEY, waitingApproval?.status)
        assertEquals(1, repository.sensitiveActionQueueSummary().pendingPasskeyCount)
        assertTrue(gateway.approvedWorkOrders.isEmpty())

        val approvalBinding = repository.stepUpBinding(
            actionKind = MobileSensitiveActionKind.APPROVAL_DECISION,
            objectId = workOrderId,
        )
        val submittedApproval = repository.approveWorkOrder(
            approval = approval,
            comment = "패스키 확인 후 승인",
            stepUp = generatedEnvelope(approvalBinding),
        )

        assertEquals(null, submittedApproval)
        assertEquals(listOf(ApprovedWorkOrder(workOrderId, "패스키 확인 후 승인", approvalBinding)), gateway.approvedWorkOrders)

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

    @Test
    fun repositoryRejectsMismatchedStepUpBindingBeforeSensitiveApiMutation() = runTest {
        val workOrderId = UUID.fromString("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
        val wrongWorkOrderId = UUID.fromString("ffffffff-ffff-4fff-8fff-ffffffffffff")
        val gateway = RecordingMobileOperationsGateway(
            mailFolders = listOf(generatedMailFolder()),
            mailThreads = listOf(generatedMailThread()),
            calendarEvents = listOf(generatedCalendarEvent()),
            polls = listOf(generatedPoll(submitted = false, voteCount = 0)),
        )
        val repository = MobileOperationsRepository(
            gateway = gateway,
            cache = InMemoryMobileOperationsCacheStore(),
            notificationStore = InMemoryMobileNotificationStore(),
            sensitiveActionStore = InMemoryMobileSensitiveActionStore(),
            clock = FixedClock(now),
        )

        assertFailsWith<IllegalArgumentException> {
            repository.approveWorkOrder(
                approval = generatedApprovalRow(workOrderId),
                comment = "잘못된 바인딩",
                stepUp = generatedEnvelope(
                    repository.stepUpBinding(
                        actionKind = MobileSensitiveActionKind.APPROVAL_DECISION,
                        objectId = wrongWorkOrderId,
                    ),
                ),
            )
        }

        assertFailsWith<IllegalArgumentException> {
            repository.approveWorkOrder(
                approval = generatedApprovalRow(workOrderId),
                comment = "빈 세리머니",
                stepUp = generatedEnvelope(
                    binding = repository.stepUpBinding(
                        actionKind = MobileSensitiveActionKind.APPROVAL_DECISION,
                        objectId = workOrderId,
                    ),
                    ceremonyId = UUID(0L, 0L),
                ),
            )
        }

        assertTrue(gateway.approvedWorkOrders.isEmpty())
    }

    @Test
    fun passkeyProtectedMobileActionsQueueNullStepUpAndRejectStaleImmediateAssertions() = runTest {
        val workOrderId = UUID.fromString("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
        val store = InMemoryMobileSensitiveActionStore()
        val gateway = RecordingMobileOperationsGateway(
            mailFolders = listOf(generatedMailFolder()),
            mailThreads = listOf(generatedMailThread()),
            calendarEvents = listOf(generatedCalendarEvent()),
            polls = listOf(generatedPoll(submitted = false, voteCount = 0)),
        )
        val repository = MobileOperationsRepository(
            gateway = gateway,
            cache = InMemoryMobileOperationsCacheStore(),
            notificationStore = InMemoryMobileNotificationStore(),
            sensitiveActionStore = store,
            clock = FixedClock(now),
        )

        val queuedApproval = repository.approveWorkOrder(
            approval = generatedApprovalRow(workOrderId),
            comment = "패스키 필요 승인",
            stepUp = null,
        )
        val queuedPoll = repository.votePoll(
            pollId = pollId,
            selectedOptionIds = listOf(pollOptionId),
            stepUp = null,
        )

        assertEquals(MobileQueuedActionStatus.WAITING_FOR_PASSKEY, queuedApproval?.status)
        assertEquals(MobileQueuedActionStatus.WAITING_FOR_PASSKEY, queuedPoll?.status)
        assertEquals(2, repository.sensitiveActionQueueSummary().pendingPasskeyCount)
        assertTrue(gateway.approvedWorkOrders.isEmpty())
        assertTrue(gateway.pollVoteRequests.isEmpty())

        assertFailsWith<IllegalArgumentException> {
            repository.approveWorkOrder(
                approval = generatedApprovalRow(workOrderId),
                comment = "즉시 승인에 재생 바인딩 재사용",
                stepUp = generatedEnvelope(
                    repository.stepUpBinding(
                        actionKind = MobileSensitiveActionKind.APPROVAL_DECISION,
                        objectId = workOrderId,
                        replayAttempt = 1,
                    ),
                ),
            )
        }
        assertFailsWith<IllegalArgumentException> {
            repository.votePoll(
                pollId = pollId,
                selectedOptionIds = listOf(pollOptionId),
                stepUp = generatedEnvelope(
                    repository.stepUpBinding(
                        actionKind = MobileSensitiveActionKind.APPROVAL_DECISION,
                        objectId = workOrderId,
                    ),
                ),
            )
        }
        assertFailsWith<IllegalArgumentException> {
            repository.votePoll(
                pollId = pollId,
                selectedOptionIds = listOf(pollOptionId),
                stepUp = generatedEnvelope(
                    binding = repository.stepUpBinding(
                        actionKind = MobileSensitiveActionKind.POLL_VOTE,
                        objectId = pollId,
                    ),
                    ceremonyId = UUID(0L, 0L),
                ),
            )
        }

        assertEquals(2, store.pending().count { it.status == MobileQueuedActionStatus.WAITING_FOR_PASSKEY })
        assertTrue(gateway.approvedWorkOrders.isEmpty())
        assertTrue(gateway.pollVoteRequests.isEmpty())

        val approvalBinding = repository.stepUpBinding(
            actionKind = MobileSensitiveActionKind.APPROVAL_DECISION,
            objectId = workOrderId,
        )
        val pollBinding = repository.stepUpBinding(
            actionKind = MobileSensitiveActionKind.POLL_VOTE,
            objectId = pollId,
        )

        assertEquals(
            null,
            repository.approveWorkOrder(
                approval = generatedApprovalRow(workOrderId),
                comment = "신규 패스키 승인",
                stepUp = generatedEnvelope(approvalBinding),
            ),
        )
        assertEquals(
            null,
            repository.votePoll(
                pollId = pollId,
                selectedOptionIds = listOf(pollOptionId),
                stepUp = generatedEnvelope(pollBinding),
            ),
        )
        assertEquals(listOf(ApprovedWorkOrder(workOrderId, "신규 패스키 승인", approvalBinding)), gateway.approvedWorkOrders)
        assertEquals(listOf(PollVoteRequest(pollId, listOf(pollOptionId), pollBinding)), gateway.pollVoteRequests)
        assertEquals(MobilePasskeyStepUpBinding.ReasonKey.OPERATIONS_PASSKEY_APPROVAL_DECISION, approvalBinding.reasonKey)
        assertEquals(MobilePasskeyStepUpBinding.ReasonKey.OPERATIONS_PASSKEY_POLL_VOTE, pollBinding.reasonKey)
    }

    @Test
    fun replaySensitiveActionsRequiresFreshStepUpEnvelopePerReplayAttempt() = runTest {
        val workOrderId = UUID.fromString("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
        val store = InMemoryMobileSensitiveActionStore()
        val gateway = RecordingMobileOperationsGateway(
            mailFolders = listOf(generatedMailFolder()),
            mailThreads = listOf(generatedMailThread()),
            calendarEvents = listOf(generatedCalendarEvent()),
            polls = listOf(generatedPoll(submitted = false, voteCount = 0)),
        )
        val repository = MobileOperationsRepository(
            gateway = gateway,
            cache = InMemoryMobileOperationsCacheStore(),
            notificationStore = InMemoryMobileNotificationStore(),
            sensitiveActionStore = store,
            requestIdFactory = { UUID.randomUUID().toString() },
            clock = FixedClock(now),
        )
        repository.queueApprovalDecision(
            approval = generatedApprovalRow(workOrderId),
            comment = "재생 승인",
            status = MobileQueuedActionStatus.WAITING_FOR_PASSKEY,
            nextReplayAttempt = 2,
        )
        repository.queuePollVote(
            pollId = pollId,
            selectedOptionIds = listOf(pollOptionId),
            status = MobileQueuedActionStatus.WAITING_FOR_PASSKEY,
            nextReplayAttempt = 2,
        )

        val staleReplay = repository.replaySensitiveActions { action, _ ->
            val staleBinding = when (action.actionKind) {
                MobileSensitiveActionKind.APPROVAL_DECISION -> repository.stepUpBinding(
                    actionKind = action.actionKind,
                    objectId = requireNotNull(action.objectId),
                    replayAttempt = 1,
                )
                MobileSensitiveActionKind.POLL_VOTE -> repository.stepUpBinding(
                    actionKind = action.actionKind,
                    objectId = requireNotNull(action.objectId),
                    replayAttempt = null,
                )
                else -> error("unexpected passkey replay action ${action.actionKind}")
            }
            generatedEnvelope(staleBinding)
        }

        assertEquals(MobileReplaySummary(attempted = 2, submitted = 0, failed = 0, waitingForPasskey = 2), staleReplay)
        assertTrue(gateway.approvedWorkOrders.isEmpty())
        assertTrue(gateway.pollVoteRequests.isEmpty())
        assertTrue(store.pending().all { it.status == MobileQueuedActionStatus.WAITING_FOR_PASSKEY })
        assertTrue(store.pending().all { it.lastError?.contains("binding mismatch") == true })

        val nullReplay = repository.replaySensitiveActions { _, _ -> null }

        assertEquals(MobileReplaySummary(attempted = 2, submitted = 0, failed = 0, waitingForPasskey = 2), nullReplay)
        assertTrue(gateway.approvedWorkOrders.isEmpty())
        assertTrue(gateway.pollVoteRequests.isEmpty())

        val freshReplay = repository.replaySensitiveActions { action, binding ->
            assertEquals(
                repository.stepUpBinding(
                    actionKind = action.actionKind,
                    objectId = requireNotNull(action.objectId),
                    replayAttempt = action.nextReplayAttempt,
                ),
                binding,
            )
            val ceremonyId = when (action.actionKind) {
                MobileSensitiveActionKind.APPROVAL_DECISION -> UUID.fromString("eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01")
                MobileSensitiveActionKind.POLL_VOTE -> UUID.fromString("eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02")
                else -> error("unexpected passkey replay action ${action.actionKind}")
            }
            generatedEnvelope(binding, ceremonyId = ceremonyId)
        }

        assertEquals(MobileReplaySummary(attempted = 2, submitted = 2, failed = 0, waitingForPasskey = 0), freshReplay)
        assertEquals(listOf(ApprovedWorkOrder(workOrderId, "재생 승인", approvalActionReplayBinding(workOrderId).copy(replayAttempt = 2))), gateway.approvedWorkOrders)
        assertEquals(listOf(PollVoteRequest(pollId, listOf(pollOptionId), pollActionReplayBinding(pollId).copy(replayAttempt = 2))), gateway.pollVoteRequests)
        assertTrue(store.pending().isEmpty())
    }

    @Test
    fun durableRoomStoresRestoreCachedOverviewAndNotificationReadStateAfterRepositoryReconstruction() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val dbName = "mobile-operations-cache-${UUID.randomUUID()}.db"
        context.deleteDatabase(dbName)

        val gateway = RecordingMobileOperationsGateway(
            mailFolders = listOf(generatedMailFolder()),
            mailThreads = listOf(generatedMailThread()),
            calendarEvents = listOf(generatedCalendarEvent()),
            polls = listOf(generatedPoll(submitted = false, voteCount = 0)),
        )
        openFieldDatabase(context, dbName).useDatabase { database ->
            val repository = durableRepository(gateway = gateway, database = database)

            val live = repository.refreshOverview()
            repository.ingestPushNotification(
                MobilePushNotificationPayload(
                    id = "push-approval-1",
                    title = "긴급 승인",
                    body = "계획업무 승인이 필요합니다.",
                    category = "approval",
                    priority = MobileNotificationPriority.CRITICAL,
                    objectType = "work_order",
                    objectId = mailThreadId,
                    receivedAt = now,
                ),
            )
            val readInbox = repository.markNotificationRead("push-approval-1")

            assertEquals(MobileOperationsSnapshotOrigin.LIVE, live.origin)
            assertEquals(0, readInbox.unreadCount)
        }

        try {
            openFieldDatabase(context, dbName).useDatabase { database ->
                val restoredRepository = durableRepository(gateway = gateway, database = database)

                val cached = assertNotNull(restoredRepository.cachedOverview())
                val restoredInbox = restoredRepository.notificationInbox()

                assertEquals(MobileOperationsSnapshotOrigin.CACHED_AFTER_FAILURE, cached.origin)
                assertEquals(mailThreadId, cached.snapshot.mailThreads.single().id)
                assertEquals(1, restoredInbox.notifications.size)
                assertEquals(0, restoredInbox.unreadCount)
                assertEquals(now, restoredInbox.notifications.single().readAt)
            }
        } finally {
            context.deleteDatabase(dbName)
        }
    }

    @Test
    fun durableRoomStoresRestoreQueuedSensitiveActionsAfterRepositoryReconstruction() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val dbName = "mobile-operations-actions-${UUID.randomUUID()}.db"
        val workOrderId = UUID.fromString("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
        var nextRequest = 0
        context.deleteDatabase(dbName)

        openFieldDatabase(context, dbName).useDatabase { database ->
            val gateway = RecordingMobileOperationsGateway(
                mailFolders = listOf(generatedMailFolder()),
                mailThreads = listOf(generatedMailThread()),
                calendarEvents = listOf(generatedCalendarEvent()),
                polls = listOf(generatedPoll(submitted = false, voteCount = 0)),
            )
            val repository = durableRepository(
                gateway = gateway,
                database = database,
                requestIdFactory = { "persisted-${++nextRequest}" },
            )

            gateway.failNextDeviceRegistration = IOException("offline")
            repository.registerOrQueuePushDevice(
                deviceId = "android-device-a",
                appVersion = "0.1.0",
                pushToken = "fcm-token",
            )
            repository.approveWorkOrder(
                approval = generatedApprovalRow(workOrderId),
                comment = "현장 증빙 확인 후 승인",
                stepUp = null,
            )
            repository.votePoll(
                pollId = pollId,
                selectedOptionIds = listOf(pollOptionId),
                stepUp = null,
            )
            gateway.failNextLocationPing = IOException("offline")
            repository.recordOnDutyPing(
                state = GpsCollectionState(consentState = LocationConsentState.GRANTED, onDuty = true),
                latitude = 37.5665,
                longitude = 126.9780,
                accuracyM = 5.0,
                recordedAt = now,
            )

            val queuedSummary = repository.sensitiveActionQueueSummary()
            assertEquals(2, queuedSummary.pendingPasskeyCount)
            assertEquals(2, queuedSummary.readyForReplayCount)
        }

        try {
            openFieldDatabase(context, dbName).useDatabase { database ->
                val replayGateway = RecordingMobileOperationsGateway(
                    mailFolders = listOf(generatedMailFolder()),
                    mailThreads = listOf(generatedMailThread()),
                    calendarEvents = listOf(generatedCalendarEvent()),
                    polls = listOf(generatedPoll(submitted = false, voteCount = 0)),
                )
                val restoredRepository = durableRepository(
                    gateway = replayGateway,
                    database = database,
                    requestIdFactory = { "unused-${++nextRequest}" },
                )

                val restoredSummary = restoredRepository.sensitiveActionQueueSummary()
                assertEquals(2, restoredSummary.pendingPasskeyCount)
                assertEquals(2, restoredSummary.readyForReplayCount)

                val restoredActions = RoomMobileSensitiveActionStore(database.mobileSensitiveActions()).pending()
                val approvalAction = restoredActions.single { it.actionKind == MobileSensitiveActionKind.APPROVAL_DECISION }
                val pollAction = restoredActions.single { it.actionKind == MobileSensitiveActionKind.POLL_VOTE }
                val deviceAction = restoredActions.single { it.actionKind == MobileSensitiveActionKind.DEVICE_REGISTRATION }
                val locationAction = restoredActions.single { it.actionKind == MobileSensitiveActionKind.ON_DUTY_PING }
                assertEquals(workOrderId, approvalAction.objectId)
                assertEquals("현장 증빙 확인 후 승인", approvalAction.comment)
                assertEquals(pollId, pollAction.objectId)
                assertEquals(listOf(pollOptionId), pollAction.selectedOptionIds)
                assertEquals("android-device-a", deviceAction.deviceId)
                assertEquals(37.5665, locationAction.locationPing?.latitude)
                assertEquals(126.9780, locationAction.locationPing?.longitude)

                val replay = restoredRepository.replaySensitiveActions { _, binding ->
                    generatedEnvelope(binding)
                }

                assertEquals(4, replay.attempted)
                assertEquals(4, replay.submitted)
                assertEquals(
                    listOf(DeviceRegistration("android-device-a", "0.1.0", "fcm-token")),
                    replayGateway.deviceRegistrations,
                )
                assertEquals(
                    listOf(ApprovedWorkOrder(workOrderId, "현장 증빙 확인 후 승인", approvalActionReplayBinding(workOrderId))),
                    replayGateway.approvedWorkOrders,
                )
                assertEquals(
                    listOf(PollVoteRequest(pollId, listOf(pollOptionId), pollActionReplayBinding(pollId))),
                    replayGateway.pollVoteRequests,
                )
                assertEquals(1, replayGateway.locationPings.size)

                val afterReplaySummary = restoredRepository.sensitiveActionQueueSummary()
                assertEquals(0, afterReplaySummary.pendingPasskeyCount)
                assertEquals(0, afterReplaySummary.readyForReplayCount)
            }
        } finally {
            context.deleteDatabase(dbName)
        }
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

    private fun generatedApprovalRow(workOrderId: UUID): MobileApprovalRow = MobileApprovalRow(
        id = "WORK_ORDER:$workOrderId",
        source = ApprovalItem.Source.WORK_ORDER,
        sourceId = workOrderId,
        title = "계획업무 승인",
        summary = "정비사가 현장 작업 결재를 요청했습니다.",
        actionHref = "/api/v1/work-orders/$workOrderId/approve",
    )

    private fun generatedEnvelope(
        binding: MobilePasskeyStepUpBinding,
        ceremonyId: UUID = UUID.fromString("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    ): MobilePasskeyStepUpEnvelope =
        MobilePasskeyStepUpEnvelope(
            binding = binding,
            assertion = PasskeyStepUpAssertion(
                ceremonyId = ceremonyId,
                credential = emptyMap(),
            ),
        )

    private fun approvalActionReplayBinding(workOrderId: UUID): MobilePasskeyStepUpBinding =
        MobilePasskeyStepUpBinding(
            actionKind = MobileStepUpActionKind.APPROVAL_DECISION,
            objectId = workOrderId,
            reasonKey = MobilePasskeyStepUpBinding.ReasonKey.OPERATIONS_PASSKEY_APPROVAL_DECISION,
            replayAttempt = 1,
        )

    private fun pollActionReplayBinding(pollId: UUID): MobilePasskeyStepUpBinding =
        MobilePasskeyStepUpBinding(
            actionKind = MobileStepUpActionKind.POLL_VOTE,
            objectId = pollId,
            reasonKey = MobilePasskeyStepUpBinding.ReasonKey.OPERATIONS_PASSKEY_POLL_VOTE,
            replayAttempt = 1,
        )

    private fun openFieldDatabase(context: Context, name: String): FieldDatabase =
        Room.databaseBuilder(context, FieldDatabase::class.java, name)
            .allowMainThreadQueries()
            .build()

    private inline fun <R> FieldDatabase.useDatabase(block: (FieldDatabase) -> R): R = try {
        block(this)
    } finally {
        close()
    }

    private fun durableRepository(
        gateway: MobileOperationsGateway,
        database: FieldDatabase,
        requestIdFactory: () -> String = { UUID.randomUUID().toString() },
    ): MobileOperationsRepository = MobileOperationsRepository(
        gateway = gateway,
        cache = RoomMobileOperationsCacheStore(database.mobileOperationsSnapshots()),
        notificationStore = RoomMobileNotificationStore(database.mobileNotifications()),
        sensitiveActionStore = RoomMobileSensitiveActionStore(database.mobileSensitiveActions()),
        requestIdFactory = requestIdFactory,
        clock = FixedClock(now),
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

        override suspend fun startMobilePasskeyStepUp(
            binding: MobilePasskeyStepUpBinding,
        ): MobilePasskeyStepUpStartResponse = MobilePasskeyStepUpStartResponse(
            ceremonyId = UUID.fromString("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
            challenge = emptyMap(),
            expiresAt = now.plusMinutes(5),
            binding = binding,
        )

        override suspend fun approveWorkOrder(
            workOrderId: UUID,
            comment: String,
            stepUp: MobilePasskeyStepUpEnvelope,
        ) {
            approvedWorkOrders += ApprovedWorkOrder(workOrderId, comment, stepUp.binding)
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

        override suspend fun votePoll(
            pollId: UUID,
            selectedOptionIds: List<UUID>,
            stepUp: MobilePasskeyStepUpEnvelope,
        ): PollResponse {
            pollVoteRequests += PollVoteRequest(pollId, selectedOptionIds, stepUp.binding)
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
private data class ApprovedWorkOrder(
    val workOrderId: UUID,
    val comment: String,
    val binding: MobilePasskeyStepUpBinding,
)
private data class ReadStateRequest(val threadId: UUID, val seen: Boolean)
private data class PollVoteRequest(
    val pollId: UUID,
    val selectedOptionIds: List<UUID>,
    val binding: MobilePasskeyStepUpBinding,
)
private data class DeviceRegistration(val deviceId: String, val appVersion: String, val pushToken: String?)
