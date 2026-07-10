package com.maintenance.field.data.api

import com.maintenance.api.client.api.DefaultApi
import com.maintenance.api.client.model.DevicePlatform
import com.maintenance.api.client.model.ApprovalItemsPage
import com.maintenance.api.client.model.CalendarEventResponse
import com.maintenance.api.client.model.MailFolderView
import com.maintenance.api.client.model.MailThreadReadStateRequest
import com.maintenance.api.client.model.MailThreadView
import com.maintenance.api.client.model.MobileApproveWorkOrderRequest
import com.maintenance.api.client.model.MobilePasskeyStepUpBinding
import com.maintenance.api.client.model.MobilePasskeyStepUpEnvelope
import com.maintenance.api.client.model.MobilePasskeyStepUpStartRequest
import com.maintenance.api.client.model.MobilePasskeyStepUpStartResponse
import com.maintenance.api.client.model.MobileVotePollRequest
import com.maintenance.api.client.model.PollResponse
import com.maintenance.api.client.model.PollStatus
import com.maintenance.field.data.collaboration.MobileOperationsGateway
import java.time.OffsetDateTime
import com.maintenance.api.client.model.DeviceRegistrationRequest
import com.maintenance.api.client.model.DeviceRegistrationResponse
import com.maintenance.api.client.model.EvidenceConfirmResponse
import com.maintenance.api.client.model.EvidencePresignRequest
import com.maintenance.api.client.model.EvidencePresignResponse
import com.maintenance.api.client.model.MarkMessengerThreadReadRequest
import com.maintenance.api.client.model.MessengerMessagePage
import com.maintenance.api.client.model.MessengerMessageSummary
import com.maintenance.api.client.model.MessengerThreadSummary
import com.maintenance.api.client.model.LocationConsentStatus
import com.maintenance.api.client.model.LocationConsentTransitionRequest
import com.maintenance.api.client.model.LocationPingRequest
import com.maintenance.api.client.model.PasskeyLoginFinishRequest
import com.maintenance.api.client.model.PasskeyLoginStartResponse
import com.maintenance.api.client.model.SendMessengerMessageRequest
import com.maintenance.api.client.model.SubmitReportRequest
import com.maintenance.api.client.model.SyncBatchRequest
import com.maintenance.api.client.model.SyncBatchResponse
import com.maintenance.api.client.model.TokenPairResponse
import com.maintenance.api.client.model.WorkOrderSummary
import com.maintenance.field.data.messenger.MessengerGateway
import com.maintenance.field.data.messenger.MessengerMessage
import com.maintenance.field.data.messenger.MessengerMessagePage as FieldMessengerMessagePage
import com.maintenance.field.data.messenger.MessengerThread
import com.maintenance.field.data.messenger.toMessengerMessage
import com.maintenance.field.data.messenger.toMessengerThread
import com.maintenance.field.data.offline.SyncGateway
import java.util.UUID
import kotlinx.serialization.json.JsonElement

interface MaintenanceApiGateway : SyncGateway, MessengerGateway, MobileOperationsGateway {
    suspend fun listTodayWorkOrders(): List<TechnicianWorkOrder>

    suspend fun getWorkOrder(id: UUID): TechnicianWorkOrder

    suspend fun startWorkOrder(id: UUID): WorkOrderSummary

    suspend fun submitReport(id: UUID, request: SubmitReportRequest): WorkOrderSummary

    suspend fun presignEvidence(request: EvidencePresignRequest): EvidencePresignResponse

    suspend fun confirmEvidence(evidenceId: UUID): EvidenceConfirmResponse

    suspend fun startPasskeyLogin(): PasskeyLoginStartResponse

    suspend fun finishPasskeyLogin(ceremonyId: UUID, credential: Map<String, JsonElement>): TokenPairResponse

    override suspend fun registerAndroidDevice(
        deviceId: String,
        appVersion: String,
        pushToken: String?,
    ): DeviceRegistrationResponse

    override suspend fun startMobilePasskeyStepUp(binding: MobilePasskeyStepUpBinding): MobilePasskeyStepUpStartResponse

    suspend fun getLocationConsentStatus(): LocationConsentStatus

    suspend fun grantLocationConsent(): LocationConsentStatus

    suspend fun suspendLocationConsent(): LocationConsentStatus

    suspend fun resumeLocationConsent(): LocationConsentStatus

    suspend fun withdrawLocationConsent(): LocationConsentStatus

    override suspend fun recordLocationPing(request: LocationPingRequest)
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

    // Usernameless (discoverable) login: POST /api/v1/auth/passkey/login/start takes no
    // body; the user is resolved from the asserted credential at finish.
    override suspend fun startPasskeyLogin(): PasskeyLoginStartResponse =
        api.apiV1AuthPasskeyLoginStartPost()

    override suspend fun finishPasskeyLogin(
        ceremonyId: UUID,
        credential: Map<String, JsonElement>,
    ): TokenPairResponse =
        api.apiV1AuthPasskeyLoginFinishPost(PasskeyLoginFinishRequest(ceremonyId, credential))

    override suspend fun registerAndroidDevice(
        deviceId: String,
        appVersion: String,
        pushToken: String?,
    ): DeviceRegistrationResponse =
        api.registerMobileDevice(
            xDeviceId = deviceId,
            deviceRegistrationRequest = DeviceRegistrationRequest(
                platform = DevicePlatform.ANDROID,
                pushToken = pushToken,
                appVersion = appVersion,
            ),
        )

    override suspend fun listApprovalItems(limit: Long, offset: Long): ApprovalItemsPage =
        api.listApprovalItems(limit = limit, offset = offset)

    override suspend fun startMobilePasskeyStepUp(binding: MobilePasskeyStepUpBinding): MobilePasskeyStepUpStartResponse =
        api.startMobilePasskeyStepUp(
            MobilePasskeyStepUpStartRequest(binding = binding),
        )

    override suspend fun approveWorkOrder(
        workOrderId: UUID,
        comment: String,
        stepUp: MobilePasskeyStepUpEnvelope,
    ) {
        api.approveMobileWorkOrder(
            workOrderId = workOrderId,
            mobileApproveWorkOrderRequest = MobileApproveWorkOrderRequest(
                comment = comment,
                stepUp = stepUp,
            ),
        )
    }

    override suspend fun listMailFolders(): List<MailFolderView> = api.listMailFolders()

    override suspend fun listMailThreads(
        unread: Boolean?,
        query: String?,
        folderId: UUID?,
        before: Long?,
        limit: Long,
    ): List<MailThreadView> = api.listMailThreads(
        unread = unread,
        q = query,
        folder = folderId,
        before = before,
        limit = limit,
    )

    override suspend fun setMailThreadReadState(threadId: UUID, seen: Boolean) {
        api.setMailThreadReadState(
            id = threadId,
            mailThreadReadStateRequest = MailThreadReadStateRequest(seen = seen),
        )
    }

    override suspend fun listCalendarEvents(
        from: OffsetDateTime?,
        to: OffsetDateTime?,
        limit: Long,
    ): List<CalendarEventResponse> = api.listCollaborationCalendarEvents(
        from = from,
        to = to,
        limit = limit,
    ).items

    override suspend fun listPolls(status: PollStatus?, limit: Long): List<PollResponse> =
        api.listCollaborationPolls(status = status, limit = limit).items

    override suspend fun votePoll(
        pollId: UUID,
        selectedOptionIds: List<UUID>,
        stepUp: MobilePasskeyStepUpEnvelope,
    ): PollResponse =
        api.voteMobileCollaborationPoll(
            id = pollId,
            mobileVotePollRequest = MobileVotePollRequest(
                selectedOptionIds = selectedOptionIds,
                stepUp = stepUp,
            ),
        )

    override suspend fun listThreads(limit: Long): List<MessengerThread> =
        api.listMessengerThreads(limit = limit).items.map(MessengerThreadSummary::toMessengerThread)

    override suspend fun listMessages(
        threadId: UUID,
        beforeMessageId: UUID?,
        limit: Long,
    ): FieldMessengerMessagePage {
        val page: MessengerMessagePage = api.listMessengerMessages(
            threadId = threadId,
            beforeMessageId = beforeMessageId,
            limit = limit,
        )
        return FieldMessengerMessagePage(
            items = page.items.map(MessengerMessageSummary::toMessengerMessage),
            nextCursor = page.nextCursor,
        )
    }

    override suspend fun sendMessage(
        threadId: UUID,
        body: String,
        attachmentEvidenceIds: List<UUID>,
    ): MessengerMessage =
        api.sendMessengerMessage(
            threadId = threadId,
            sendMessengerMessageRequest = SendMessengerMessageRequest(
                body = body,
                attachmentEvidenceIds = attachmentEvidenceIds,
            ),
        ).toMessengerMessage()

    override suspend fun markRead(threadId: UUID, lastReadMessageId: UUID) {
        api.markMessengerThreadRead(
            threadId = threadId,
            markMessengerThreadReadRequest = MarkMessengerThreadReadRequest(lastReadMessageId),
        )
    }

    override suspend fun search(query: String, limit: Long): List<MessengerMessage> =
        api.searchMessengerMessages(q = query, limit = limit)
            .items
            .map(MessengerMessageSummary::toMessengerMessage)
    override suspend fun getLocationConsentStatus(): LocationConsentStatus =
        api.getLocationConsentStatus()

    override suspend fun grantLocationConsent(): LocationConsentStatus =
        api.grantLocationConsent(LocationConsentTransitionRequest())

    override suspend fun suspendLocationConsent(): LocationConsentStatus =
        api.suspendLocationConsent(LocationConsentTransitionRequest())

    override suspend fun resumeLocationConsent(): LocationConsentStatus =
        api.resumeLocationConsent(LocationConsentTransitionRequest())

    override suspend fun withdrawLocationConsent(): LocationConsentStatus =
        api.withdrawLocationConsent(LocationConsentTransitionRequest())

    override suspend fun recordLocationPing(request: LocationPingRequest) {
        api.recordLocationPing(request)
    }
}
