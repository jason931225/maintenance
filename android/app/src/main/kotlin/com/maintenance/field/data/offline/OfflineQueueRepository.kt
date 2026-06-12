package com.maintenance.field.data.offline

import com.maintenance.api.client.model.SyncBatchRequest
import com.maintenance.api.client.model.SyncOperationKind
import com.maintenance.api.client.model.SyncOperationStatus
import com.maintenance.api.client.model.WorkResultType
import java.util.UUID

data class ReplaySummary(
    val attempted: Int,
    val applied: Int,
    val failed: Int,
    val cached: Int,
)

class OfflineQueueRepository(
    private val store: MutationQueueStore,
    private val syncGateway: SyncGateway,
    private val deviceIdProvider: () -> String,
    private val requestIdFactory: RequestIdFactory = UlidRequestIdFactory(),
    private val syncIdFactory: RequestIdFactory = UlidRequestIdFactory(),
    private val clock: FieldClock = SystemFieldClock,
) {
    suspend fun enqueueStart(workOrderId: UUID): String {
        val requestId = requestIdFactory.nextId()
        store.upsert(
            QueuedMutation(
                requestId = requestId,
                kind = SyncOperationKind.WORK_ORDER_START,
                workOrderId = workOrderId,
                createdAt = clock.now(),
            ),
        )
        return requestId
    }

    suspend fun enqueueReport(
        workOrderId: UUID,
        resultType: WorkResultType,
        diagnosis: String,
        actionTaken: String,
    ): String {
        val requestId = requestIdFactory.nextId()
        store.upsert(
            QueuedMutation(
                requestId = requestId,
                kind = SyncOperationKind.WORK_ORDER_REPORT,
                workOrderId = workOrderId,
                createdAt = clock.now(),
                resultType = resultType,
                diagnosis = diagnosis,
                actionTaken = actionTaken,
            ),
        )
        return requestId
    }

    suspend fun replayPending(): ReplaySummary {
        val pending = store.pending()
        if (pending.isEmpty()) {
            return ReplaySummary(attempted = 0, applied = 0, failed = 0, cached = 0)
        }
        val response = try {
            syncGateway.replay(
                deviceId = deviceIdProvider(),
                request = SyncBatchRequest(
                    syncId = syncIdFactory.nextId(),
                    operations = pending.map { it.toSyncOperation() },
                ),
            )
        } catch (_: Exception) {
            return ReplaySummary(
                attempted = pending.size,
                applied = 0,
                failed = pending.size,
                cached = 0,
            )
        }

        var applied = 0
        var failed = 0
        var cached = 0
        response.results.forEach { result ->
            when (result.status) {
                SyncOperationStatus.APPLIED -> {
                    applied += 1
                    if (result.replayed) cached += 1
                    store.markSynced(result.requestId, serverReplayed = result.replayed)
                }
                SyncOperationStatus.FAILED -> {
                    failed += 1
                    val message = result.error?.message ?: "sync failed with HTTP ${result.httpStatus}"
                    store.markFailed(result.requestId, message)
                }
            }
        }
        return ReplaySummary(
            attempted = pending.size,
            applied = applied,
            failed = failed,
            cached = cached,
        )
    }
}
