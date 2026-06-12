package com.maintenance.field.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey
import com.maintenance.api.client.model.AttachmentStage
import java.util.UUID

@Entity(tableName = "evidence_uploads")
data class EvidenceUploadEntity(
    @PrimaryKey val localId: String,
    val workOrderId: String,
    val stage: String,
    val filePath: String,
    val contentType: String,
    val sizeBytes: Long,
    val checksumSha256: String?,
    val syncState: String,
    val lastError: String?,
)

data class PendingEvidenceUpload(
    val localId: String,
    val workOrderId: UUID,
    val stage: AttachmentStage,
    val filePath: String,
    val contentType: String,
    val sizeBytes: Long,
    val checksumSha256: String?,
)

fun PendingEvidenceUpload.toEntity(syncState: String = "PENDING", lastError: String? = null): EvidenceUploadEntity =
    EvidenceUploadEntity(
        localId = localId,
        workOrderId = workOrderId.toString(),
        stage = stage.value,
        filePath = filePath,
        contentType = contentType,
        sizeBytes = sizeBytes,
        checksumSha256 = checksumSha256,
        syncState = syncState,
        lastError = lastError,
    )

fun EvidenceUploadEntity.toPending(): PendingEvidenceUpload = PendingEvidenceUpload(
    localId = localId,
    workOrderId = UUID.fromString(workOrderId),
    stage = requireNotNull(AttachmentStage.decode(stage)),
    filePath = filePath,
    contentType = contentType,
    sizeBytes = sizeBytes,
    checksumSha256 = checksumSha256,
)
