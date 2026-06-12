import Foundation
import MaintenanceAPIClient

public extension Components.Schemas.PriorityLevel {
    var sortOrder: Int {
        switch self {
        case .p1:
            0
        case .p2:
            1
        case .p3:
            2
        case .outsource:
            3
        case .unset:
            4
        }
    }
}

public extension Components.Schemas.WorkOrderListItem {
    func toTechnicianWorkOrder(syncState: SyncState) -> TechnicianWorkOrder {
        TechnicianWorkOrder(
            id: id,
            requestNo: requestNo,
            managementNo: equipment.managementNo ?? equipment.equipmentNo,
            modelName: equipment.model ?? "",
            customerName: customer.name,
            siteName: site.name,
            priority: priority,
            status: status,
            resultType: resultType,
            targetDueAt: targetDueAt,
            createdAt: createdAt,
            updatedAt: updatedAt,
            assigneeNames: assignments.map(\.mechanicName),
            syncState: syncState
        )
    }
}

public extension Components.Schemas.WorkOrderDetail {
    func toTechnicianWorkOrder(syncState: SyncState) -> TechnicianWorkOrder {
        var workOrder = value1.toTechnicianWorkOrder(syncState: syncState)
        workOrder.symptom = value2.symptom
        workOrder.customerRequest = value2.customerRequest
        workOrder.diagnosis = value2.diagnosis
        workOrder.actionTaken = value2.actionTaken
        workOrder.evidenceVerified = value2.evidenceVerified
        return workOrder
    }
}
