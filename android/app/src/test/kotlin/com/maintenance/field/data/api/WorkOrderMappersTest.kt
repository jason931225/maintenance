package com.maintenance.field.data.api

import com.maintenance.api.client.model.AssignmentRole
import com.maintenance.api.client.model.AssignmentSummary
import com.maintenance.api.client.model.EquipmentSummary
import com.maintenance.api.client.model.NamedEntity
import com.maintenance.api.client.model.PriorityLevel
import com.maintenance.api.client.model.SubmitReportRequest
import com.maintenance.api.client.model.WorkOrderListItem
import com.maintenance.api.client.model.WorkOrderStatus
import com.maintenance.api.client.model.WorkResultType
import com.maintenance.field.data.offline.SyncState
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals

class WorkOrderMappersTest {
    @Test
    fun mapsGeneratedWorkOrderListItemIntoTechnicianTodoModel() {
        val item = generatedWorkOrder(
            priority = PriorityLevel.P1,
            status = WorkOrderStatus.ASSIGNED,
        )

        val mapped = item.toTechnicianWorkOrder(syncState = SyncState.PENDING)

        assertEquals(item.id, mapped.id)
        assertEquals("20260612-001", mapped.requestNo)
        assertEquals("290", mapped.managementNo)
        assertEquals("GTS25DE", mapped.modelName)
        assertEquals("대성물류", mapped.customerName)
        assertEquals(PriorityLevel.P1, mapped.priority)
        assertEquals(0, mapped.prioritySort)
        assertEquals(WorkOrderStatus.ASSIGNED, mapped.status)
        assertEquals(SyncState.PENDING, mapped.syncState)
        assertEquals("김정비", mapped.assigneeNames.single())
    }

    @Test
    fun mapsReportDraftToGeneratedSubmitReportRequest() {
        val request = ReportDraft(
            resultType = WorkResultType.COMPLETED,
            diagnosis = "배터리 커넥터 접촉 불량",
            actionTaken = "커넥터 교체 및 충전 확인",
        ).toSubmitReportRequest()

        assertEquals(
            SubmitReportRequest(
                resultType = WorkResultType.COMPLETED,
                diagnosis = "배터리 커넥터 접촉 불량",
                actionTaken = "커넥터 교체 및 충전 확인",
            ),
            request,
        )
    }

    private fun generatedWorkOrder(
        priority: PriorityLevel,
        status: WorkOrderStatus,
    ) = WorkOrderListItem(
        id = UUID.fromString("00000000-0000-0000-0000-000000000111"),
        requestNo = "20260612-001",
        branchId = UUID.fromString("00000000-0000-0000-0000-000000000222"),
        status = status,
        priority = priority,
        resultType = WorkResultType.UNKNOWN,
        targetDueAt = OffsetDateTime.parse("2026-06-12T13:00:00Z"),
        createdAt = OffsetDateTime.parse("2026-06-12T08:00:00Z"),
        updatedAt = OffsetDateTime.parse("2026-06-12T08:05:00Z"),
        equipment = EquipmentSummary(
            id = UUID.fromString("00000000-0000-0000-0000-000000000333"),
            equipmentNo = "D290",
            managementNo = "290",
            model = "GTS25DE",
            status = "임대",
            specification = "좌식",
            tonText = "2.5t",
        ),
        customer = NamedEntity(
            id = UUID.fromString("00000000-0000-0000-0000-000000000444"),
            name = "대성물류",
        ),
        site = NamedEntity(
            id = UUID.fromString("00000000-0000-0000-0000-000000000555"),
            name = "1공장",
        ),
        assignments = listOf(
            AssignmentSummary(
                id = UUID.fromString("00000000-0000-0000-0000-000000000666"),
                mechanicId = UUID.fromString("00000000-0000-0000-0000-000000000777"),
                mechanicName = "김정비",
                role = AssignmentRole.PRIMARY,
                assignedAt = OffsetDateTime.parse("2026-06-12T08:10:00Z"),
            ),
        ),
    )
}
