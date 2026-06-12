package com.maintenance.field.data.offline

import com.maintenance.api.client.model.SyncOperationKind
import com.maintenance.api.client.model.SyncOperationRequest
import com.maintenance.api.client.model.SyncOperationRequestPayload
import com.maintenance.api.client.model.WorkResultType
import java.time.OffsetDateTime
import java.util.UUID

data class QueuedMutation(
    val requestId: String,
    val kind: SyncOperationKind,
    val workOrderId: UUID,
    val createdAt: OffsetDateTime,
    val resultType: WorkResultType? = null,
    val diagnosis: String? = null,
    val actionTaken: String? = null,
    val syncState: SyncState = SyncState.PENDING,
    val lastError: String? = null,
    val serverReplayed: Boolean = false,
) {
    val isSynced: Boolean
        get() = syncState == SyncState.SYNCED

    fun toSyncOperation(): SyncOperationRequest = SyncOperationRequest(
        requestId = requestId,
        operation = kind,
        createdAt = createdAt,
        payload = SyncOperationRequestPayload(
            workOrderId = workOrderId,
            resultType = resultType ?: WorkResultType.UNKNOWN,
            diagnosis = diagnosis.orEmpty(),
            actionTaken = actionTaken.orEmpty(),
        ),
    )
}
