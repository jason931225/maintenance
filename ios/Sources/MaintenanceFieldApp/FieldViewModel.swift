import Foundation
import MaintenanceAPIClient
import MaintenanceFieldCore
import SwiftUI

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

    private let authRepository: PasskeyAuthRepository
    private let workOrderRepository: WorkOrderRepository
    private let evidenceRepository: EvidenceRepository
    private let messengerRepository: MessengerRepository
    private let messengerReducer = MessengerReducer()

    init(container: FieldAppContainer) {
        self.authRepository = container.authRepository
        self.workOrderRepository = container.workOrderRepository
        self.evidenceRepository = container.evidenceRepository
        self.messengerRepository = container.messengerRepository
    }

    var isAuthenticated: Bool {
        if case .authenticated = loginState { true } else { false }
    }

    func restore() {
        Task {
            loginState = await authRepository.restore()
            if isAuthenticated {
                await refreshToday()
            }
        }
    }

    func login() async {
        guard userID.trimmedForSubmission.isEmpty == false else {
            messageKey = "error_required"
            return
        }
        isLoading = true
        loginState = await authRepository.login(userID: userID.trimmedForSubmission)
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
    }

    func refreshToday() async {
        isLoading = true
        do {
            _ = try await workOrderRepository.replayPending()
            _ = await evidenceRepository.uploadPending()
            _ = await messengerRepository.replayPending()
            today = try await workOrderRepository.refreshToday()
            messageKey = nil
        } catch {
            today = await workOrderRepository.cachedToday()
            messageKey = "error_network"
        }
        isLoading = false
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
            messengerState = messengerReducer.reduce(messengerState, .searchResultsLoaded([]))
            return
        }
        do {
            let messages = try await messengerRepository.search(query: query)
            messengerState = messengerReducer.reduce(messengerState, .searchResultsLoaded(messages))
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
}
