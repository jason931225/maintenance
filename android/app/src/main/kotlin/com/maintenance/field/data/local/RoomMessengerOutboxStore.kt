package com.maintenance.field.data.local

import com.maintenance.field.data.messenger.MessengerOutboxStore
import com.maintenance.field.data.messenger.QueuedMessengerMessage

class RoomMessengerOutboxStore(private val dao: MessengerOutboxDao) : MessengerOutboxStore {
    override suspend fun upsert(message: QueuedMessengerMessage) {
        dao.upsert(message.toEntity())
    }

    override suspend fun pending(): List<QueuedMessengerMessage> =
        dao.pending().map { it.toDomain() }

    override suspend fun get(requestId: String): QueuedMessengerMessage? =
        dao.get(requestId)?.toDomain()

    override suspend fun markSent(requestId: String) {
        dao.markSent(requestId)
    }

    override suspend fun markFailed(requestId: String, message: String) {
        dao.markFailed(requestId, message)
    }
}
