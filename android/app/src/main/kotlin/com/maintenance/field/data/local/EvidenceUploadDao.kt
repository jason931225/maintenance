package com.maintenance.field.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface EvidenceUploadDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(upload: EvidenceUploadEntity)

    @Query("SELECT * FROM evidence_uploads WHERE syncState = 'PENDING' ORDER BY localId ASC")
    suspend fun pending(): List<EvidenceUploadEntity>

    @Query("UPDATE evidence_uploads SET syncState = 'SYNCED', lastError = NULL WHERE localId = :localId")
    suspend fun markSynced(localId: String)

    @Query("UPDATE evidence_uploads SET syncState = 'FAILED', lastError = :message WHERE localId = :localId")
    suspend fun markFailed(localId: String, message: String)
}
