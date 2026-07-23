import Foundation
import MaintenanceAPIClient

public enum DeviceRegistrationRetryStatus: String, Equatable, Sendable {
    case readyForReplay
}

public struct DeviceRegistrationRetry: Equatable, Sendable {
    public let deviceID: String
    public let platform: Components.Schemas.DevicePlatform
    public let appVersion: String
    public let pushToken: String?
    public let status: DeviceRegistrationRetryStatus
    public let messageKey: String
    public let lastErrorClass: String

    public init(
        deviceID: String,
        platform: Components.Schemas.DevicePlatform,
        appVersion: String,
        pushToken: String?,
        status: DeviceRegistrationRetryStatus,
        messageKey: String,
        lastErrorClass: String
    ) {
        self.deviceID = deviceID
        self.platform = platform
        self.appVersion = appVersion
        self.pushToken = pushToken
        self.status = status
        self.messageKey = messageKey
        self.lastErrorClass = lastErrorClass
    }
}

public enum DeviceRegistrationStatus: Equatable, Sendable {
    case registered
    case retryPending(DeviceRegistrationRetry)
}

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
    case authenticated(
        accessToken: String,
        refreshToken: String,
        deviceRegistration: DeviceRegistrationStatus = .registered,
        messageKey: String? = nil
    )
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
    case deviceRegistrationFailed(messageKey: String, lastErrorClass: String)
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

        case let .deviceRegistrationFailed(messageKey, lastErrorClass):
            switch state {
            case let .registeringDevice(accessToken, refreshToken, deviceID, platform, appVersion):
                return .authenticated(
                    accessToken: accessToken,
                    refreshToken: refreshToken,
                    deviceRegistration: .retryPending(
                        DeviceRegistrationRetry(
                            deviceID: deviceID,
                            platform: platform,
                            appVersion: appVersion,
                            pushToken: nil,
                            status: .readyForReplay,
                            messageKey: messageKey,
                            lastErrorClass: lastErrorClass
                        )
                    )
                )
            default:
                return .signedOut(messageKey: "login_failed")
            }

        case let .failed(messageKey):
            return .signedOut(messageKey: messageKey)
        }
    }
}
