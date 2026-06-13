package com.maintenance.field.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey
import com.maintenance.api.client.model.PriorityLevel
import com.maintenance.api.client.model.WorkOrderStatus
import com.maintenance.field.data.api.TechnicianWorkOrder
import com.maintenance.field.data.offline.SyncState
import java.time.OffsetDateTime
import java.util.UUID

@Entity(tableName = "work_orders")
data class WorkOrderEntity(
    @PrimaryKey val id: String,
    val requestNo: String,
    val managementNo: String,
    val modelName: String,
    val customerName: String,
    val siteName: String,
    val priority: String,
    val prioritySort: Int,
    val status: String,
    val targetDueAt: String?,
    val symptom: String?,
    val syncState: String,
    val assigneeNames: String,
)

fun TechnicianWorkOrder.toEntity(): WorkOrderEntity = WorkOrderEntity(
    id = id.toString(),
    requestNo = requestNo,
    managementNo = managementNo,
    modelName = modelName,
    customerName = customerName,
    siteName = siteName,
    priority = priority.value,
    prioritySort = prioritySort,
    status = status.value,
    targetDueAt = targetDueAt?.toString(),
    symptom = symptom,
    syncState = syncState.name,
    assigneeNames = assigneeNames.joinToString(separator = "\n"),
)

fun WorkOrderEntity.toDomain(): TechnicianWorkOrder = TechnicianWorkOrder(
    id = UUID.fromString(id),
    requestNo = requestNo,
    managementNo = managementNo,
    modelName = modelName,
    customerName = customerName,
    siteName = siteName,
    priority = requireNotNull(PriorityLevel.decode(priority)),
    prioritySort = prioritySort,
    status = requireNotNull(WorkOrderStatus.decode(status)),
    targetDueAt = targetDueAt?.let(OffsetDateTime::parse),
    symptom = symptom,
    syncState = SyncState.valueOf(syncState),
    assigneeNames = assigneeNames.takeIf { it.isNotBlank() }?.split('\n').orEmpty(),
)
