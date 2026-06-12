package com.maintenance.field.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface MutationDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(mutation: MutationEntity)

    @Query("SELECT * FROM queued_mutations WHERE syncState = 'PENDING' ORDER BY createdAt ASC")
    suspend fun pending(): List<MutationEntity>

    @Query("SELECT * FROM queued_mutations WHERE requestId = :requestId")
    suspend fun get(requestId: String): MutationEntity?

    @Query(
        """
        UPDATE queued_mutations
        SET syncState = 'SYNCED', lastError = NULL, serverReplayed = :serverReplayed
        WHERE requestId = :requestId
        """,
    )
    suspend fun markSynced(requestId: String, serverReplayed: Boolean)

    @Query(
        """
        UPDATE queued_mutations
        SET syncState = 'FAILED', lastError = :message
        WHERE requestId = :requestId
        """,
    )
    suspend fun markFailed(requestId: String, message: String)
}
