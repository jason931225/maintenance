package com.maintenance.field.auth

import com.maintenance.api.client.model.DevicePlatform
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class LoginStateMachineTest {
    @Test
    fun passkeyLoginRegistersAndroidDeviceBeforeAuthenticatedState() {
        val userId = UUID.fromString("00000000-0000-0000-0000-000000000901")
        val ceremonyId = UUID.fromString("00000000-0000-0000-0000-000000000902")
        val stateMachine = LoginStateMachine()

        val awaitingCredential = stateMachine.reduce(
            LoginState.SignedOut(),
            LoginEvent.LoginChallengeReceived(
                userId = userId,
                ceremonyId = ceremonyId,
                challengeJson = "{\"challenge\":\"abc\"}",
                expiresAt = OffsetDateTime.parse("2026-06-12T09:05:00Z"),
            ),
        )
        assertEquals(LoginState.AwaitingPasskey(userId, ceremonyId, "{\"challenge\":\"abc\"}"), awaitingCredential)

        val registeringDevice = stateMachine.reduce(
            awaitingCredential,
            LoginEvent.PasskeyVerified(
                accessToken = "access.jwt",
                refreshToken = "refresh-token",
                deviceId = "device-a",
                appVersion = "0.1.0",
            ),
        )
        assertEquals(
            LoginState.RegisteringDevice(
                accessToken = "access.jwt",
                refreshToken = "refresh-token",
                deviceId = "device-a",
                platform = DevicePlatform.ANDROID,
                appVersion = "0.1.0",
            ),
            registeringDevice,
        )

        val authenticated = stateMachine.reduce(
            registeringDevice,
            LoginEvent.DeviceRegistered(
                serverDeviceId = UUID.fromString("00000000-0000-0000-0000-000000000903"),
            ),
        )

        assertIs<LoginState.Authenticated>(authenticated)
        assertEquals("access.jwt", authenticated.accessToken)
        assertEquals("refresh-token", authenticated.refreshToken)
    }

    @Test
    fun anyLoginFailureReturnsSignedOutWithMessageKey() {
        val state = LoginStateMachine().reduce(
            LoginState.AwaitingPasskey(
                userId = UUID.fromString("00000000-0000-0000-0000-000000000901"),
                ceremonyId = UUID.fromString("00000000-0000-0000-0000-000000000902"),
                challengeJson = "{}",
            ),
            LoginEvent.Failed(messageKey = "login_failed"),
        )

        assertEquals(LoginState.SignedOut(messageKey = "login_failed"), state)
    }
}
