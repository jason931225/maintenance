package com.maintenance.field.data.offline

import com.maintenance.api.client.model.SyncBatchRequest
import com.maintenance.api.client.model.SyncBatchResponse
import java.time.OffsetDateTime

class InMemoryMutationStore : MutationQueueStore {
    private val mutations = linkedMapOf<String, QueuedMutation>()

    override suspend fun upsert(mutation: QueuedMutation) {
        mutations[mutation.requestId] = mutation
    }

    override suspend fun pending(): List<QueuedMutation> =
        mutations.values.filter { it.syncState == SyncState.PENDING }

    override suspend fun get(requestId: String): QueuedMutation? = mutations[requestId]

    override suspend fun markSynced(requestId: String, serverReplayed: Boolean) {
        mutations.computeIfPresent(requestId) { _, mutation ->
            mutation.copy(syncState = SyncState.SYNCED, lastError = null, serverReplayed = serverReplayed)
        }
    }

    override suspend fun markFailed(requestId: String, message: String) {
        mutations.computeIfPresent(requestId) { _, mutation ->
            mutation.copy(syncState = SyncState.FAILED, lastError = message)
        }
    }
}

class RecordingSyncGateway : SyncGateway {
    val requests = mutableListOf<SyncBatchRequest>()
    val deviceIds = mutableListOf<String>()
    var failNext: Exception? = null
    var nextResponse: SyncBatchResponse? = null

    override suspend fun replay(deviceId: String, request: SyncBatchRequest): SyncBatchResponse {
        deviceIds += deviceId
        requests += request
        failNext?.let {
            failNext = null
            throw it
        }
        return requireNotNull(nextResponse) { "nextResponse must be set" }
    }
}

class FixedRequestIdFactory(private val value: String) : RequestIdFactory {
    override fun nextId(): String = value
}

class FixedClock(private val value: OffsetDateTime) : FieldClock {
    override fun now(): OffsetDateTime = value
}
