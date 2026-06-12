import Foundation
import MaintenanceAPIClient

public enum SyncState: String, Codable, Hashable, Sendable {
    case synced
    case pending
    case failed
}

public struct TechnicianWorkOrder: Identifiable, Codable, Hashable, Sendable {
    public var id: Components.Schemas.Uuid
    public var requestNo: String
    public var managementNo: String
    public var modelName: String
    public var customerName: String
    public var siteName: String
    public var priority: Components.Schemas.PriorityLevel
    public var status: Components.Schemas.WorkOrderStatus
    public var resultType: Components.Schemas.WorkResultType
    public var targetDueAt: Date?
    public var createdAt: Date
    public var updatedAt: Date
    public var assigneeNames: [String]
    public var syncState: SyncState
    public var symptom: String?
    public var customerRequest: String?
    public var diagnosis: String?
    public var actionTaken: String?
    public var evidenceVerified: Bool

    public init(
        id: Components.Schemas.Uuid,
        requestNo: String,
        managementNo: String,
        modelName: String,
        customerName: String,
        siteName: String,
        priority: Components.Schemas.PriorityLevel,
        status: Components.Schemas.WorkOrderStatus,
        resultType: Components.Schemas.WorkResultType,
        targetDueAt: Date?,
        createdAt: Date,
        updatedAt: Date,
        assigneeNames: [String],
        syncState: SyncState,
        symptom: String? = nil,
        customerRequest: String? = nil,
        diagnosis: String? = nil,
        actionTaken: String? = nil,
        evidenceVerified: Bool = false
    ) {
        self.id = id
        self.requestNo = requestNo
        self.managementNo = managementNo
        self.modelName = modelName
        self.customerName = customerName
        self.siteName = siteName
        self.priority = priority
        self.status = status
        self.resultType = resultType
        self.targetDueAt = targetDueAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.assigneeNames = assigneeNames
        self.syncState = syncState
        self.symptom = symptom
        self.customerRequest = customerRequest
        self.diagnosis = diagnosis
        self.actionTaken = actionTaken
        self.evidenceVerified = evidenceVerified
    }
}

public extension TechnicianWorkOrder {
    var prioritySort: Int {
        priority.sortOrder
    }
}

public struct ReportDraft: Equatable, Sendable {
    public var resultType: Components.Schemas.WorkResultType
    public var diagnosis: String
    public var actionTaken: String

    public init(resultType: Components.Schemas.WorkResultType, diagnosis: String, actionTaken: String) {
        self.resultType = resultType
        self.diagnosis = diagnosis
        self.actionTaken = actionTaken
    }

    public func toSubmitReportRequest() -> Components.Schemas.SubmitReportRequest {
        Components.Schemas.SubmitReportRequest(
            resultType: resultType,
            diagnosis: diagnosis.trimmedForSubmission,
            actionTaken: actionTaken.trimmedForSubmission
        )
    }
}

public extension String {
    var trimmedForSubmission: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
