import Foundation
import MaintenanceAPIClient

public enum SyncState: String, Codable, Hashable, Sendable {
    case synced
    case pending
    case failed
}

public enum MobileCollaborationKind: String, Codable, CaseIterable, Hashable, Sendable {
    case notification
    case approval
    case passkeySigning
    case offlineSync
    case messenger
    case mail
    case calendar
    case poll
}

public enum MobileCollaborationStatus: String, Codable, Hashable, Sendable {
    case actionRequired
    case ready
    case monitoring
}

public struct MobileCollaborationAction: Codable, Hashable, Identifiable, Sendable {
    public var id: MobileCollaborationKind { kind }

    public let kind: MobileCollaborationKind
    public let titleKey: String
    public let valueKey: String
    public let detailKey: String
    public let count: Int?
    public let status: MobileCollaborationStatus
    public let requiresPasskey: Bool

    public init(
        kind: MobileCollaborationKind,
        titleKey: String,
        valueKey: String,
        detailKey: String,
        count: Int?,
        status: MobileCollaborationStatus,
        requiresPasskey: Bool = false
    ) {
        self.kind = kind
        self.titleKey = titleKey
        self.valueKey = valueKey
        self.detailKey = detailKey
        self.count = count
        self.status = status
        self.requiresPasskey = requiresPasskey
    }
}

public struct MobileCollaborationActionCounts: Equatable, Sendable {
    public let urgentWorkCount: Int
    public let approvalRelatedCount: Int
    public let pendingSyncCount: Int
    public let messengerThreadCount: Int
    public let targetDueWorkCount: Int

    public init(
        urgentWorkCount: Int,
        approvalRelatedCount: Int,
        pendingSyncCount: Int,
        messengerThreadCount: Int,
        targetDueWorkCount: Int
    ) {
        self.urgentWorkCount = urgentWorkCount
        self.approvalRelatedCount = approvalRelatedCount
        self.pendingSyncCount = pendingSyncCount
        self.messengerThreadCount = messengerThreadCount
        self.targetDueWorkCount = targetDueWorkCount
    }

    public var notificationCount: Int {
        urgentWorkCount + approvalRelatedCount + pendingSyncCount
    }
}

public enum MobileCollaborationActionBuilder {
    public static func build(counts: MobileCollaborationActionCounts) -> [MobileCollaborationAction] {
        [
            MobileCollaborationAction(
                kind: .notification,
                titleKey: "work_hub_action_notifications_title",
                valueKey: "work_hub_action_notifications_value_format",
                detailKey: "work_hub_action_notifications_detail",
                count: counts.notificationCount,
                status: counts.notificationCount > 0 ? .actionRequired : .monitoring
            ),
            MobileCollaborationAction(
                kind: .approval,
                titleKey: "work_hub_action_approvals_title",
                valueKey: "work_hub_action_approvals_value_format",
                detailKey: "work_hub_action_approvals_detail",
                count: counts.approvalRelatedCount,
                status: counts.approvalRelatedCount > 0 ? .actionRequired : .monitoring,
                requiresPasskey: counts.approvalRelatedCount > 0
            ),
            MobileCollaborationAction(
                kind: .passkeySigning,
                titleKey: "work_hub_action_passkey_title",
                valueKey: (counts.approvalRelatedCount > 0
                    ? "work_hub_action_passkey_value_required"
                    : "work_hub_action_passkey_value_ready"),
                detailKey: "work_hub_action_passkey_detail",
                count: nil,
                status: counts.approvalRelatedCount > 0 ? .actionRequired : .ready,
                requiresPasskey: true
            ),
            MobileCollaborationAction(
                kind: .offlineSync,
                titleKey: "work_hub_action_offline_title",
                valueKey: "work_hub_action_offline_value_format",
                detailKey: "work_hub_action_offline_detail",
                count: counts.pendingSyncCount,
                status: counts.pendingSyncCount > 0 ? .actionRequired : .ready
            ),
            MobileCollaborationAction(
                kind: .messenger,
                titleKey: "work_hub_action_messenger_title",
                valueKey: "work_hub_action_messenger_value_format",
                detailKey: "work_hub_action_messenger_detail",
                count: counts.messengerThreadCount,
                status: .ready
            ),
            MobileCollaborationAction(
                kind: .mail,
                titleKey: "work_hub_action_mail_title",
                valueKey: "work_hub_action_mail_value_ready",
                detailKey: "work_hub_action_mail_detail",
                count: nil,
                status: .ready
            ),
            MobileCollaborationAction(
                kind: .calendar,
                titleKey: "work_hub_action_calendar_title",
                valueKey: "work_hub_action_calendar_value_format",
                detailKey: "work_hub_action_calendar_detail",
                count: counts.targetDueWorkCount,
                status: .ready
            ),
            MobileCollaborationAction(
                kind: .poll,
                titleKey: "work_hub_action_polls_title",
                valueKey: "work_hub_action_polls_value_ready",
                detailKey: "work_hub_action_polls_detail",
                count: nil,
                status: .ready
            ),
        ]
    }
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
