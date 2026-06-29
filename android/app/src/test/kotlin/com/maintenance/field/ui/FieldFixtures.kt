package com.maintenance.field.ui

import com.maintenance.api.client.model.ApprovalItemsPage
import com.maintenance.api.client.model.CalendarEventResponse
import com.maintenance.api.client.model.CalendarEventStatus
import com.maintenance.api.client.model.CollaborationScopePolicy
import com.maintenance.api.client.model.CollaborationScopeType
import com.maintenance.api.client.model.MailFolderView
import com.maintenance.api.client.model.MailThreadView
import com.maintenance.api.client.model.PollAnonymity
import com.maintenance.api.client.model.PollMyVote
import com.maintenance.api.client.model.PollOptionResponse
import com.maintenance.api.client.model.PollResponse
import com.maintenance.api.client.model.PollStatus
import com.maintenance.api.client.model.LocationConsentState
import com.maintenance.api.client.model.LocationConsentStatus
import com.maintenance.api.client.model.MessengerThreadKind
import com.maintenance.api.client.model.PriorityLevel
import com.maintenance.api.client.model.WorkOrderStatus
import com.maintenance.field.data.api.TechnicianWorkOrder
import com.maintenance.field.data.collaboration.MobileOperationsDashboard
import com.maintenance.field.data.collaboration.MobileOperationsSnapshot
import com.maintenance.field.data.messenger.MessengerAction
import com.maintenance.field.data.messenger.MessengerMessage
import com.maintenance.field.data.messenger.MessengerMessagePage
import com.maintenance.field.data.messenger.MessengerReducer
import com.maintenance.field.data.messenger.MessengerState
import com.maintenance.field.data.messenger.MessengerThread
import com.maintenance.field.data.offline.SyncState
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID

/**
 * Real domain fixtures for the field-screen tests.
 *
 * These are the SAME data classes the production app renders ([TechnicianWorkOrder],
 * [MessengerState], [LocationConsentStatus]); they are constructed with concrete seeded
 * values rather than via a fake gateway. The screen composables under test take plain
 * domain models plus callbacks, so seeding the models here exercises the real rendering
 * path without any test double standing in for the API/session layer.
 */
internal object FieldFixtures {
    private val EPOCH: OffsetDateTime = OffsetDateTime.of(2026, 6, 16, 9, 0, 0, 0, ZoneOffset.UTC)

    private fun uuid(suffix: String): UUID =
        UUID.fromString("00000000-0000-0000-0000-0000000${suffix}")

    val urgentWorkOrder = TechnicianWorkOrder(
        id = uuid("00100"),
        requestNo = "WO-2026-0001",
        managementNo = "MGMT-7788",
        modelName = "FBT15",
        customerName = "한국물류",
        siteName = "인천 1센터",
        priority = PriorityLevel.P1,
        prioritySort = 0,
        status = WorkOrderStatus.ASSIGNED,
        targetDueAt = EPOCH.plusHours(4),
        symptom = "마스트 상승 불가",
        syncState = SyncState.SYNCED,
        assigneeNames = listOf("김기사"),
    )

    val pendingWorkOrder = TechnicianWorkOrder(
        id = uuid("00200"),
        requestNo = "WO-2026-0002",
        managementNo = "MGMT-9911",
        modelName = "BT-Reach",
        customerName = "대성유통",
        siteName = "평택 물류",
        priority = PriorityLevel.P3,
        prioritySort = 2,
        status = WorkOrderStatus.IN_PROGRESS,
        targetDueAt = null,
        symptom = null,
        syncState = SyncState.PENDING,
        assigneeNames = listOf("이정비", "박기사"),
    )

    val todayOrders: List<TechnicianWorkOrder> = listOf(urgentWorkOrder, pendingWorkOrder)

    val grantedConsent = LocationConsentStatus(
        consentId = uuid("00300"),
        userId = uuid("00301"),
        branchId = uuid("00302"),
        state = LocationConsentState.GRANTED,
        mayCollect = true,
        grantedAt = EPOCH,
    )

    val noRecordConsent = LocationConsentStatus(
        consentId = uuid("00310"),
        userId = uuid("00311"),
        branchId = uuid("00312"),
        state = LocationConsentState.NO_RECORD,
        mayCollect = false,
    )

    private val threadId = uuid("00400")

    private val workThread = MessengerThread(
        id = threadId,
        kind = MessengerThreadKind.WORK_ORDER,
        branchId = uuid("00302"),
        title = "WO-2026-0001 작업방",
        workOrderId = uuid("00100"),
        lastMessageId = uuid("00500"),
        lastMessageAt = EPOCH.plusMinutes(30),
        memberCount = 3,
        createdAt = EPOCH,
        updatedAt = EPOCH.plusMinutes(30),
    )

    private val message = MessengerMessage(
        id = uuid("00500"),
        threadId = threadId,
        branchId = uuid("00302"),
        senderId = uuid("00301"),
        body = "부품 도착 예정 시간 공유 부탁드립니다.",
        attachmentEvidenceIds = emptyList(),
        sentAt = EPOCH.plusMinutes(30),
        createdAt = EPOCH.plusMinutes(30),
    )

    /** A populated messenger state with a real thread + message, built via the real reducer. */
    fun populatedMessengerState(): MessengerState {
        val reducer = MessengerReducer()
        var state = reducer.reduce(MessengerState(), MessengerAction.ThreadsLoaded(listOf(workThread)))
        state = reducer.reduce(state, MessengerAction.ThreadSelected(threadId))
        return reducer.reduce(
            state,
            MessengerAction.MessagesPageLoaded(
                threadId,
                MessengerMessagePage(items = listOf(message), nextCursor = null),
            ),
        )
    }



    private val mailFolderId = uuid("00600")
    private val mailThreadId = uuid("00601")
    private val calendarEventId = uuid("00602")
    val pollId: UUID = uuid("00603")
    val pollOptionId: UUID = uuid("00604")

    fun operationsDashboard(): MobileOperationsDashboard = MobileOperationsDashboard(
        MobileOperationsSnapshot(
            approvals = ApprovalItemsPage(items = emptyList(), sources = emptyList(), limit = 50, offset = 0, total = 0),
            mailFolders = listOf(
                MailFolderView(
                    id = mailFolderId,
                    role = "INBOX",
                    name = "받은메일함",
                    unreadCount = 2,
                    totalCount = 12,
                ),
            ),
            mailThreads = listOf(
                MailThreadView(
                    id = mailThreadId,
                    subject = "급여명세 확인 요청",
                    lastMessageAt = EPOCH.plusHours(1),
                    messageCount = 3,
                    unreadCount = 2,
                    hasAttachments = true,
                    isFlagged = true,
                ),
            ),
            calendarEvents = listOf(
                CalendarEventResponse(
                    id = calendarEventId,
                    scopeType = CollaborationScopeType.TEAM,
                    title = "정비팀 주간 회의",
                    description = "부품 입고와 긴급 출동 우선순위 조율",
                    startsAt = EPOCH.plusHours(3),
                    endsAt = EPOCH.plusHours(4),
                    allDay = false,
                    status = CalendarEventStatus.ACTIVE,
                    createdAt = EPOCH,
                    updatedAt = EPOCH,
                    policy = CollaborationScopePolicy(
                        enforcement = CollaborationScopePolicy.Enforcement.SERVER,
                        scopeType = CollaborationScopeType.TEAM,
                        visibility = CollaborationScopePolicy.Visibility.TEAM_TARGET,
                    ),
                    objectType = "work_order",
                ),
            ),
            polls = listOf(
                PollResponse(
                    id = pollId,
                    targetScopeType = CollaborationScopeType.ORG,
                    title = "오전 정비 우선순위",
                    question = "긴급 장비를 오전에 먼저 처리할까요?",
                    status = PollStatus.OPEN,
                    anonymity = PollAnonymity.NAMED,
                    allowMultiple = false,
                    options = listOf(
                        PollOptionResponse(
                            id = pollOptionId,
                            label = "찬성",
                            position = 0,
                            voteCount = 0,
                        ),
                    ),
                    voteCount = 0,
                    myVote = PollMyVote(submitted = false, selectedOptionIds = emptyList()),
                    createdAt = EPOCH,
                    updatedAt = EPOCH,
                    policy = CollaborationScopePolicy(
                        enforcement = CollaborationScopePolicy.Enforcement.SERVER,
                        scopeType = CollaborationScopeType.ORG,
                        visibility = CollaborationScopePolicy.Visibility.ORG_MEMBERS,
                    ),
                    objectType = "work_order",
                ),
            ),
            refreshedAt = EPOCH,
        ),
    )

    /** An empty messenger state: no threads, nothing selected. */
    fun emptyMessengerState(): MessengerState = MessengerState()
}
