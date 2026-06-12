package com.maintenance.field.data.workorders

import com.maintenance.api.client.model.WorkResultType
import com.maintenance.field.data.api.MaintenanceApiGateway
import com.maintenance.field.data.api.ReportDraft
import com.maintenance.field.data.api.TechnicianWorkOrder
import com.maintenance.field.data.local.RoomWorkOrderStore
import com.maintenance.field.data.offline.OfflineQueueRepository
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.flow.Flow

class WorkOrderRepository(
    private val api: MaintenanceApiGateway,
    private val localStore: RoomWorkOrderStore,
    private val queue: OfflineQueueRepository,
) {
    fun observeToday(): Flow<List<TechnicianWorkOrder>> = localStore.observeToday()

    suspend fun refreshToday() {
        localStore.replaceToday(api.listTodayWorkOrders())
    }

    suspend fun refreshDetail(workOrderId: UUID) {
        localStore.upsert(api.getWorkOrder(workOrderId))
    }

    suspend fun start(workOrderId: UUID) {
        try {
            api.startWorkOrder(workOrderId)
            refreshToday()
        } catch (_: IOException) {
            queue.enqueueStart(workOrderId)
            localStore.markPending(workOrderId.toString())
        }
    }

    suspend fun submitReport(workOrderId: UUID, draft: ReportDraft) {
        try {
            api.submitReport(workOrderId, draft.toSubmitReportRequest())
            refreshToday()
        } catch (_: IOException) {
            queue.enqueueReport(
                workOrderId = workOrderId,
                resultType = draft.resultType,
                diagnosis = draft.diagnosis,
                actionTaken = draft.actionTaken,
            )
            localStore.markPending(workOrderId.toString())
        }
    }

    fun emptyReportDraft(): ReportDraft = ReportDraft(
        resultType = WorkResultType.COMPLETED,
        diagnosis = "",
        actionTaken = "",
    )
}
