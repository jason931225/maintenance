import MaintenanceAPIClient

public extension Components.Schemas.PriorityLevel {
    var fieldLabelKey: String {
        switch self {
        case .p1: "priority_p1"
        case .p2: "priority_p2"
        case .p3: "priority_p3"
        case .outsource: "priority_outsource"
        case .unset: "priority_unset"
        }
    }
}

public extension Components.Schemas.WorkOrderStatus {
    var fieldLabelKey: String {
        switch self {
        case .received: "status_received"
        case .unassigned: "status_unassigned"
        case .assigned: "status_assigned"
        case .inProgress: "status_in_progress"
        case .reportSubmitted: "status_report_submitted"
        case .adminReview: "status_admin_review"
        case .finalCompleted: "status_final_completed"
        case .rejected: "status_rejected"
        case .onHold: "status_on_hold"
        case .delayed: "status_delayed"
        case .temporaryAction: "status_temporary_action"
        case .partWaiting: "status_part_waiting"
        case .equipmentInUse: "status_equipment_in_use"
        case .revisitRequired: "status_revisit_required"
        case .archived: "status_archived"
        case .cancelled: "status_cancelled"
        }
    }
}

public extension Components.Schemas.WorkResultType {
    var fieldLabelKey: String {
        switch self {
        case .completed: "result_completed"
        case .temporaryAction: "result_temporary_action"
        case .incomplete: "result_incomplete"
        case .revisitRequired: "result_revisit_required"
        case .unknown: "result_unknown"
        }
    }
}

public extension SyncState {
    var fieldLabelKey: String {
        switch self {
        case .synced: "sync_synced"
        case .pending: "sync_pending"
        case .failed: "sync_failed"
        }
    }
}

public extension MobileCollaborationStatus {
    var fieldLabelKey: String {
        switch self {
        case .actionRequired: "work_hub_status_action_required"
        case .ready: "work_hub_status_ready"
        case .monitoring: "work_hub_status_monitoring"
        }
    }
}

public extension Components.Schemas.MessengerThreadKind {
    var fieldLabelKey: String {
        switch self {
        case .workOrder: "messenger_kind_work_order"
        case .team: "messenger_kind_team"
        case .dm: "messenger_kind_dm"
        case .group: "messenger_kind_group"
        }
    }
}
