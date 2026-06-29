package com.maintenance.field.data.messenger

import com.maintenance.api.client.model.MessengerMessageSummary
import com.maintenance.api.client.model.MessengerThreadKind
import com.maintenance.api.client.model.MessengerThreadSummary
import java.io.IOException
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class MessengerRepositoryTest {
    private val branchId = UUID.fromString("11111111-1111-4111-8111-111111111111")
    private val threadId = UUID.fromString("22222222-2222-4222-8222-222222222222")
    private val senderId = UUID.fromString("33333333-3333-4333-8333-333333333333")
    private val firstMessageId = UUID.fromString("44444444-4444-4444-8444-444444444444")
    private val secondMessageId = UUID.fromString("55555555-5555-4555-8555-555555555555")

    @Test
    fun mappersAndReducerMirrorMessengerContract() {
        val reducer = MessengerReducer()
        val initial = MessengerState()
        val thread = generatedThread()
        val first = generatedMessage(firstMessageId, "초기 점검", 10)
        val second = generatedMessage(secondMessageId, "현장 도착", 12)

        val loaded = reducer.reduce(
            initial,
            MessengerAction.MessagesPageLoaded(
                threadId = threadId,
                page = MessengerMessagePage(
                    items = listOf(second.toMessengerMessage(), first.toMessengerMessage()),
                    nextCursor = firstMessageId,
                ),
            ),
        )
        val live = reducer.reduce(
            loaded.copy(threads = listOf(thread.toMessengerThread())),
            MessengerAction.LiveMessageReceived(second.toMessengerMessage()),
        )

        assertEquals("팀 채널", thread.toMessengerThread().displayTitle)
        assertEquals(listOf("초기 점검", "현장 도착"), live.messagesByThread.getValue(threadId).map { it.body })
        assertEquals(secondMessageId, live.lastMessageIdByThread.getValue(threadId))
        assertEquals(secondMessageId, live.resumeCursor())
    }

    @Test
    fun offlineComposedMessagesQueueLocallyAndReplayDirectlyWhenOnline() = runTest {
        val store = InMemoryMessengerOutboxStore()
        val gateway = RecordingMessengerGateway()
        val repository = MessengerRepository(
            gateway = gateway,
            outbox = store,
            requestIdFactory = FixedMessengerRequestIdFactory("chat-request-1"),
            clock = { OffsetDateTime.parse("2026-06-12T09:00:00Z") },
        )

        gateway.failNextSend = IOException("offline")

        val queued = repository.sendOrQueue(threadId, "오프라인 작성", emptyList())

        assertEquals(MessengerSendState.PENDING, queued.state)
        assertEquals("chat-request-1", queued.requestId)
        assertEquals("오프라인 작성", store.pending().single().body)
        assertTrue(gateway.syncReplayRequests.isEmpty())

        gateway.failNextSend = null
        gateway.nextSentMessage = generatedMessage(secondMessageId, "오프라인 작성", 15)

        val summary = repository.replayPending()

        assertEquals(MessengerReplaySummary(attempted = 1, sent = 1, failed = 0), summary)
        assertTrue(store.get("chat-request-1")?.isSynced == true)
        assertEquals(listOf("오프라인 작성", "오프라인 작성"), gateway.sentBodies)
        assertTrue(gateway.syncReplayRequests.isEmpty())
    }

    @Test
    fun realtimeRequestUsesBearerHeaderAndResumeCursor() {
        val request = MessengerRealtimeRequestFactory("https://api.example.com", "access-token")
            .build(lastMessageId = secondMessageId)

        assertEquals("wss://api.example.com/api/v1/ws?last_message_id=$secondMessageId", request.url)
        assertEquals("Bearer access-token", request.headers["Authorization"])
    }

    private fun generatedThread(): MessengerThreadSummary = MessengerThreadSummary(
        id = threadId,
        kind = MessengerThreadKind.TEAM,
        branchId = branchId,
        title = "팀 채널",
        workOrderId = null,
        lastMessageId = null,
        lastMessageAt = null,
        memberCount = 3,
        unreadCount = 0,
        createdAt = OffsetDateTime.parse("2026-06-12T09:00:00Z"),
        updatedAt = OffsetDateTime.parse("2026-06-12T09:00:00Z"),
    )

    private fun generatedMessage(id: UUID, body: String, minute: Int): MessengerMessageSummary =
        MessengerMessageSummary(
            id = id,
            threadId = threadId,
            branchId = branchId,
            senderId = senderId,
            senderName = null,
            body = body,
            attachmentEvidenceIds = emptyList(),
            sentAt = OffsetDateTime.parse("2026-06-12T09:${minute.toString().padStart(2, '0')}:00Z"),
            createdAt = OffsetDateTime.parse("2026-06-12T09:${minute.toString().padStart(2, '0')}:00Z"),
        )
}

private class RecordingMessengerGateway : MessengerGateway {
    var failNextSend: IOException? = null
    var nextSentMessage: MessengerMessageSummary? = null
    val sentBodies = mutableListOf<String>()
    val syncReplayRequests = mutableListOf<String>()

    override suspend fun listThreads(limit: Long): List<MessengerThread> = emptyList()

    override suspend fun listMessages(
        threadId: UUID,
        beforeMessageId: UUID?,
        limit: Long,
    ): MessengerMessagePage = MessengerMessagePage(emptyList(), null)

    override suspend fun sendMessage(
        threadId: UUID,
        body: String,
        attachmentEvidenceIds: List<UUID>,
    ): MessengerMessage {
        sentBodies += body
        failNextSend?.let {
            failNextSend = null
            throw it
        }
        return requireNotNull(nextSentMessage).toMessengerMessage()
    }

    override suspend fun markRead(threadId: UUID, lastReadMessageId: UUID) = Unit

    override suspend fun search(query: String, limit: Long): List<MessengerMessage> = emptyList()
}

private class FixedMessengerRequestIdFactory(private val value: String) : MessengerRequestIdFactory {
    override fun nextId(): String = value
}
