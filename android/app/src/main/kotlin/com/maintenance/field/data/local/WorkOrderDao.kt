package com.maintenance.field.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface WorkOrderDao {
    @Query(
        """
        SELECT * FROM work_orders
        ORDER BY prioritySort ASC, targetDueAt IS NULL ASC, targetDueAt ASC, requestNo ASC
        """,
    )
    fun observeToday(): Flow<List<WorkOrderEntity>>

    @Query("SELECT * FROM work_orders WHERE id = :id")
    suspend fun get(id: String): WorkOrderEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(items: List<WorkOrderEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(item: WorkOrderEntity)
}
