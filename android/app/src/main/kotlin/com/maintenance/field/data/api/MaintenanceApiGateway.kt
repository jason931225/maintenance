package com.maintenance.field.data.api

import com.maintenance.api.client.api.ApprovalItemsApi
import com.maintenance.api.client.api.AuthApi
import com.maintenance.api.client.api.CollaborationApi
import com.maintenance.api.client.api.DevicesApi
import com.maintenance.api.client.api.EvidenceApi
import com.maintenance.api.client.api.LocationConsentApi
import com.maintenance.api.client.api.LocationPingsApi
import com.maintenance.api.client.api.MailApi
import com.maintenance.api.client.api.MessengerApi
import com.maintenance.api.client.api.SyncApi
import com.maintenance.api.client.api.WorkOrdersApi
import okhttp3.OkHttpClient
import com.maintenance.api.client.model.ApproveWorkOrderRequest
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
    basePath: String,
    httpClient: OkHttpClient,
    accessTokenProvider: () -> String?,
) : MaintenanceApiGateway {
    private val workOrdersApi = WorkOrdersApi(basePath, httpClient).also { it.accessTokenProvider = accessTokenProvider }
    private val evidenceApi = EvidenceApi(basePath, httpClient).also { it.accessTokenProvider = accessTokenProvider }
    private val syncApi = SyncApi(basePath, httpClient).also { it.accessTokenProvider = accessTokenProvider }
    private val authApi = AuthApi(basePath, httpClient).also { it.accessTokenProvider = accessTokenProvider }
    private val devicesApi = DevicesApi(basePath, httpClient).also { it.accessTokenProvider = accessTokenProvider }
    private val approvalItemsApi = ApprovalItemsApi(basePath, httpClient).also { it.accessTokenProvider = accessTokenProvider }
    private val mailApi = MailApi(basePath, httpClient).also { it.accessTokenProvider = accessTokenProvider }
    private val collaborationApi = CollaborationApi(basePath, httpClient).also { it.accessTokenProvider = accessTokenProvider }
    private val messengerApi = MessengerApi(basePath, httpClient).also { it.accessTokenProvider = accessTokenProvider }
    private val locationConsentApi = LocationConsentApi(basePath, httpClient).also { it.accessTokenProvider = accessTokenProvider }
    private val locationPingsApi = LocationPingsApi(basePath, httpClient).also { it.accessTokenProvider = accessTokenProvider }

    override suspend fun listTodayWorkOrders(): List<TechnicianWorkOrder> =
        workOrdersApi.listWorkOrders(assignedTo = "me", limit = 100, offset = 0)
            .items
            .map { it.toTechnicianWorkOrder() }

    override suspend fun getWorkOrder(id: UUID): TechnicianWorkOrder =
        workOrdersApi.getWorkOrderDetail(id).toTechnicianWorkOrder()

    override suspend fun startWorkOrder(id: UUID): WorkOrderSummary =
        workOrdersApi.startWorkOrder(id)

    override suspend fun submitReport(id: UUID, request: SubmitReportRequest): WorkOrderSummary =
        workOrdersApi.submitWorkOrderReport(id, request)

    override suspend fun presignEvidence(request: EvidencePresignRequest): EvidencePresignResponse =
        evidenceApi.presignEvidenceUpload(request)

    override suspend fun confirmEvidence(evidenceId: UUID): EvidenceConfirmResponse =
        evidenceApi.confirmEvidenceUpload(evidenceId)

    override suspend fun replay(deviceId: String, request: SyncBatchRequest): SyncBatchResponse =
        syncApi.replayOfflineSyncBatch(deviceId, request)

    // Usernameless (discoverable) login: POST /api/v1/auth/passkey/login/start takes no
    // body; the user is resolved from the asserted credential at finish.
    override suspend fun startPasskeyLogin(): PasskeyLoginStartResponse =
        authApi.apiV1AuthPasskeyLoginStartPost()

    override suspend fun finishPasskeyLogin(
        ceremonyId: UUID,
        credential: Map<String, JsonElement>,
    ): TokenPairResponse =
        authApi.apiV1AuthPasskeyLoginFinishPost(PasskeyLoginFinishRequest(ceremonyId, credential))

    override suspend fun registerAndroidDevice(
        deviceId: String,
        appVersion: String,
        pushToken: String?,
    ): DeviceRegistrationResponse =
        devicesApi.registerMobileDevice(
            xDeviceId = deviceId,
            deviceRegistrationRequest = DeviceRegistrationRequest(
                platform = DevicePlatform.ANDROID,
                pushToken = pushToken,
                appVersion = appVersion,
            ),
        )

    override suspend fun listApprovalItems(limit: Long, offset: Long): ApprovalItemsPage =
        approvalItemsApi.listApprovalItems(limit = limit, offset = offset)

    override suspend fun startMobilePasskeyStepUp(binding: MobilePasskeyStepUpBinding): MobilePasskeyStepUpStartResponse =
        authApi.startMobilePasskeyStepUp(
            MobilePasskeyStepUpStartRequest(binding = binding),
        )

    override suspend fun approveWorkOrder(
        workOrderId: UUID,
        comment: String,
        stepUp: MobilePasskeyStepUpEnvelope,
    ) {
        workOrdersApi.approveMobileWorkOrder(
            workOrderId = workOrderId,
            mobileApproveWorkOrderRequest = MobileApproveWorkOrderRequest(
                comment = comment,
                stepUp = stepUp,
            ),
        )
    }

    override suspend fun listMailFolders(): List<MailFolderView> = mailApi.listMailFolders()

    override suspend fun listMailThreads(
        unread: Boolean?,
        query: String?,
        folderId: UUID?,
        before: Long?,
        limit: Long,
    ): List<MailThreadView> = mailApi.listMailThreads(
        unread = unread,
        q = query,
        folder = folderId,
        before = before,
        limit = limit,
    )

    override suspend fun setMailThreadReadState(threadId: UUID, seen: Boolean) {
        mailApi.setMailThreadReadState(
            id = threadId,
            mailThreadReadStateRequest = MailThreadReadStateRequest(seen = seen),
        )
    }

    override suspend fun listCalendarEvents(
        from: OffsetDateTime?,
        to: OffsetDateTime?,
        limit: Long,
    ): List<CalendarEventResponse> = collaborationApi.listCollaborationCalendarEvents(
        from = from,
        to = to,
        limit = limit,
    ).items

    override suspend fun listPolls(status: PollStatus?, limit: Long): List<PollResponse> =
        collaborationApi.listCollaborationPolls(status = status, limit = limit).items

    override suspend fun votePoll(
        pollId: UUID,
        selectedOptionIds: List<UUID>,
        stepUp: MobilePasskeyStepUpEnvelope,
    ): PollResponse =
        collaborationApi.voteMobileCollaborationPoll(
            id = pollId,
            mobileVotePollRequest = MobileVotePollRequest(
                selectedOptionIds = selectedOptionIds,
                stepUp = stepUp,
            ),
        )

    override suspend fun listThreads(limit: Long): List<MessengerThread> =
        messengerApi.listMessengerThreads(limit = limit).items.map(MessengerThreadSummary::toMessengerThread)

    override suspend fun listMessages(
        threadId: UUID,
        beforeMessageId: UUID?,
        limit: Long,
    ): FieldMessengerMessagePage {
        val page: MessengerMessagePage = messengerApi.listMessengerMessages(
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
        messengerApi.sendMessengerMessage(
            threadId = threadId,
            sendMessengerMessageRequest = SendMessengerMessageRequest(
                body = body,
                attachmentEvidenceIds = attachmentEvidenceIds,
            ),
        ).toMessengerMessage()

    override suspend fun markRead(threadId: UUID, lastReadMessageId: UUID) {
        messengerApi.markMessengerThreadRead(
            threadId = threadId,
            markMessengerThreadReadRequest = MarkMessengerThreadReadRequest(lastReadMessageId),
        )
    }

    override suspend fun search(query: String, limit: Long): List<MessengerMessage> =
        messengerApi.searchMessengerMessages(q = query, limit = limit)
            .items
            .map(MessengerMessageSummary::toMessengerMessage)
    override suspend fun getLocationConsentStatus(): LocationConsentStatus =
        locationConsentApi.getLocationConsentStatus()

    override suspend fun grantLocationConsent(): LocationConsentStatus =
        locationConsentApi.grantLocationConsent(LocationConsentTransitionRequest())

    override suspend fun suspendLocationConsent(): LocationConsentStatus =
        locationConsentApi.suspendLocationConsent(LocationConsentTransitionRequest())

    override suspend fun resumeLocationConsent(): LocationConsentStatus =
        locationConsentApi.resumeLocationConsent(LocationConsentTransitionRequest())

    override suspend fun withdrawLocationConsent(): LocationConsentStatus =
        locationConsentApi.withdrawLocationConsent(LocationConsentTransitionRequest())

    override suspend fun recordLocationPing(request: LocationPingRequest) {
        locationPingsApi.recordLocationPing(request)
    }
}
