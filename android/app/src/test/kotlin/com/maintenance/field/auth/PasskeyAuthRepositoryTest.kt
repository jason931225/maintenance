package com.maintenance.field.auth

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.maintenance.api.client.model.DevicePlatform
import com.maintenance.api.client.model.DeviceRegistrationResponse
import com.maintenance.api.client.model.PasskeyLoginStartResponse
import com.maintenance.api.client.model.TokenPairResponse
import com.maintenance.field.data.api.MaintenanceApiGateway
import com.maintenance.field.data.session.DeviceIdStore
import com.maintenance.field.data.session.SessionTokenCipher
import com.maintenance.field.data.session.SessionTokenStore
import java.lang.reflect.Proxy
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PasskeyAuthRepositoryTest {
    @Test
    fun loginPreservesSessionAndReturnsRetryPendingMessageWhenDeviceRegistrationFailsAfterTokenSave() = runTest {
        val context = cleanContext()
        val tokenStore = SessionTokenStore(context, PrefixSessionTokenCipher())
        val gateway = RecordingPasskeyGateway(
            registrationFailure = RuntimeException("network unavailable"),
        )
        val repository = PasskeyAuthRepository(
            api = gateway.api,
            credentialClient = StaticCredentialClient(),
            tokenStore = tokenStore,
            deviceIdStore = DeviceIdStore(context),
            appVersion = "0.1.0",
        )

        val state = repository.login(context, userId)

        assertEquals("access.jwt", tokenStore.accessToken())
        assertEquals("refresh-token", tokenStore.refreshToken())
        assertLoginSessionPersistedEncrypted(context)
        val authenticated = assertIs<LoginState.Authenticated>(state)
        assertEquals("access.jwt", authenticated.accessToken)
        assertEquals("refresh-token", authenticated.refreshToken)
        val retry = assertIs<DeviceRegistrationState.RetryPending>(authenticated.deviceRegistration)
        assertEquals(DEVICE_REGISTRATION_RETRY_PENDING_MESSAGE_KEY, retry.messageKey)
        assertEquals(DevicePlatform.ANDROID, retry.platform)
        assertEquals("0.1.0", retry.appVersion)
        assertEquals("RuntimeException", retry.lastErrorClass)
        assertEquals(1, gateway.deviceRegistrations.size)
        assertEquals("0.1.0", gateway.deviceRegistrations.single().appVersion)
    }

    @Test
    fun loginClearsExistingSessionWhenMobileRefreshTokenIsMissingBeforeTokenCommit() = runTest {
        val context = cleanContext()
        val tokenStore = SessionTokenStore(context, PrefixSessionTokenCipher())
        tokenStore.save("stale-access", "stale-refresh")
        val gateway = RecordingPasskeyGateway(
            finishResponse = tokenPair(refreshToken = null),
        )
        val repository = PasskeyAuthRepository(
            api = gateway.api,
            credentialClient = StaticCredentialClient(),
            tokenStore = tokenStore,
            deviceIdStore = DeviceIdStore(context),
            appVersion = "0.1.0",
        )

        val state = repository.login(context, userId)

        assertEquals(LoginState.SignedOut(messageKey = "login_failed"), state)
        assertNull(tokenStore.accessToken())
        assertNull(tokenStore.refreshToken())
        assertTrue(gateway.deviceRegistrations.isEmpty())
    }

    private fun assertLoginSessionPersistedEncrypted(context: Context) {
        val legacyPreferences = context.getSharedPreferences("field_session", Context.MODE_PRIVATE)
        val encryptedPreferences = context.getSharedPreferences("field_session_encrypted", Context.MODE_PRIVATE)

        assertFalse(
            legacyPreferences.contains("access_token"),
            "login should not leave access_token in plaintext field_session preferences",
        )
        assertFalse(
            legacyPreferences.contains("refresh_token"),
            "login should not leave refresh_token in plaintext field_session preferences",
        )
        assertEquals("enc:access.jwt", encryptedPreferences.getString("access_token", null))
        assertEquals("enc:refresh-token", encryptedPreferences.getString("refresh_token", null))
    }

    private fun cleanContext(): Context {
        val context = ApplicationProvider.getApplicationContext<Context>()
        context.getSharedPreferences("field_session", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("field_session_encrypted", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("field_device", Context.MODE_PRIVATE).edit().clear().commit()
        return context
    }

    private class PrefixSessionTokenCipher : SessionTokenCipher {
        override fun encrypt(plaintext: String): String = "enc:$plaintext"

        override fun decrypt(ciphertext: String): String? = ciphertext
            .takeIf { it.startsWith("enc:") }
            ?.removePrefix("enc:")
    }

    private class StaticCredentialClient : PasskeyCredentialClient {
        override suspend fun getLoginCredential(
            context: Context,
            challengeJson: String,
        ): Map<String, JsonElement> = mapOf("id" to JsonPrimitive("credential-id"))
    }

    private class RecordingPasskeyGateway(
        private val finishResponse: TokenPairResponse = tokenPair(),
        private val registrationFailure: RuntimeException? = null,
    ) {
        val deviceRegistrations = mutableListOf<DeviceRegistrationCall>()

        val api: MaintenanceApiGateway = Proxy.newProxyInstance(
            MaintenanceApiGateway::class.java.classLoader,
            arrayOf(MaintenanceApiGateway::class.java),
        ) { _, method, args ->
            when (method.name) {
                "startPasskeyLogin" -> passkeyLoginStart()
                "finishPasskeyLogin" -> finishResponse
                "registerAndroidDevice" -> {
                    val deviceId = args?.get(0) as String
                    val appVersion = args[1] as String
                    val pushToken = args[2] as? String
                    deviceRegistrations += DeviceRegistrationCall(deviceId, appVersion, pushToken)
                    registrationFailure?.let { throw it }
                    deviceRegistration(appVersion = appVersion, pushToken = pushToken)
                }
                "toString" -> "RecordingPasskeyGateway"
                else -> throw AssertionError("Unexpected gateway call: ${method.name}")
            }
        } as MaintenanceApiGateway
    }

    private data class DeviceRegistrationCall(
        val deviceId: String,
        val appVersion: String,
        val pushToken: String?,
    )

    private companion object {
        val userId: UUID = UUID.fromString("00000000-0000-0000-0000-000000000901")
        private val ceremonyId: UUID = UUID.fromString("00000000-0000-0000-0000-000000000902")
        private val deviceRegistrationId: UUID = UUID.fromString("00000000-0000-0000-0000-000000000903")
        private val now: OffsetDateTime = OffsetDateTime.parse("2026-06-12T09:05:00Z")

        fun passkeyLoginStart(): PasskeyLoginStartResponse = PasskeyLoginStartResponse(
            ceremonyId = ceremonyId,
            challenge = mapOf("challenge" to JsonPrimitive("abc")),
            expiresAt = now,
        )

        fun tokenPair(refreshToken: String? = "refresh-token"): TokenPairResponse = TokenPairResponse(
            accessToken = "access.jwt",
            tokenType = TokenPairResponse.TokenType.BEARER,
            refreshExpiresAt = now.plusHours(1),
            requiresPasskeySetup = false,
            refreshToken = refreshToken,
        )

        fun deviceRegistration(
            appVersion: String,
            pushToken: String?,
        ): DeviceRegistrationResponse = DeviceRegistrationResponse(
            id = deviceRegistrationId,
            userId = userId,
            deviceHash = "device-hash",
            platform = DevicePlatform.ANDROID,
            appVersion = appVersion,
            lastRegisteredAt = now,
            pushToken = pushToken,
        )
    }
}
