package com.maintenance.field.data.messenger

import java.io.IOException
import java.time.OffsetDateTime
import java.util.UUID

class MessengerRepository(
    private val gateway: MessengerGateway,
    private val outbox: MessengerOutboxStore,
    private val requestIdFactory: MessengerRequestIdFactory = UuidMessengerRequestIdFactory(),
    private val clock: () -> OffsetDateTime = { OffsetDateTime.now() },
) {
    suspend fun loadThreads(limit: Long = 50): List<MessengerThread> =
        gateway.listThreads(limit)

    suspend fun loadMessages(
        threadId: UUID,
        beforeMessageId: UUID? = null,
        limit: Long = 50,
    ): MessengerMessagePage =
        gateway.listMessages(threadId, beforeMessageId, limit)

    suspend fun search(query: String, limit: Long = 50): List<MessengerMessage> =
        gateway.search(query, limit)

    suspend fun markRead(threadId: UUID, lastReadMessageId: UUID) {
        gateway.markRead(threadId, lastReadMessageId)
    }

    suspend fun sendOrQueue(
        threadId: UUID,
        body: String,
        attachmentEvidenceIds: List<UUID>,
    ): MessengerSendResult {
        val trimmedBody = body.trim()
        return try {
            MessengerSendResult(
                requestId = null,
                state = MessengerSendState.SENT,
                message = gateway.sendMessage(threadId, trimmedBody, attachmentEvidenceIds),
            )
        } catch (_: IOException) {
            val requestId = requestIdFactory.nextId()
            outbox.upsert(
                QueuedMessengerMessage(
                    requestId = requestId,
                    threadId = threadId,
                    body = trimmedBody,
                    attachmentEvidenceIds = attachmentEvidenceIds,
                    createdAt = clock(),
                ),
            )
            MessengerSendResult(requestId = requestId, state = MessengerSendState.PENDING)
        }
    }

    suspend fun replayPending(): MessengerReplaySummary {
        val pending = outbox.pending()
        var sent = 0
        var failed = 0

        pending.forEach { message ->
            try {
                gateway.sendMessage(
                    threadId = message.threadId,
                    body = message.body,
                    attachmentEvidenceIds = message.attachmentEvidenceIds,
                )
                outbox.markSent(message.requestId)
                sent += 1
            } catch (_: IOException) {
                failed += 1
            } catch (error: Exception) {
                outbox.markFailed(message.requestId, error.message ?: "messenger send failed")
                failed += 1
            }
        }

        return MessengerReplaySummary(
            attempted = pending.size,
            sent = sent,
            failed = failed,
        )
    }
}
