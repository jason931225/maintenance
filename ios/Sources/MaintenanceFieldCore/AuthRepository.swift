import Foundation
import MaintenanceAPIClient

public protocol PasskeyCredentialProvider: Sendable {
    @MainActor
    func credentialAssertion(challengeJSON: String) async throws -> Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload
}

public struct PasskeyAuthRepository: Sendable {
    private let gateway: any MaintenanceAPIGateway
    private let credentialProvider: any PasskeyCredentialProvider
    private let sessionStore: any SessionTokenStore
    private let deviceIDStore: any DeviceIDStore
    private let stateMachine: LoginStateMachine
    private let appVersion: String
    private let encoder: JSONEncoder

    public init(
        gateway: any MaintenanceAPIGateway,
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
            let deviceID = await deviceIDStore.loadOrCreate()
            state = stateMachine.reduce(
                state,
                .passkeyVerified(
                    accessToken: tokens.accessToken,
                    refreshToken: tokens.refreshToken,
                    deviceID: deviceID,
                    appVersion: appVersion
                )
            )

            await sessionStore.save(AuthTokens(accessToken: tokens.accessToken, refreshToken: tokens.refreshToken))
            let device = try await gateway.registerDevice(deviceID: deviceID, appVersion: appVersion)
            return stateMachine.reduce(state, .deviceRegistered(serverDeviceID: device.id))
        } catch {
            await sessionStore.clear()
            return stateMachine.reduce(state, .failed(messageKey: "login_failed"))
        }
    }

    public func logout() async -> LoginState {
        await sessionStore.clear()
        return .signedOut()
    }
}
