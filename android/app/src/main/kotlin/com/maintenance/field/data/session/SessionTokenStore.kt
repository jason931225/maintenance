package com.maintenance.field.data.session

import android.content.Context
import androidx.core.content.edit

class SessionTokenStore(context: Context) {
    private val preferences = context.getSharedPreferences("field_session", Context.MODE_PRIVATE)

    fun accessToken(): String? = preferences.getString(KEY_ACCESS_TOKEN, null)

    fun refreshToken(): String? = preferences.getString(KEY_REFRESH_TOKEN, null)

    fun save(accessToken: String, refreshToken: String) {
        preferences.edit {
            putString(KEY_ACCESS_TOKEN, accessToken)
            putString(KEY_REFRESH_TOKEN, refreshToken)
        }
    }

    fun clear() {
        preferences.edit { clear() }
    }

    private companion object {
        const val KEY_ACCESS_TOKEN = "access_token"
        const val KEY_REFRESH_TOKEN = "refresh_token"
    }
}
