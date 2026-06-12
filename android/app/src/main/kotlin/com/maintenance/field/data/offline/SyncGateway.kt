package com.maintenance.field.data.offline

import com.maintenance.api.client.model.SyncBatchRequest
import com.maintenance.api.client.model.SyncBatchResponse

fun interface SyncGateway {
    suspend fun replay(deviceId: String, request: SyncBatchRequest): SyncBatchResponse
}
