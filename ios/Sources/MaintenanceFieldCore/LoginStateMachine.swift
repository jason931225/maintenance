import Foundation
import MaintenanceAPIClient

public enum LoginState: Equatable, Sendable {
    case signedOut(messageKey: String? = nil)
    case awaitingPasskey(userID: Components.Schemas.Uuid, ceremonyID: Components.Schemas.Uuid, challengeJSON: String)
    case registeringDevice(
        accessToken: String,
        refreshToken: String,
        deviceID: String,
        platform: Components.Schemas.DevicePlatform,
        appVersion: String
    )
    case authenticated(accessToken: String, refreshToken: String)
}

public enum LoginEvent: Equatable, Sendable {
    case loginChallengeReceived(
        userID: Components.Schemas.Uuid,
        ceremonyID: Components.Schemas.Uuid,
        challengeJSON: String,
        expiresAt: Date
    )
    case passkeyVerified(accessToken: String, refreshToken: String, deviceID: String, appVersion: String)
    case deviceRegistered(serverDeviceID: Components.Schemas.Uuid)
    case failed(messageKey: String)
}

public struct LoginStateMachine: Sendable {
    public init() {}

    public func reduce(_ state: LoginState, _ event: LoginEvent) -> LoginState {
        switch event {
        case let .loginChallengeReceived(userID, ceremonyID, challengeJSON, _):
            return .awaitingPasskey(userID: userID, ceremonyID: ceremonyID, challengeJSON: challengeJSON)

        case let .passkeyVerified(accessToken, refreshToken, deviceID, appVersion):
            switch state {
            case .awaitingPasskey:
                return .registeringDevice(
                    accessToken: accessToken,
                    refreshToken: refreshToken,
                    deviceID: deviceID,
                    platform: .ios,
                    appVersion: appVersion
                )
            default:
                return .signedOut(messageKey: "login_failed")
            }

        case .deviceRegistered:
            switch state {
            case let .registeringDevice(accessToken, refreshToken, _, _, _):
                return .authenticated(accessToken: accessToken, refreshToken: refreshToken)
            default:
                return .signedOut(messageKey: "login_failed")
            }

        case let .failed(messageKey):
            return .signedOut(messageKey: messageKey)
        }
    }
}
