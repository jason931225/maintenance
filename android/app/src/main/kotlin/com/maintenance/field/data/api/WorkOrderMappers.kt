package com.maintenance.field.data.api

import com.maintenance.api.client.model.PriorityLevel
import com.maintenance.api.client.model.WorkOrderDetail
import com.maintenance.api.client.model.WorkOrderListItem
import com.maintenance.field.data.offline.SyncState

fun WorkOrderListItem.toTechnicianWorkOrder(syncState: SyncState = SyncState.SYNCED): TechnicianWorkOrder =
    TechnicianWorkOrder(
        id = id,
        requestNo = requestNo,
        managementNo = equipment.managementNo ?: equipment.equipmentNo,
        modelName = equipment.model.orEmpty(),
        customerName = customer.name,
        siteName = site.name,
        priority = priority,
        prioritySort = priority.sortOrder,
        status = status,
        targetDueAt = targetDueAt,
        syncState = syncState,
        assigneeNames = assignments.map { it.mechanicName },
    )

fun WorkOrderDetail.toTechnicianWorkOrder(syncState: SyncState = SyncState.SYNCED): TechnicianWorkOrder =
    TechnicianWorkOrder(
        id = id,
        requestNo = requestNo,
        managementNo = equipment.managementNo ?: equipment.equipmentNo,
        modelName = equipment.model.orEmpty(),
        customerName = customer.name,
        siteName = site.name,
        priority = priority,
        prioritySort = priority.sortOrder,
        status = status,
        targetDueAt = targetDueAt,
        syncState = syncState,
        assigneeNames = assignments.map { it.mechanicName },
    )

private val PriorityLevel.sortOrder: Int
    get() = when (this) {
        PriorityLevel.P1 -> 0
        PriorityLevel.P2 -> 1
        PriorityLevel.P3 -> 2
        PriorityLevel.OUTSOURCE -> 3
        PriorityLevel.UNSET -> 4
    }
