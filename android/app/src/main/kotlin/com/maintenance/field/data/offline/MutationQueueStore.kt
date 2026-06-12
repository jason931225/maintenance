package com.maintenance.field.data.offline

interface MutationQueueStore {
    suspend fun upsert(mutation: QueuedMutation)

    suspend fun pending(): List<QueuedMutation>

    suspend fun get(requestId: String): QueuedMutation?

    suspend fun markSynced(requestId: String, serverReplayed: Boolean)

    suspend fun markFailed(requestId: String, message: String)
}
