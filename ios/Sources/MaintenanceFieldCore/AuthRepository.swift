import Foundation
import MaintenanceAPIClient

public protocol PasskeyCredentialProvider: Sendable {
    @MainActor
    func credentialAssertion(challengeJSON: String) async throws -> Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload
}

public struct PasskeyAuthRepository: Sendable {
    private let gateway: any PasskeyAuthGateway
    private let credentialProvider: any PasskeyCredentialProvider
    private let sessionStore: any SessionTokenStore
    private let deviceIDStore: any DeviceIDStore
    private let stateMachine: LoginStateMachine
    private let appVersion: String
    private let encoder: JSONEncoder

    public init(
        gateway: any PasskeyAuthGateway,
        credentialProvider: any PasskeyCredentialProvider,
        sessionStore: any SessionTokenStore,
        deviceIDStore: any DeviceIDStore,
        stateMachine: LoginStateMachine = LoginStateMachine(),
        appVersion: String
    ) {
        self.gateway = gateway
        self.credentialProvider = credentialProvider
        self.sessionStore = sessionStore
        self.deviceIDStore = deviceIDStore
        self.stateMachine = stateMachine
        self.appVersion = appVersion
        self.encoder = JSONEncoder()
    }

    public func restore() async -> LoginState {
        guard let tokens = await sessionStore.load() else {
            return .signedOut()
        }
        return .authenticated(accessToken: tokens.accessToken, refreshToken: tokens.refreshToken)
    }

    public func login(userID: Components.Schemas.Uuid) async -> LoginState {
        var state = LoginState.signedOut()
        let deviceID: String
        do {
            let challenge = try await gateway.startPasskeyLogin()
            let challengeJSON = String(data: try encoder.encode(challenge.challenge), encoding: .utf8) ?? "{}"
            state = stateMachine.reduce(
                state,
                .loginChallengeReceived(
                    userID: userID,
                    ceremonyID: challenge.ceremonyId,
                    challengeJSON: challengeJSON,
                    expiresAt: challenge.expiresAt
                )
            )

            let credential = try await credentialProvider.credentialAssertion(challengeJSON: challengeJSON)
            let tokens = try await gateway.finishPasskeyLogin(ceremonyID: challenge.ceremonyId, credential: credential)
            guard let refreshToken = tokens.refreshToken else {
                // Mobile uses the body token transport, which always returns a
                // refresh token (refresh_token is only null on the web cookie
                // transport). A nil here is a server contract violation — fail
                // the login gracefully instead of crashing.
                return await failedLoginState()
            }
            deviceID = await deviceIDStore.loadOrCreate()
            state = stateMachine.reduce(
                state,
                .passkeyVerified(
                    accessToken: tokens.accessToken,
                    refreshToken: refreshToken,
                    deviceID: deviceID,
                    appVersion: appVersion
                )
            )

            try await sessionStore.save(AuthTokens(accessToken: tokens.accessToken, refreshToken: refreshToken))
        } catch {
            return await failedLoginState()
        }

        do {
            let device = try await gateway.registerDevice(deviceID: deviceID, appVersion: appVersion)
            return stateMachine.reduce(state, .deviceRegistered(serverDeviceID: device.id))
        } catch {
            return stateMachine.reduce(
                state,
                .deviceRegistrationFailed(
                    messageKey: "device_registration_retry_pending",
                    lastErrorClass: Self.sanitizedErrorClass(error)
                )
            )
        }
    }

    public func logout() async throws -> LoginState {
        try await sessionStore.clear()
        return .signedOut()
    }

    private func failedLoginState() async -> LoginState {
        do {
            try await sessionStore.clear()
            return .signedOut(messageKey: "login_failed")
        } catch {
            // Keychain deletion was not proven. If credentials remain readable,
            // retain their authenticated UI state rather than rendering a login
            // screen that would contradict the restorable session.
            if let tokens = await sessionStore.load() {
                return .authenticated(
                    accessToken: tokens.accessToken,
                    refreshToken: tokens.refreshToken,
                    messageKey: "session_invalidation_failed"
                )
            }
            return .signedOut(messageKey: "session_invalidation_failed")
        }
    }

    private static func sanitizedErrorClass(_ error: any Error) -> String {
        let bridgedError = error as NSError
        if bridgedError.domain == NSURLErrorDomain {
            return "URLError"
        }
        return String(describing: type(of: error))
    }
}

public enum PasskeyStepUpError: Error, Equatable, Sendable {
    case bindingMismatch
}

public struct PasskeyStepUpRepository: Sendable {
    private let gateway: any PasskeyStepUpGateway
    private let credentialProvider: any PasskeyCredentialProvider
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(
        gateway: any PasskeyStepUpGateway,
        credentialProvider: any PasskeyCredentialProvider
    ) {
        self.gateway = gateway
        self.credentialProvider = credentialProvider
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    public func envelope(
        binding: Components.Schemas.MobilePasskeyStepUpBinding
    ) async throws -> Components.Schemas.MobilePasskeyStepUpEnvelope {
        let start = try await gateway.startMobilePasskeyStepUp(binding: binding)
        guard start.binding == binding else {
            throw PasskeyStepUpError.bindingMismatch
        }

        let challengeJSON = String(data: try encoder.encode(start.challenge), encoding: .utf8) ?? "{}"
        let loginCredential = try await credentialProvider.credentialAssertion(challengeJSON: challengeJSON)
        let credential = try decoder.decode(
            Components.Schemas.PasskeyStepUpAssertion.CredentialPayload.self,
            from: encoder.encode(loginCredential)
        )
        return Components.Schemas.MobilePasskeyStepUpEnvelope(
            binding: binding,
            assertion: Components.Schemas.PasskeyStepUpAssertion(
                ceremonyId: start.ceremonyId,
                credential: credential
            )
        )
    }
}
