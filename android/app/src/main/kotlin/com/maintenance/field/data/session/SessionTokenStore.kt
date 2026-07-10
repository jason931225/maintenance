package com.maintenance.field.data.session

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SessionTokenStore internal constructor(
    context: Context,
    private val tokenCipher: SessionTokenCipher,
) {
    constructor(context: Context) : this(context, AndroidKeystoreSessionTokenCipher())

    private val legacyPreferences =
        context.applicationContext.getSharedPreferences(LEGACY_PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val encryptedPreferences =
        context.applicationContext.getSharedPreferences(ENCRYPTED_PREFERENCES_NAME, Context.MODE_PRIVATE)

    init {
        migrateLegacyTokens()
    }

    fun accessToken(): String? = readEncryptedToken(KEY_ACCESS_TOKEN)

    fun refreshToken(): String? = readEncryptedToken(KEY_REFRESH_TOKEN)

    fun save(accessToken: String, refreshToken: String) {
        writeEncryptedTokens(
            mapOf(
                KEY_ACCESS_TOKEN to accessToken,
                KEY_REFRESH_TOKEN to refreshToken,
            ),
        )
        clearLegacyTokens()
    }

    fun clear() {
        commitOrThrow(encryptedPreferences.edit().clear(), "clear encrypted session tokens")
        commitOrThrow(legacyPreferences.edit().clear(), "clear legacy plaintext session tokens")
    }

    private fun readEncryptedToken(key: String): String? = encryptedPreferences
        .getString(key, null)
        ?.let(tokenCipher::decrypt)

    private fun migrateLegacyTokens() {
        val legacyTokens = TOKEN_KEYS.mapNotNull { key ->
            val legacyValue = legacyPreferences.getString(key, null) ?: return@mapNotNull null
            if (encryptedPreferences.contains(key)) {
                null
            } else {
                key to legacyValue
            }
        }.toMap()

        if (legacyTokens.isNotEmpty()) {
            writeEncryptedTokens(legacyTokens)
        }
        if (TOKEN_KEYS.any(legacyPreferences::contains)) {
            clearLegacyTokens()
        }
    }

    private fun writeEncryptedTokens(tokens: Map<String, String>) {
        val editor = encryptedPreferences.edit()
        tokens.forEach { (key, value) ->
            editor.putString(key, tokenCipher.encrypt(value))
        }
        commitOrThrow(editor, "persist encrypted session tokens")
    }

    private fun clearLegacyTokens() {
        val editor = legacyPreferences.edit()
        TOKEN_KEYS.forEach { key -> editor.remove(key) }
        commitOrThrow(editor, "remove legacy plaintext session tokens")
    }

    private fun commitOrThrow(editor: SharedPreferences.Editor, operation: String) {
        check(editor.commit()) { "Failed to $operation" }
    }

    private companion object {
        const val LEGACY_PREFERENCES_NAME = "field_session"
        const val ENCRYPTED_PREFERENCES_NAME = "field_session_encrypted"
        const val KEY_ACCESS_TOKEN = "access_token"
        const val KEY_REFRESH_TOKEN = "refresh_token"
        val TOKEN_KEYS = listOf(KEY_ACCESS_TOKEN, KEY_REFRESH_TOKEN)
    }
}

internal interface SessionTokenCipher {
    fun encrypt(plaintext: String): String
    fun decrypt(ciphertext: String): String?
}

private class AndroidKeystoreSessionTokenCipher : SessionTokenCipher {
    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    }

    override fun encrypt(plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return listOf(
            FORMAT_VERSION,
            Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
            Base64.encodeToString(ciphertext, Base64.NO_WRAP),
        ).joinToString(separator = ":")
    }

    override fun decrypt(ciphertext: String): String? {
        return try {
            val parts = ciphertext.split(":")
            if (parts.size != 3 || parts[0] != FORMAT_VERSION) return null
            val iv = Base64.decode(parts[1], Base64.NO_WRAP)
            val encryptedBytes = Base64.decode(parts[2], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            String(cipher.doFinal(encryptedBytes), Charsets.UTF_8)
        } catch (_: GeneralSecurityException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun secretKey(): SecretKey {
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val keySpec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(KEY_SIZE_BITS)
            .setRandomizedEncryptionRequired(true)
            .build()
        keyGenerator.init(keySpec)
        return keyGenerator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val FORMAT_VERSION = "v1"
        const val GCM_TAG_BITS = 128
        const val KEY_ALIAS = "maintenance_field_session_tokens_v1"
        const val KEY_SIZE_BITS = 256
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
