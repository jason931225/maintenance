package com.maintenance.field.data.session

import android.content.Context
import androidx.core.content.edit
import java.util.UUID

class DeviceIdStore(context: Context) {
    private val preferences = context.getSharedPreferences("field_device", Context.MODE_PRIVATE)

    fun getOrCreate(): String {
        preferences.getString(KEY_DEVICE_ID, null)?.let { return it }
        val created = UUID.randomUUID().toString()
        preferences.edit { putString(KEY_DEVICE_ID, created) }
        return created
    }

    private companion object {
        const val KEY_DEVICE_ID = "device_id"
    }
}
