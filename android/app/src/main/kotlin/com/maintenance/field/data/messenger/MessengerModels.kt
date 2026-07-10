package com.maintenance.field.data.messenger

import com.maintenance.api.client.model.MessengerThreadKind
import java.time.OffsetDateTime
import java.util.UUID

data class MessengerThread(
    val id: UUID,
    val kind: MessengerThreadKind,
    val branchId: UUID,
    val title: String?,
    val workOrderId: UUID?,
    val lastMessageId: UUID?,
    val lastMessageAt: OffsetDateTime?,
    val memberCount: Long,
    val createdAt: OffsetDateTime,
    val updatedAt: OffsetDateTime,
)

data class MessengerMessage(
    val id: UUID,
    val threadId: UUID,
    val branchId: UUID,
    val senderId: UUID,
    val body: String,
    val readCount: Long,
    val readTargetCount: Long,
    val attachmentEvidenceIds: List<UUID>,
    val sentAt: OffsetDateTime,
    val createdAt: OffsetDateTime,
)

data class MessengerMessagePage(
    val items: List<MessengerMessage>,
    val nextCursor: UUID?,
)

data class MessengerState(
    val threads: List<MessengerThread> = emptyList(),
    val selectedThreadId: UUID? = null,
    val messagesByThread: Map<UUID, List<MessengerMessage>> = emptyMap(),
    val nextCursorByThread: Map<UUID, UUID?> = emptyMap(),
    val lastMessageIdByThread: Map<UUID, UUID> = emptyMap(),
    val searchResults: List<MessengerMessage> = emptyList(),
) {
    fun resumeCursor(): UUID? =
        messagesByThread.values.flatten()
            .sortedWith(compareBy<MessengerMessage> { it.sentAt }.thenBy { it.id })
            .lastOrNull()
            ?.id
}

sealed interface MessengerAction {
    data class ThreadsLoaded(val threads: List<MessengerThread>) : MessengerAction
    data class ThreadSelected(val threadId: UUID) : MessengerAction
    data class MessagesPageLoaded(val threadId: UUID, val page: MessengerMessagePage) : MessengerAction
    data class LiveMessageReceived(val message: MessengerMessage) : MessengerAction
    data class MessageSent(val message: MessengerMessage) : MessengerAction
    data class SearchResultsLoaded(val messages: List<MessengerMessage>) : MessengerAction
}

enum class MessengerSendState {
    SENT,
    PENDING,
    FAILED,
}

data class MessengerSendResult(
    val requestId: String?,
    val state: MessengerSendState,
    val message: MessengerMessage? = null,
)

data class QueuedMessengerMessage(
    val requestId: String,
    val threadId: UUID,
    val body: String,
    val attachmentEvidenceIds: List<UUID>,
    val createdAt: OffsetDateTime,
    val state: MessengerSendState = MessengerSendState.PENDING,
    val lastError: String? = null,
) {
    val isSynced: Boolean
        get() = state == MessengerSendState.SENT
}

data class MessengerReplaySummary(
    val attempted: Int,
    val sent: Int,
    val failed: Int,
)

interface MessengerGateway {
    suspend fun listThreads(limit: Long = 50): List<MessengerThread>

    suspend fun listMessages(
        threadId: UUID,
        beforeMessageId: UUID? = null,
        limit: Long = 50,
    ): MessengerMessagePage

    suspend fun sendMessage(
        threadId: UUID,
        body: String,
        attachmentEvidenceIds: List<UUID> = emptyList(),
    ): MessengerMessage

    suspend fun markRead(threadId: UUID, lastReadMessageId: UUID)

    suspend fun search(query: String, limit: Long = 50): List<MessengerMessage>
}

interface MessengerOutboxStore {
    suspend fun upsert(message: QueuedMessengerMessage)

    suspend fun pending(): List<QueuedMessengerMessage>

    suspend fun get(requestId: String): QueuedMessengerMessage?

    suspend fun markSent(requestId: String)

    suspend fun markFailed(requestId: String, message: String)
}

class InMemoryMessengerOutboxStore : MessengerOutboxStore {
    private val messages = linkedMapOf<String, QueuedMessengerMessage>()

    override suspend fun upsert(message: QueuedMessengerMessage) {
        messages[message.requestId] = message
    }

    override suspend fun pending(): List<QueuedMessengerMessage> =
        messages.values.filter { it.state == MessengerSendState.PENDING }

    override suspend fun get(requestId: String): QueuedMessengerMessage? = messages[requestId]

    override suspend fun markSent(requestId: String) {
        messages.computeIfPresent(requestId) { _, message ->
            message.copy(state = MessengerSendState.SENT, lastError = null)
        }
    }

    override suspend fun markFailed(requestId: String, message: String) {
        messages.computeIfPresent(requestId) { _, queued ->
            queued.copy(state = MessengerSendState.FAILED, lastError = message)
        }
    }
}

interface MessengerRequestIdFactory {
    fun nextId(): String
}

class UuidMessengerRequestIdFactory : MessengerRequestIdFactory {
    override fun nextId(): String = UUID.randomUUID().toString()
}
