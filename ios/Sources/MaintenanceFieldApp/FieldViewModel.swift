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

    init(container: FieldAppContainer) {
        self.authRepository = container.authRepository
        self.workOrderRepository = container.workOrderRepository
        self.evidenceRepository = container.evidenceRepository
        self.messengerRepository = container.messengerRepository
        self.locationConsentRepository = container.locationConsentRepository
        self.mobileOperationsRepository = container.mobileOperationsRepository
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
        case .authenticated:
            await refreshToday()
        case let .signedOut(messageKey):
            self.messageKey = messageKey
        default:
            break
        }
    }

    func logout() async {
        loginState = await authRepository.logout()
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
            _ = await evidenceRepository.uploadPending()
            _ = await messengerRepository.replayPending()
            today = try await workOrderRepository.refreshToday()
            locationConsent = try await locationConsentRepository.status()
            messageKey = nil
        } catch {
            today = await workOrderRepository.cachedToday()
            messageKey = "error_network"
        }
        isLoading = false
    }

    func refreshWorkHub() async {
        isLoading = true
        var failed = false

        do {
            _ = try await workOrderRepository.replayPending()
            _ = await evidenceRepository.uploadPending()
            today = try await workOrderRepository.refreshToday()
            locationConsent = try await locationConsentRepository.status()
        } catch {
            today = await workOrderRepository.cachedToday()
            failed = true
        }

        do {
            _ = await messengerRepository.replayPending()
            let threads = try await messengerRepository.loadThreads()
            messengerState = messengerReducer.reduce(messengerState, .threadsLoaded(threads))
        } catch {
            failed = true
        }

        messageKey = failed ? "error_network" : nil
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
            messageKey = "offline_queued"
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
            messageKey = "offline_queued"
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
            _ = await evidenceRepository.uploadPending()
            messageKey = "capture_saved"
        } catch {
            messageKey = "offline_queued"
        }
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
            _ = mobileOperationsRepository.stepUpEnvelope(
                actionKind: .pollVote,
                objectID: poll.id,
                reasonKey: "operations_passkey_poll_vote"
            )
            _ = try await mobileOperationsRepository.votePoll(pollID: poll.id, selectedOptionIDs: [optionID])
            mobileOperationsOverview = await mobileOperationsRepository.cachedOverview()?.withLiveOrigin()
            mobileSensitiveActionSummary = await mobileOperationsRepository.sensitiveActionQueueSummary()
            messageKey = "operations_poll_voted"
        } catch {
            messageKey = "operation_failed"
        }
        isLoading = false
    }

    func prepareApprovalStepUp() {
        _ = mobileOperationsRepository.stepUpEnvelope(
            actionKind: .approvalDecision,
            objectID: nil,
            reasonKey: "operations_passkey_approval_decision"
        )
        messageKey = "operations_passkey_required"
    }

    func queueFirstApprovalForPasskey() async {
        guard let approval = mobileOperationsDashboard?.approvals.first else {
            messageKey = "operations_approval_empty"
            return
        }
        isLoading = true
        do {
            _ = try await mobileOperationsRepository.approveWorkOrder(
                approval: approval,
                comment: approvalComment,
                stepUpAssertion: nil
            )
            mobileSensitiveActionSummary = await mobileOperationsRepository.sensitiveActionQueueSummary()
            messageKey = approval.canExecuteOnMobile ? "operations_approval_queued_for_passkey" : "operations_approval_unsupported_mobile"
        } catch {
            messageKey = "operation_failed"
        }
        isLoading = false
    }

    func replayMobileSensitiveActions() async {
        isLoading = true
        let summary = await mobileOperationsRepository.replaySensitiveActions(stepUpAssertion: nil)
        mobileSensitiveActionSummary = await mobileOperationsRepository.sensitiveActionQueueSummary()
        messageKey = summary.submitted > 0 ? "operations_sensitive_replayed" : "operations_passkey_required"
        isLoading = false
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
            _ = await messengerRepository.replayPending()
            let threads = try await messengerRepository.loadThreads()
            messengerState = messengerReducer.reduce(messengerState, .threadsLoaded(threads))
            if let selectedThreadID = messengerState.selectedThreadID {
                await loadMessages(threadID: selectedThreadID, beforeMessageID: nil)
            }
            messageKey = nil
        } catch {
            messageKey = "error_network"
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
            messageKey = "messenger_send_pending"
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
