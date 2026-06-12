package com.maintenance.field.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        WorkOrderEntity::class,
        MutationEntity::class,
        EvidenceUploadEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class FieldDatabase : RoomDatabase() {
    abstract fun workOrders(): WorkOrderDao

    abstract fun mutations(): MutationDao

    abstract fun evidenceUploads(): EvidenceUploadDao

    companion object {
        fun create(context: Context): FieldDatabase =
            Room.databaseBuilder(context, FieldDatabase::class.java, "maintenance-field.db")
                .fallbackToDestructiveMigration(false)
                .build()
    }
}
