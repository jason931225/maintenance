package com.maintenance.field.data.session

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionTokenStoreTest {
    private lateinit var context: Context
    private lateinit var legacyPreferences: android.content.SharedPreferences
    private lateinit var encryptedPreferences: android.content.SharedPreferences

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        legacyPreferences = context.getSharedPreferences("field_session", Context.MODE_PRIVATE)
        encryptedPreferences = context.getSharedPreferences("field_session_encrypted", Context.MODE_PRIVATE)
        legacyPreferences.edit().clear().commit()
        encryptedPreferences.edit().clear().commit()
    }

    @After
    fun tearDown() {
        legacyPreferences.edit().clear().commit()
        encryptedPreferences.edit().clear().commit()
    }

    @Test
    fun saveStoresTokensEncryptedAndScrubsLegacyPlaintext() {
        val store = SessionTokenStore(context, PrefixSessionTokenCipher())

        store.save("access-secret", "refresh-secret")

        assertEquals("access-secret", store.accessToken())
        assertEquals("refresh-secret", store.refreshToken())
        assertNoLegacyPlaintextTokens()
        assertNotEquals("access-secret", encryptedPreferences.getString("access_token", null))
        assertNotEquals("refresh-secret", encryptedPreferences.getString("refresh_token", null))
        assertTrue(encryptedPreferences.getString("access_token", null)?.startsWith("enc:") == true)
        assertTrue(encryptedPreferences.getString("refresh_token", null)?.startsWith("enc:") == true)
    }

    @Test
    fun constructorMigratesLegacyPlaintextTokensThenDeletesLegacyKeys() {
        legacyPreferences.edit()
            .putString("access_token", "legacy-access")
            .putString("refresh_token", "legacy-refresh")
            .commit()

        val store = SessionTokenStore(context, PrefixSessionTokenCipher())

        assertEquals("legacy-access", store.accessToken())
        assertEquals("legacy-refresh", store.refreshToken())
        assertNoLegacyPlaintextTokens()
        assertEquals("enc:legacy-access", encryptedPreferences.getString("access_token", null))
        assertEquals("enc:legacy-refresh", encryptedPreferences.getString("refresh_token", null))
    }

    @Test
    fun clearRemovesEncryptedTokensAndAnyLegacyPlaintextMaterial() {
        legacyPreferences.edit()
            .putString("access_token", "legacy-access")
            .putString("refresh_token", "legacy-refresh")
            .commit()
        val store = SessionTokenStore(context, PrefixSessionTokenCipher())
        store.save("access-secret", "refresh-secret")

        // Simulate a stale plaintext write left by a pre-upgrade process after encrypted save.
        legacyPreferences.edit()
            .putString("access_token", "stale-access")
            .putString("refresh_token", "stale-refresh")
            .commit()

        store.clear()

        assertNull(store.accessToken())
        assertNull(store.refreshToken())
        assertNoLegacyPlaintextTokens()
        assertNull(encryptedPreferences.getString("access_token", null))
        assertNull(encryptedPreferences.getString("refresh_token", null))
    }

    private fun assertNoLegacyPlaintextTokens() {
        assertFalse(
            "legacy field_session access_token should be removed",
            legacyPreferences.contains("access_token"),
        )
        assertFalse(
            "legacy field_session refresh_token should be removed",
            legacyPreferences.contains("refresh_token"),
        )
    }

    private class PrefixSessionTokenCipher : SessionTokenCipher {
        override fun encrypt(plaintext: String): String = "enc:$plaintext"

        override fun decrypt(ciphertext: String): String? = ciphertext
            .takeIf { it.startsWith("enc:") }
            ?.removePrefix("enc:")
    }
}
