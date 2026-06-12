package com.maintenance.field.auth

import android.content.Context
import com.maintenance.field.data.api.MaintenanceApiGateway
import com.maintenance.field.data.session.DeviceIdStore
import com.maintenance.field.data.session.SessionTokenStore
import java.util.UUID
import kotlinx.serialization.json.JsonObject

class PasskeyAuthRepository(
    private val api: MaintenanceApiGateway,
    private val credentialClient: PasskeyCredentialClient,
    private val tokenStore: SessionTokenStore,
    private val deviceIdStore: DeviceIdStore,
    private val appVersion: String,
    private val stateMachine: LoginStateMachine = LoginStateMachine(),
) {
    fun hasSession(): Boolean = tokenStore.accessToken() != null

    suspend fun login(context: Context, userId: UUID): LoginState {
        var state: LoginState = LoginState.SignedOut()
        return try {
            val challenge = api.startPasskeyLogin(userId)
            val challengeJson = JsonObject(challenge.challenge).toString()
            state = stateMachine.reduce(
                state,
                LoginEvent.LoginChallengeReceived(
                    userId = userId,
                    ceremonyId = challenge.ceremonyId,
                    challengeJson = challengeJson,
                    expiresAt = challenge.expiresAt,
                ),
            )

            val credential = credentialClient.getLoginCredential(context, challengeJson)
            val tokens = api.finishPasskeyLogin(challenge.ceremonyId, credential)
            tokenStore.save(tokens.accessToken, tokens.refreshToken)

            val deviceId = deviceIdStore.getOrCreate()
            state = stateMachine.reduce(
                state,
                LoginEvent.PasskeyVerified(
                    accessToken = tokens.accessToken,
                    refreshToken = tokens.refreshToken,
                    deviceId = deviceId,
                    appVersion = appVersion,
                ),
            )
            val device = api.registerAndroidDevice(deviceId, appVersion)
            stateMachine.reduce(state, LoginEvent.DeviceRegistered(device.id))
        } catch (_: Exception) {
            tokenStore.clear()
            stateMachine.reduce(state, LoginEvent.Failed("login_failed"))
        }
    }

    fun clearSession() {
        tokenStore.clear()
    }
}
