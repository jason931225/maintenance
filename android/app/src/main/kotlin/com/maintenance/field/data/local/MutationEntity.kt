package com.maintenance.field.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey
import com.maintenance.api.client.model.SyncOperationKind
import com.maintenance.api.client.model.WorkResultType
import com.maintenance.field.data.offline.QueuedMutation
import com.maintenance.field.data.offline.SyncState
import java.time.OffsetDateTime
import java.util.UUID

@Entity(tableName = "queued_mutations")
data class MutationEntity(
    @PrimaryKey val requestId: String,
    val kind: String,
    val workOrderId: String,
    val createdAt: String,
    val resultType: String?,
    val diagnosis: String?,
    val actionTaken: String?,
    val syncState: String,
    val lastError: String?,
    val serverReplayed: Boolean,
)

fun QueuedMutation.toEntity(): MutationEntity = MutationEntity(
    requestId = requestId,
    kind = kind.value,
    workOrderId = workOrderId.toString(),
    createdAt = createdAt.toString(),
    resultType = resultType?.value,
    diagnosis = diagnosis,
    actionTaken = actionTaken,
    syncState = syncState.name,
    lastError = lastError,
    serverReplayed = serverReplayed,
)

fun MutationEntity.toDomain(): QueuedMutation = QueuedMutation(
    requestId = requestId,
    kind = requireNotNull(SyncOperationKind.decode(kind)),
    workOrderId = UUID.fromString(workOrderId),
    createdAt = OffsetDateTime.parse(createdAt),
    resultType = resultType?.let { requireNotNull(WorkResultType.decode(it)) },
    diagnosis = diagnosis,
    actionTaken = actionTaken,
    syncState = SyncState.valueOf(syncState),
    lastError = lastError,
    serverReplayed = serverReplayed,
)
