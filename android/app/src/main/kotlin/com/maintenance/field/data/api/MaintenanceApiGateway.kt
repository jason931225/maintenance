package com.maintenance.field.data.api

import com.maintenance.api.client.api.DefaultApi
import com.maintenance.api.client.model.DevicePlatform
import com.maintenance.api.client.model.DeviceRegistrationRequest
import com.maintenance.api.client.model.DeviceRegistrationResponse
import com.maintenance.api.client.model.EvidenceConfirmResponse
import com.maintenance.api.client.model.EvidencePresignRequest
import com.maintenance.api.client.model.EvidencePresignResponse
import com.maintenance.api.client.model.PasskeyLoginFinishRequest
import com.maintenance.api.client.model.PasskeyLoginStartRequest
import com.maintenance.api.client.model.PasskeyLoginStartResponse
import com.maintenance.api.client.model.SubmitReportRequest
import com.maintenance.api.client.model.SyncBatchRequest
import com.maintenance.api.client.model.SyncBatchResponse
import com.maintenance.api.client.model.TokenPairResponse
import com.maintenance.api.client.model.WorkOrderSummary
import com.maintenance.field.data.offline.SyncGateway
import java.util.UUID
import kotlinx.serialization.json.JsonElement

interface MaintenanceApiGateway : SyncGateway {
    suspend fun listTodayWorkOrders(): List<TechnicianWorkOrder>

    suspend fun getWorkOrder(id: UUID): TechnicianWorkOrder

    suspend fun startWorkOrder(id: UUID): WorkOrderSummary

    suspend fun submitReport(id: UUID, request: SubmitReportRequest): WorkOrderSummary

    suspend fun presignEvidence(request: EvidencePresignRequest): EvidencePresignResponse

    suspend fun confirmEvidence(evidenceId: UUID): EvidenceConfirmResponse

    suspend fun startPasskeyLogin(userId: UUID): PasskeyLoginStartResponse

    suspend fun finishPasskeyLogin(ceremonyId: UUID, credential: Map<String, JsonElement>): TokenPairResponse

    suspend fun registerAndroidDevice(deviceId: String, appVersion: String): DeviceRegistrationResponse
}

class GeneratedMaintenanceApiGateway(
    private val api: DefaultApi,
) : MaintenanceApiGateway {
    override suspend fun listTodayWorkOrders(): List<TechnicianWorkOrder> =
        api.listWorkOrders(assignedTo = "me", limit = 100, offset = 0)
            .items
            .map { it.toTechnicianWorkOrder() }

    override suspend fun getWorkOrder(id: UUID): TechnicianWorkOrder =
        api.getWorkOrderDetail(id).toTechnicianWorkOrder()

    override suspend fun startWorkOrder(id: UUID): WorkOrderSummary =
        api.startWorkOrder(id)

    override suspend fun submitReport(id: UUID, request: SubmitReportRequest): WorkOrderSummary =
        api.submitWorkOrderReport(id, request)

    override suspend fun presignEvidence(request: EvidencePresignRequest): EvidencePresignResponse =
        api.presignEvidenceUpload(request)

    override suspend fun confirmEvidence(evidenceId: UUID): EvidenceConfirmResponse =
        api.confirmEvidenceUpload(evidenceId)

    override suspend fun replay(deviceId: String, request: SyncBatchRequest): SyncBatchResponse =
        api.replayOfflineSyncBatch(deviceId, request)

    override suspend fun startPasskeyLogin(userId: UUID): PasskeyLoginStartResponse =
        api.apiV1AuthPasskeyLoginStartPost(PasskeyLoginStartRequest(userId))

    override suspend fun finishPasskeyLogin(
        ceremonyId: UUID,
        credential: Map<String, JsonElement>,
    ): TokenPairResponse =
        api.apiV1AuthPasskeyLoginFinishPost(PasskeyLoginFinishRequest(ceremonyId, credential))

    override suspend fun registerAndroidDevice(deviceId: String, appVersion: String): DeviceRegistrationResponse =
        api.registerMobileDevice(
            xDeviceId = deviceId,
            deviceRegistrationRequest = DeviceRegistrationRequest(
                platform = DevicePlatform.ANDROID,
                pushToken = null,
                appVersion = appVersion,
            ),
        )
}
