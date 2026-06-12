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
    @Published var locationConsent: Components.Schemas.LocationConsentStatus?

    private let authRepository: PasskeyAuthRepository
    private let workOrderRepository: WorkOrderRepository
    private let evidenceRepository: EvidenceRepository
    private let locationConsentRepository: LocationConsentRepository

    init(container: FieldAppContainer) {
        self.authRepository = container.authRepository
        self.workOrderRepository = container.workOrderRepository
        self.evidenceRepository = container.evidenceRepository
        self.locationConsentRepository = container.locationConsentRepository
    }

    var isAuthenticated: Bool {
        if case .authenticated = loginState { true } else { false }
    }

    func restore() {
        Task {
            loginState = await authRepository.restore()
            if isAuthenticated {
                await refreshToday()
            } else {
                locationConsent = nil
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
        locationConsent = nil
    }

    func refreshToday() async {
        isLoading = true
        do {
            _ = try await workOrderRepository.replayPending()
            _ = await evidenceRepository.uploadPending()
            today = try await workOrderRepository.refreshToday()
            locationConsent = try await locationConsentRepository.status()
            messageKey = nil
        } catch {
            today = await workOrderRepository.cachedToday()
            messageKey = "error_network"
        }
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
