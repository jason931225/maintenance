package com.maintenance.field.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey
import com.maintenance.field.data.messenger.MessengerSendState
import com.maintenance.field.data.messenger.QueuedMessengerMessage
import java.time.OffsetDateTime
import java.util.UUID

@Entity(tableName = "messenger_outbox")
data class MessengerOutboxEntity(
    @PrimaryKey val requestId: String,
    val threadId: String,
    val body: String,
    val attachmentEvidenceIds: String,
    val createdAt: String,
    val state: String,
    val lastError: String?,
)

fun QueuedMessengerMessage.toEntity(): MessengerOutboxEntity =
    MessengerOutboxEntity(
        requestId = requestId,
        threadId = threadId.toString(),
        body = body,
        attachmentEvidenceIds = attachmentEvidenceIds.joinToString("\n"),
        createdAt = createdAt.toString(),
        state = state.name,
        lastError = lastError,
    )

fun MessengerOutboxEntity.toDomain(): QueuedMessengerMessage =
    QueuedMessengerMessage(
        requestId = requestId,
        threadId = UUID.fromString(threadId),
        body = body,
        attachmentEvidenceIds = attachmentEvidenceIds
            .lineSequence()
            .filter { it.isNotBlank() }
            .map(UUID::fromString)
            .toList(),
        createdAt = OffsetDateTime.parse(createdAt),
        state = MessengerSendState.valueOf(state),
        lastError = lastError,
    )
