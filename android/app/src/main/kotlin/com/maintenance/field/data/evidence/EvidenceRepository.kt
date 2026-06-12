package com.maintenance.field.data.evidence

import com.maintenance.api.client.model.AttachmentStage
import com.maintenance.api.client.model.EvidencePresignRequest
import com.maintenance.field.data.api.MaintenanceApiGateway
import com.maintenance.field.data.local.EvidenceUploadDao
import com.maintenance.field.data.local.PendingEvidenceUpload
import com.maintenance.field.data.local.toEntity
import com.maintenance.field.data.local.toPending
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody

class EvidenceRepository(
    private val api: MaintenanceApiGateway,
    private val uploads: EvidenceUploadDao,
    private val httpClient: OkHttpClient,
) {
    suspend fun queueOrUpload(
        workOrderId: UUID,
        stage: AttachmentStage,
        file: File,
        contentType: String,
    ) {
        val upload = PendingEvidenceUpload(
            localId = UUID.randomUUID().toString(),
            workOrderId = workOrderId,
            stage = stage,
            filePath = file.absolutePath,
            contentType = contentType,
            sizeBytes = file.length(),
            checksumSha256 = file.sha256(),
        )
        uploads.upsert(upload.toEntity())
        uploadPending()
    }

    suspend fun uploadPending() = withContext(Dispatchers.IO) {
        uploads.pending().forEach { entity ->
            val upload = entity.toPending()
            val file = File(upload.filePath)
            try {
                val ticket = api.presignEvidence(
                    EvidencePresignRequest(
                        workOrderId = upload.workOrderId,
                        stage = upload.stage,
                        contentType = upload.contentType,
                        sizeBytes = upload.sizeBytes,
                        checksumSha256 = upload.checksumSha256,
                    ),
                )
                val requestBuilder = Request.Builder()
                    .url(ticket.upload.url.toString())
                    .put(file.asRequestBody(upload.contentType.toMediaType()))
                ticket.upload.headers.forEach { pair ->
                    if (pair.size == 2) {
                        requestBuilder.header(pair[0].jsonPrimitive.content, pair[1].jsonPrimitive.content)
                    }
                }
                val response = httpClient.newCall(requestBuilder.build()).execute()
                response.use {
                    if (!it.isSuccessful) {
                        throw IOException("evidence upload failed: HTTP ${it.code}")
                    }
                }
                api.confirmEvidence(ticket.id)
                uploads.markSynced(upload.localId)
            } catch (_: IOException) {
                uploads.upsert(upload.toEntity())
            } catch (error: Exception) {
                uploads.markFailed(upload.localId, error.message ?: "evidence upload failed")
            }
        }
    }

    private fun File.sha256(): String {
        val digest = MessageDigest.getInstance("SHA-256")
        inputStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString(separator = "") { "%02x".format(it) }
    }
}
