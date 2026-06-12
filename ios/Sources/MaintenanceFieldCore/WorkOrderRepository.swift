import Foundation
import MaintenanceAPIClient

public actor WorkOrderCacheStore {
    private var today: [TechnicianWorkOrder] = []
    private var details: [Components.Schemas.Uuid: TechnicianWorkOrder] = [:]

    public init() {}

    public func loadToday() -> [TechnicianWorkOrder] {
        today
    }

    public func saveToday(_ workOrders: [TechnicianWorkOrder]) {
        today = workOrders
        for workOrder in workOrders {
            details[workOrder.id] = workOrder
        }
    }

    public func saveDetail(_ workOrder: TechnicianWorkOrder) {
        details[workOrder.id] = workOrder
        today = today.map { $0.id == workOrder.id ? workOrder : $0 }
    }

    public func detail(id: Components.Schemas.Uuid) -> TechnicianWorkOrder? {
        details[id]
    }

    public func markPending(id: Components.Schemas.Uuid) {
        today = today.map { workOrder in
            guard workOrder.id == id else { return workOrder }
            var updated = workOrder
            updated.syncState = .pending
            return updated
        }
        if var detail = details[id] {
            detail.syncState = .pending
            details[id] = detail
        }
    }
}

public struct WorkOrderRepository: Sendable {
    private let gateway: any MaintenanceAPIGateway
    private let cache: WorkOrderCacheStore
    private let offlineQueue: OfflineQueueRepository

    public init(
        gateway: any MaintenanceAPIGateway,
        cache: WorkOrderCacheStore,
        offlineQueue: OfflineQueueRepository
    ) {
        self.gateway = gateway
        self.cache = cache
        self.offlineQueue = offlineQueue
    }

    public func cachedToday() async -> [TechnicianWorkOrder] {
        await cache.loadToday()
    }

    public func refreshToday() async throws -> [TechnicianWorkOrder] {
        let workOrders = try await gateway.listTodayWorkOrders()
        await cache.saveToday(workOrders)
        return workOrders
    }

    public func detail(id: Components.Schemas.Uuid) async throws -> TechnicianWorkOrder {
        do {
            let workOrder = try await gateway.getWorkOrderDetail(id: id)
            await cache.saveDetail(workOrder)
            return workOrder
        } catch {
            if let cached = await cache.detail(id: id) {
                return cached
            }
            throw error
        }
    }

    @discardableResult
    public func start(id: Components.Schemas.Uuid) async throws -> SyncState {
        do {
            try await gateway.startWorkOrder(id: id)
            _ = try await detail(id: id)
            return .synced
        } catch {
            _ = try await offlineQueue.enqueueStart(workOrderID: id)
            await cache.markPending(id: id)
            return .pending
        }
    }

    @discardableResult
    public func submitReport(id: Components.Schemas.Uuid, draft: ReportDraft) async throws -> SyncState {
        do {
            try await gateway.submitReport(id: id, draft: draft)
            _ = try await detail(id: id)
            return .synced
        } catch {
            _ = try await offlineQueue.enqueueReport(
                workOrderID: id,
                resultType: draft.resultType,
                diagnosis: draft.diagnosis,
                actionTaken: draft.actionTaken
            )
            await cache.markPending(id: id)
            return .pending
        }
    }

    public func replayPending() async throws -> ReplaySummary {
        try await offlineQueue.replayPending()
    }
}
