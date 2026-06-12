package com.maintenance.field.auth

import com.maintenance.api.client.model.DevicePlatform
import java.time.OffsetDateTime
import java.util.UUID

sealed interface LoginState {
    data class SignedOut(val messageKey: String? = null) : LoginState

    data class AwaitingPasskey(
        val userId: UUID,
        val ceremonyId: UUID,
        val challengeJson: String,
    ) : LoginState

    data class RegisteringDevice(
        val accessToken: String,
        val refreshToken: String,
        val deviceId: String,
        val platform: DevicePlatform,
        val appVersion: String,
    ) : LoginState

    data class Authenticated(
        val accessToken: String,
        val refreshToken: String,
    ) : LoginState
}

sealed interface LoginEvent {
    data class LoginChallengeReceived(
        val userId: UUID,
        val ceremonyId: UUID,
        val challengeJson: String,
        val expiresAt: OffsetDateTime,
    ) : LoginEvent

    data class PasskeyVerified(
        val accessToken: String,
        val refreshToken: String,
        val deviceId: String,
        val appVersion: String,
    ) : LoginEvent

    data class DeviceRegistered(val serverDeviceId: UUID) : LoginEvent

    data class Failed(val messageKey: String) : LoginEvent
}

class LoginStateMachine {
    fun reduce(state: LoginState, event: LoginEvent): LoginState = when (event) {
        is LoginEvent.LoginChallengeReceived -> LoginState.AwaitingPasskey(
            userId = event.userId,
            ceremonyId = event.ceremonyId,
            challengeJson = event.challengeJson,
        )
        is LoginEvent.PasskeyVerified -> LoginState.RegisteringDevice(
            accessToken = event.accessToken,
            refreshToken = event.refreshToken,
            deviceId = event.deviceId,
            platform = DevicePlatform.ANDROID,
            appVersion = event.appVersion,
        )
        is LoginEvent.DeviceRegistered -> when (state) {
            is LoginState.RegisteringDevice -> LoginState.Authenticated(
                accessToken = state.accessToken,
                refreshToken = state.refreshToken,
            )
            else -> LoginState.SignedOut(messageKey = "login_failed")
        }
        is LoginEvent.Failed -> LoginState.SignedOut(messageKey = event.messageKey)
    }
}
