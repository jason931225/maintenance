package com.maintenance.field.data.local

import com.maintenance.field.data.api.TechnicianWorkOrder
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

class RoomWorkOrderStore(private val dao: WorkOrderDao) {
    fun observeToday(): Flow<List<TechnicianWorkOrder>> =
        dao.observeToday().map { items -> items.map { it.toDomain() } }

    suspend fun replaceToday(items: List<TechnicianWorkOrder>) {
        dao.upsertAll(items.map { it.toEntity() })
    }

    suspend fun upsert(item: TechnicianWorkOrder) {
        dao.upsert(item.toEntity())
    }

    suspend fun markPending(id: String) {
        dao.get(id)?.let { current ->
            dao.upsert(current.copy(syncState = "PENDING"))
        }
    }
}
