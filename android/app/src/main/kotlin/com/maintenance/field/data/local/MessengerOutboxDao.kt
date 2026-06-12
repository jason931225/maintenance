package com.maintenance.field.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface MessengerOutboxDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(message: MessengerOutboxEntity)

    @Query("SELECT * FROM messenger_outbox WHERE state = 'PENDING' ORDER BY createdAt ASC")
    suspend fun pending(): List<MessengerOutboxEntity>

    @Query("SELECT * FROM messenger_outbox WHERE requestId = :requestId")
    suspend fun get(requestId: String): MessengerOutboxEntity?

    @Query("UPDATE messenger_outbox SET state = 'SENT', lastError = NULL WHERE requestId = :requestId")
    suspend fun markSent(requestId: String)

    @Query("UPDATE messenger_outbox SET state = 'FAILED', lastError = :message WHERE requestId = :requestId")
    suspend fun markFailed(requestId: String, message: String)
}
