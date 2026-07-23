import Foundation
import MaintenanceAPIClient
import MaintenanceFieldCore
import SwiftUI

struct WorkHubSummary: Equatable {
    let todayWorkCount: Int
    let urgentWorkCount: Int
    let approvalRelatedCount: Int
    let pendingSyncCount: Int
    let messengerThreadCount: Int
    let targetDueWorkCount: Int
    let gpsMayCollect: Bool
    let collaborationActions: [MobileCollaborationAction]

    static func build(
        today: [TechnicianWorkOrder],
        messengerState: MessengerState,
        gpsMayCollect: Bool
    ) -> WorkHubSummary {
        let urgentWorkCount = today.filter { $0.priority == .p1 }.count
        let approvalRelatedCount = today.filter {
            $0.status == .reportSubmitted || $0.status == .adminReview
        }.count
        let pendingSyncCount = today.filter { $0.syncState != .synced }.count
        let messengerThreadCount = messengerState.threads.count
        let targetDueWorkCount = today.filter { $0.targetDueAt != nil }.count
        let actionCounts = MobileCollaborationActionCounts(
            urgentWorkCount: urgentWorkCount,
            approvalRelatedCount: approvalRelatedCount,
            pendingSyncCount: pendingSyncCount,
            messengerThreadCount: messengerThreadCount,
            targetDueWorkCount: targetDueWorkCount
        )
        return WorkHubSummary(
            todayWorkCount: today.count,
            urgentWorkCount: urgentWorkCount,
            approvalRelatedCount: approvalRelatedCount,
            pendingSyncCount: pendingSyncCount,
            messengerThreadCount: messengerThreadCount,
            targetDueWorkCount: targetDueWorkCount,
            gpsMayCollect: gpsMayCollect,
            collaborationActions: MobileCollaborationActionBuilder.build(counts: actionCounts)
        )
    }
}

@MainActor
final class FieldViewModel: ObservableObject {
    @Published var loginState: LoginState = .signedOut()
    @Published var userID = ""
    @Published var today: [TechnicianWorkOrder] = []
    @Published var selectedWorkOrder: TechnicianWorkOrder?
    @Published var resultType: Components.Schemas.WorkResultType = .completed
    @Published var diagnosis = ""
    @Published var actionTaken = ""
    @Published var messageKey: String?
    @Published var isLoading = false
    @Published var isCameraPresented = false
    @Published var messengerState = MessengerState()
    @Published var messengerDraft = ""
    @Published var messengerSearchQuery = ""
    @Published var messengerHasSearched = false
    @Published var locationConsent: Components.Schemas.LocationConsentStatus?
    @Published var mobileOperationsOverview: MobileOperationsOverview?
    @Published var approvalComment = ""
    @Published var mobileNotificationInbox = MobileNotificationInbox(notifications: [])
    @Published var mobileSensitiveActionSummary = MobileSensitiveActionQueueSummary(actions: [])

    var workHubSummary: WorkHubSummary {
        WorkHubSummary.build(
            today: today,
            messengerState: messengerState,
            gpsMayCollect: locationConsent?.mayCollect == true
        )
    }

    private let authRepository: PasskeyAuthRepository
    private let workOrderRepository: WorkOrderRepository
    private let evidenceRepository: EvidenceRepository
    private let messengerRepository: MessengerRepository
    private let messengerReducer = MessengerReducer()
    private let locationConsentRepository: LocationConsentRepository
    private let mobileOperationsRepository: MobileOperationsRepository
    private let passkeyStepUpRepository: PasskeyStepUpRepository

    init(container: FieldAppContainer) {
        self.authRepository = container.authRepository
        self.workOrderRepository = container.workOrderRepository
        self.evidenceRepository = container.evidenceRepository
        self.messengerRepository = container.messengerRepository
        self.locationConsentRepository = container.locationConsentRepository
        self.mobileOperationsRepository = container.mobileOperationsRepository
        self.passkeyStepUpRepository = container.passkeyStepUpRepository
    }

    var mobileOperationsDashboard: MobileOperationsDashboard? {
        mobileOperationsOverview.map { MobileOperationsDashboard(snapshot: $0.snapshot) }
    }

    var isAuthenticated: Bool {
        if case .authenticated = loginState { true } else { false }
    }

    var currentUserID: Components.Schemas.Uuid? {
        let trimmed = userID.trimmedForSubmission
        guard UUID(uuidString: trimmed) != nil else { return nil }
        return trimmed
    }

    func restore() {
        Task {
            loginState = await authRepository.restore()
            if isAuthenticated {
                await refreshToday()
            } else {
                locationConsent = nil
                mobileOperationsOverview = nil
                approvalComment = ""
                mobileNotificationInbox = MobileNotificationInbox(notifications: [])
                mobileSensitiveActionSummary = MobileSensitiveActionQueueSummary(actions: [])
            }
        }
    }

    func login() async {
        let trimmedUserID = userID.trimmedForSubmission
        guard trimmedUserID.isEmpty == false else {
            messageKey = "error_required"
            return
        }
        guard UUID(uuidString: trimmedUserID) != nil else {
            messageKey = "error_invalid_user_id"
            return
        }
        isLoading = true
        loginState = await authRepository.login(userID: trimmedUserID)
        isLoading = false
        switch loginState {
        case let .authenticated(_, _, deviceRegistration, authenticationMessageKey):
            await refreshToday()
            if let authenticationMessageKey {
                messageKey = authenticationMessageKey
            } else if case let .retryPending(retry) = deviceRegistration {
                messageKey = retry.messageKey
            }
        case let .signedOut(messageKey):
            self.messageKey = messageKey
        default:
            break
        }
    }

    func logout() async {
        do {
            loginState = try await authRepository.logout()
        } catch {
            messageKey = "operation_failed"
            return
        }
        today = []
        selectedWorkOrder = nil
        locationConsent = nil
        mobileOperationsOverview = nil
        approvalComment = ""
        mobileNotificationInbox = MobileNotificationInbox(notifications: [])
        mobileSensitiveActionSummary = MobileSensitiveActionQueueSummary(actions: [])
    }

    func refreshToday() async {
        isLoading = true
        do {
            _ = try await workOrderRepository.replayPending()
            _ = try await evidenceRepository.uploadPending()
            _ = try await messengerRepository.replayPending()
            today = try await workOrderRepository.refreshToday()
            locationConsent = try await locationConsentRepository.status()
            messageKey = nil
        } catch {
            today = await workOrderRepository.cachedToday()
            messageKey = failureMessageKey(for: error, fallback: "error_network")
        }
        isLoading = false
    }

    func refreshWorkHub() async {
        isLoading = true
        var failedMessageKey: String?

        do {
            _ = try await workOrderRepository.replayPending()
            _ = try await evidenceRepository.uploadPending()
            today = try await workOrderRepository.refreshToday()
            locationConsent = try await locationConsentRepository.status()
        } catch {
            today = await workOrderRepository.cachedToday()
            failedMessageKey = failureMessageKey(for: error, fallback: "error_network")
        }

        do {
            _ = try await messengerRepository.replayPending()
            let threads = try await messengerRepository.loadThreads()
            messengerState = messengerReducer.reduce(messengerState, .threadsLoaded(threads))
        } catch {
            let messengerFailureKey = failureMessageKey(for: error, fallback: "error_network")
            failedMessageKey = failedMessageKey == "offline_persistence_failed" ? failedMessageKey : messengerFailureKey
        }

        messageKey = failedMessageKey
        isLoading = false
    }

    func grantLocationConsent() async {
        await updateLocationConsent { try await locationConsentRepository.grant() }
    }

    func suspendLocationConsent() async {
        await updateLocationConsent { try await locationConsentRepository.suspend() }
    }

    func resumeLocationConsent() async {
        await updateLocationConsent { try await locationConsentRepository.resume() }
    }

    func withdrawLocationConsent() async {
        await updateLocationConsent { try await locationConsentRepository.withdraw() }
    }

    func select(_ workOrder: TechnicianWorkOrder) {
        selectedWorkOrder = workOrder
        resultType = workOrder.resultType == .unknown ? .completed : workOrder.resultType
        diagnosis = workOrder.diagnosis ?? ""
        actionTaken = workOrder.actionTaken ?? ""
        Task {
            do {
                selectedWorkOrder = try await workOrderRepository.detail(id: workOrder.id)
            } catch {
                messageKey = "error_network"
            }
        }
    }

    func closeDetail() {
        selectedWorkOrder = nil
    }

    func startSelectedWork() async {
        guard let selectedWorkOrder else { return }
        isLoading = true
        do {
            let syncState = try await workOrderRepository.start(id: selectedWorkOrder.id)
            self.selectedWorkOrder = try await workOrderRepository.detail(id: selectedWorkOrder.id)
            today = await workOrderRepository.cachedToday()
            messageKey = syncState == .pending ? "offline_queued" : nil
        } catch {
            messageKey = failureMessageKey(for: error, fallback: "operation_failed")
        }
        isLoading = false
    }

    func submitReport() async {
        guard let selectedWorkOrder else { return }
        guard diagnosis.trimmedForSubmission.isEmpty == false,
              actionTaken.trimmedForSubmission.isEmpty == false else {
            messageKey = "error_required"
            return
        }

        isLoading = true
        do {
            let draft = ReportDraft(resultType: resultType, diagnosis: diagnosis, actionTaken: actionTaken)
            let syncState = try await workOrderRepository.submitReport(id: selectedWorkOrder.id, draft: draft)
            self.selectedWorkOrder = try await workOrderRepository.detail(id: selectedWorkOrder.id)
            today = await workOrderRepository.cachedToday()
            messageKey = syncState == .pending ? "offline_queued" : "report_submitted"
        } catch {
            messageKey = failureMessageKey(for: error, fallback: "operation_failed")
        }
        isLoading = false
    }

    func cameraCaptureFailed() {
        messageKey = "operation_failed"
    }

    func evidenceCaptured(fileURL: URL) async {
        guard let selectedWorkOrder else { return }
        do {
            _ = try await evidenceRepository.stageEvidence(workOrderID: selectedWorkOrder.id, fileURL: fileURL)
            let evidenceSummary = try await evidenceRepository.uploadPending()
            messageKey = evidenceUploadMessageKey(for: evidenceSummary) ?? "capture_saved"
        } catch {
            messageKey = failureMessageKey(for: error, fallback: "offline_queued")
        }
    }

    private func evidenceUploadMessageKey(for summary: EvidenceUploadSummary) -> String? {
        if summary.failed > 0 {
            return "evidence_upload_failed"
        }
        if summary.retrying > 0 {
            return "evidence_upload_retrying"
        }
        return nil
    }

    private func failureMessageKey(for error: Error, fallback: String) -> String {
        if error is PersistenceStoreError {
            return "offline_persistence_failed"
        }
        return fallback
    }



    func refreshMobileOperations() async {
        isLoading = true
        do {
            mobileOperationsOverview = try await mobileOperationsRepository.refreshOverview()
            mobileNotificationInbox = await mobileOperationsRepository.notificationInbox()
            mobileSensitiveActionSummary = await mobileOperationsRepository.sensitiveActionQueueSummary()
            messageKey = nil
        } catch {
            mobileOperationsOverview = await mobileOperationsRepository.cachedOverview()
            mobileNotificationInbox = await mobileOperationsRepository.notificationInbox()
            mobileSensitiveActionSummary = await mobileOperationsRepository.sensitiveActionQueueSummary()
            messageKey = mobileOperationsOverview == nil ? "error_network" : "operations_cached_fallback"
        }
        isLoading = false
    }

    func markMailThreadRead(_ thread: MobileMailThreadRow) async {
        isLoading = true
        do {
            mobileOperationsOverview = try await mobileOperationsRepository.markMailThreadSeen(threadID: thread.id, seen: true)
                ?? mobileOperationsOverview
            mobileSensitiveActionSummary = await mobileOperationsRepository.sensitiveActionQueueSummary()
            messageKey = nil
        } catch {
            messageKey = "operation_failed"
        }
        isLoading = false
    }

    func votePoll(_ poll: MobilePollRow) async {
        guard poll.canVote, let optionID = poll.firstOptionID else { return }
        isLoading = true
        do {
            let stepUp = try? await requestStepUpEnvelope(
                actionKind: .pollVote,
                objectID: poll.id
            )
            let queued = try await mobileOperationsRepository.votePoll(
                pollID: poll.id,
                selectedOptionIDs: [optionID],
                stepUp: stepUp
            )
            mobileOperationsOverview = await mobileOperationsRepository.cachedOverview()?.withLiveOrigin()
            mobileSensitiveActionSummary = await mobileOperationsRepository.sensitiveActionQueueSummary()
            messageKey = queued == nil ? "operations_poll_voted" : "operations_passkey_required"
        } catch {
            messageKey = "operation_failed"
        }
        isLoading = false
    }

    func prepareApprovalStepUp() {
        messageKey = "operations_passkey_required"
    }

    func queueFirstApprovalForPasskey() async {
        guard let approval = mobileOperationsDashboard?.approvals.first else {
            messageKey = "operations_approval_empty"
            return
        }
        isLoading = true
        do {
            let stepUp = try? await requestStepUpEnvelope(
                actionKind: .approvalDecision,
                objectID: approval.sourceID
            )
            let queued = try await mobileOperationsRepository.approveWorkOrder(
                approval: approval,
                comment: approvalComment,
                stepUp: stepUp
            )
            mobileSensitiveActionSummary = await mobileOperationsRepository.sensitiveActionQueueSummary()
            messageKey = approval.canExecuteOnMobile
                ? (queued == nil ? "operations_approval_submitted" : "operations_approval_queued_for_passkey")
                : "operations_approval_unsupported_mobile"
        } catch {
            messageKey = "operation_failed"
        }
        isLoading = false
    }

    func replayMobileSensitiveActions() async {
        isLoading = true
        let summary = await mobileOperationsRepository.replaySensitiveActions { [passkeyStepUpRepository] _, binding in
            try await passkeyStepUpRepository.envelope(binding: binding)
        }
        mobileSensitiveActionSummary = await mobileOperationsRepository.sensitiveActionQueueSummary()
        messageKey = summary.submitted > 0 ? "operations_sensitive_replayed" : "operations_passkey_required"
        isLoading = false
    }

    private func requestStepUpEnvelope(
        actionKind: MobileSensitiveActionKind,
        objectID: Components.Schemas.Uuid,
        replayAttempt: Int32? = nil
    ) async throws -> Components.Schemas.MobilePasskeyStepUpEnvelope {
        let binding = try mobileOperationsRepository.stepUpBinding(
            actionKind: actionKind,
            objectID: objectID,
            replayAttempt: replayAttempt
        )
        let expectedReasonKey: String
        switch actionKind {
        case .approvalDecision:
            expectedReasonKey = "operations_passkey_approval_decision"
        case .pollVote:
            expectedReasonKey = "operations_passkey_poll_vote"
        case .mailSend, .workflowStepUp, .deviceRegistration, .onDutyPing:
            throw MaintenanceGatewayError.unexpectedResponse("unsupported mobile passkey step-up action: \(actionKind.rawValue)")
        }
        guard binding.reasonKey.rawValue == expectedReasonKey else {
            throw MaintenanceGatewayError.unexpectedResponse("mobile passkey step-up reason mismatch")
        }
        return try await passkeyStepUpRepository.envelope(binding: binding)
    }

    func registerPushToken(_ token: String, deviceID: String, appVersion: String) async {
        isLoading = true
        let queued = await mobileOperationsRepository.registerOrQueuePushDevice(
            deviceID: deviceID,
            appVersion: appVersion,
            pushToken: token
        )
        mobileSensitiveActionSummary = await mobileOperationsRepository.sensitiveActionQueueSummary()
        messageKey = queued == nil ? "operations_push_registered" : "operations_push_queued"
        isLoading = false
    }

    func ingestPushNotification(_ payload: MobilePushNotificationPayload) async {
        _ = await mobileOperationsRepository.ingestPushNotification(payload)
        mobileNotificationInbox = await mobileOperationsRepository.notificationInbox()
        messageKey = payload.isUrgent ? "operations_urgent_notification" : nil
    }

    func markNotificationRead(_ notification: MobileRoutedNotification) async {
        mobileNotificationInbox = await mobileOperationsRepository.markNotificationRead(id: notification.id)
    }

    func recordOnDutyPing(
        onDuty: Bool,
        latitude: Double,
        longitude: Double,
        accuracyM: Double?
    ) async {
        let state = GPSCollectionState(
            consentState: locationConsent?.state ?? .noRecord,
            onDuty: onDuty
        )
        let queued = await mobileOperationsRepository.recordOnDutyPing(
            state: state,
            latitude: latitude,
            longitude: longitude,
            accuracyM: accuracyM,
            recordedAt: Date()
        )
        mobileSensitiveActionSummary = await mobileOperationsRepository.sensitiveActionQueueSummary()
        messageKey = queued == nil ? "operations_on_duty_recorded" : "operations_on_duty_queued"
    }

    func refreshMessenger() async {
        isLoading = true
        do {
            _ = try await messengerRepository.replayPending()
            let threads = try await messengerRepository.loadThreads()
            messengerState = messengerReducer.reduce(messengerState, .threadsLoaded(threads))
            if let selectedThreadID = messengerState.selectedThreadID {
                await loadMessages(threadID: selectedThreadID, beforeMessageID: nil)
            }
            messageKey = nil
        } catch {
            messageKey = failureMessageKey(for: error, fallback: "error_network")
        }
        isLoading = false
    }

    func selectMessengerThread(_ thread: MessengerThread) async {
        messengerState = messengerReducer.reduce(messengerState, .threadSelected(thread.id))
        await loadMessages(threadID: thread.id, beforeMessageID: nil)
    }

    func loadOlderMessengerMessages() async {
        guard let threadID = messengerState.selectedThreadID else { return }
        let before = messengerState.nextCursorByThread[threadID] ?? nil
        await loadMessages(threadID: threadID, beforeMessageID: before)
    }

    func searchMessengerMessages() async {
        let query = messengerSearchQuery.trimmedForSubmission
        guard query.isEmpty == false else {
            messengerHasSearched = false
            messengerState = messengerReducer.reduce(messengerState, .searchResultsLoaded([]))
            return
        }
        do {
            let messages = try await messengerRepository.search(query: query)
            messengerState = messengerReducer.reduce(messengerState, .searchResultsLoaded(messages))
            messengerHasSearched = true
            messageKey = nil
        } catch {
            messageKey = "error_network"
        }
    }

    func sendMessengerMessage() async {
        guard let threadID = messengerState.selectedThreadID else { return }
        let body = messengerDraft.trimmedForSubmission
        guard body.isEmpty == false else {
            messageKey = "error_required"
            return
        }

        do {
            let result = try await messengerRepository.sendOrQueue(
                threadID: threadID,
                body: body,
                attachmentEvidenceIDs: []
            )
            messengerDraft = ""
            if let message = result.message {
                messengerState = messengerReducer.reduce(messengerState, .messageSent(message))
                try? await messengerRepository.markRead(threadID: threadID, lastReadMessageID: message.id)
            }
            messageKey = result.state == .pending ? "messenger_send_pending" : nil
        } catch {
            messageKey = failureMessageKey(for: error, fallback: "messenger_send_pending")
        }
    }

    private func loadMessages(
        threadID: Components.Schemas.Uuid,
        beforeMessageID: Components.Schemas.Uuid?
    ) async {
        do {
            let page = try await messengerRepository.loadMessages(
                threadID: threadID,
                beforeMessageID: beforeMessageID
            )
            messengerState = messengerReducer.reduce(
                messengerState,
                .messagesPageLoaded(threadID: threadID, page: page)
            )
            if let lastMessageID = messengerState.messagesByThread[threadID]?.last?.id {
                try? await messengerRepository.markRead(threadID: threadID, lastReadMessageID: lastMessageID)
            }
            messageKey = nil
        } catch {
            messageKey = "error_network"
        }
    }
    private func updateLocationConsent(
        _ operation: () async throws -> Components.Schemas.LocationConsentStatus
    ) async {
        isLoading = true
        do {
            locationConsent = try await operation()
            messageKey = nil
        } catch {
            messageKey = "location_consent_failed"
        }
        isLoading = false
    }
}


private extension MobileOperationsOverview {
    func withLiveOrigin() -> MobileOperationsOverview {
        MobileOperationsOverview(snapshot: snapshot, origin: .live)
    }
}
