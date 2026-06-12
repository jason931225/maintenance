package com.maintenance.field.ui

import androidx.annotation.StringRes
import com.maintenance.api.client.model.PriorityLevel
import com.maintenance.api.client.model.WorkOrderStatus
import com.maintenance.api.client.model.WorkResultType
import com.maintenance.field.R
import com.maintenance.field.data.offline.SyncState

@StringRes
fun PriorityLevel.labelRes(): Int = when (this) {
    PriorityLevel.P1 -> R.string.priority_p1
    PriorityLevel.P2 -> R.string.priority_p2
    PriorityLevel.P3 -> R.string.priority_p3
    PriorityLevel.OUTSOURCE -> R.string.priority_outsource
    PriorityLevel.UNSET -> R.string.priority_unset
}

@StringRes
fun WorkOrderStatus.labelRes(): Int = when (this) {
    WorkOrderStatus.ASSIGNED -> R.string.status_assigned
    WorkOrderStatus.IN_PROGRESS -> R.string.status_in_progress
    WorkOrderStatus.REPORT_SUBMITTED -> R.string.status_report_submitted
    WorkOrderStatus.FINAL_COMPLETED -> R.string.status_final_completed
    WorkOrderStatus.REJECTED -> R.string.status_rejected
    WorkOrderStatus.ON_HOLD -> R.string.status_on_hold
    WorkOrderStatus.DELAYED -> R.string.status_delayed
    WorkOrderStatus.TEMPORARY_ACTION -> R.string.status_temporary_action
    WorkOrderStatus.PART_WAITING -> R.string.status_part_waiting
    WorkOrderStatus.EQUIPMENT_IN_USE -> R.string.status_equipment_in_use
    WorkOrderStatus.REVISIT_REQUIRED -> R.string.status_revisit_required
    WorkOrderStatus.ARCHIVED -> R.string.status_archived
    WorkOrderStatus.CANCELLED -> R.string.status_cancelled
    WorkOrderStatus.RECEIVED -> R.string.status_received
    WorkOrderStatus.UNASSIGNED -> R.string.status_unassigned
    WorkOrderStatus.ADMIN_REVIEW -> R.string.status_admin_review
}

@StringRes
fun SyncState.labelRes(): Int = when (this) {
    SyncState.SYNCED -> R.string.sync_synced
    SyncState.PENDING -> R.string.sync_pending
    SyncState.FAILED -> R.string.sync_failed
}

@StringRes
fun WorkResultType.labelRes(): Int = when (this) {
    WorkResultType.COMPLETED -> R.string.result_completed
    WorkResultType.TEMPORARY_ACTION -> R.string.result_temporary_action
    WorkResultType.INCOMPLETE -> R.string.result_incomplete
    WorkResultType.REVISIT_REQUIRED -> R.string.result_revisit_required
    WorkResultType.UNKNOWN -> R.string.result_unknown
}
