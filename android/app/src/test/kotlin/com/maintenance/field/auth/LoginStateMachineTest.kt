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

    @Test
    fun deviceRegistrationFailureAfterPasskeyVerificationKeepsAuthenticatedRetryPendingState() {
        val state = LoginStateMachine().reduce(
            LoginState.RegisteringDevice(
                accessToken = "access.jwt",
                refreshToken = "refresh-token",
                deviceId = "device-a",
                platform = DevicePlatform.ANDROID,
                appVersion = "0.1.0",
            ),
            LoginEvent.DeviceRegistrationFailed(lastErrorClass = "IOException"),
        )

        val authenticated = assertIs<LoginState.Authenticated>(state)
        assertEquals("access.jwt", authenticated.accessToken)
        assertEquals("refresh-token", authenticated.refreshToken)
        val retry = assertIs<DeviceRegistrationState.RetryPending>(authenticated.deviceRegistration)
        assertEquals("device-a", retry.deviceId)
        assertEquals(DevicePlatform.ANDROID, retry.platform)
        assertEquals("0.1.0", retry.appVersion)
        assertEquals("IOException", retry.lastErrorClass)
        assertEquals(DEVICE_REGISTRATION_RETRY_PENDING_MESSAGE_KEY, retry.messageKey)
    }

    @Test
    fun successfulDeviceRegistrationRetryClearsPendingRegistrationStatus() {
        val state = LoginStateMachine().reduce(
            LoginState.Authenticated(
                accessToken = "access.jwt",
                refreshToken = "refresh-token",
                deviceRegistration = DeviceRegistrationState.RetryPending(
                    deviceId = "device-a",
                    platform = DevicePlatform.ANDROID,
                    appVersion = "0.1.0",
                    lastErrorClass = "IOException",
                ),
            ),
            LoginEvent.DeviceRegistered(
                serverDeviceId = UUID.fromString("00000000-0000-0000-0000-000000000903"),
            ),
        )

        val authenticated = assertIs<LoginState.Authenticated>(state)
        assertEquals(DeviceRegistrationState.Registered, authenticated.deviceRegistration)
    }
}
