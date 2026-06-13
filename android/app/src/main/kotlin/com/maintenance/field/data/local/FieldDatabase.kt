package com.maintenance.field.data.local

import android.content.Context
import androidx.room.AutoMigration
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        WorkOrderEntity::class,
        MutationEntity::class,
        EvidenceUploadEntity::class,
        MessengerOutboxEntity::class,
    ],
    version = 3,
    exportSchema = true,
    autoMigrations = [
        AutoMigration(from = 1, to = 2),
        AutoMigration(from = 2, to = 3),
    ],
)
abstract class FieldDatabase : RoomDatabase() {
    abstract fun workOrders(): WorkOrderDao

    abstract fun mutations(): MutationDao

    abstract fun evidenceUploads(): EvidenceUploadDao

    abstract fun messengerOutbox(): MessengerOutboxDao

    companion object {
        fun create(context: Context): FieldDatabase =
            Room.databaseBuilder(context, FieldDatabase::class.java, "maintenance-field.db")
                .fallbackToDestructiveMigration(false)
                .build()
    }
}
