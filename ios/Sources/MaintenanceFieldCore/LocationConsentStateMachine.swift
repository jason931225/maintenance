import Foundation
import MaintenanceAPIClient

public struct GPSCollectionState: Equatable, Sendable {
    public var consentState: Components.Schemas.LocationConsentState
    public var onDuty: Bool

    public init(
        consentState: Components.Schemas.LocationConsentState = .noRecord,
        onDuty: Bool = false
    ) {
        self.consentState = consentState
        self.onDuty = onDuty
    }

    public var mayCollect: Bool {
        consentState == .granted && onDuty
    }
}

public enum LocationConsentEvent: Equatable, Sendable {
    case granted
    case suspended
    case resumed
    case withdrawn
    case onDutyChanged(Bool)
}

public struct LocationConsentStateMachine: Sendable {
    public init() {}

    public func reduce(
        _ state: GPSCollectionState,
        event: LocationConsentEvent
    ) -> GPSCollectionState {
        switch event {
        case .granted:
            switch state.consentState {
            case .noRecord, .withdrawn:
                return GPSCollectionState(consentState: .granted, onDuty: state.onDuty)
            default:
                return state
            }
        case .suspended:
            guard state.consentState == .granted else { return state }
            return GPSCollectionState(consentState: .suspended, onDuty: state.onDuty)
        case .resumed:
            guard state.consentState == .suspended else { return state }
            return GPSCollectionState(consentState: .granted, onDuty: state.onDuty)
        case .withdrawn:
            switch state.consentState {
            case .granted, .suspended:
                return GPSCollectionState(consentState: .withdrawn, onDuty: state.onDuty)
            default:
                return state
            }
        case let .onDutyChanged(onDuty):
            return GPSCollectionState(consentState: state.consentState, onDuty: onDuty)
        }
    }
}

public struct LocationConsentRepository: Sendable {
    private let gateway: any MaintenanceAPIGateway

    public init(gateway: any MaintenanceAPIGateway) {
        self.gateway = gateway
    }

    public func status() async throws -> Components.Schemas.LocationConsentStatus {
        try await gateway.getLocationConsentStatus()
    }

    public func grant() async throws -> Components.Schemas.LocationConsentStatus {
        try await gateway.grantLocationConsent()
    }

    public func suspend() async throws -> Components.Schemas.LocationConsentStatus {
        try await gateway.suspendLocationConsent()
    }

    public func resume() async throws -> Components.Schemas.LocationConsentStatus {
        try await gateway.resumeLocationConsent()
    }

    public func withdraw() async throws -> Components.Schemas.LocationConsentStatus {
        try await gateway.withdrawLocationConsent()
    }

    @discardableResult
    public func recordPingIfAllowed(
        state: GPSCollectionState,
        latitude: Double,
        longitude: Double,
        accuracyM: Double?,
        recordedAt: Date
    ) async throws -> Bool {
        guard state.mayCollect else {
            return false
        }

        try await gateway.recordLocationPing(
            Components.Schemas.LocationPingRequest(
                latitude: latitude,
                longitude: longitude,
                accuracyM: accuracyM,
                recordedAt: recordedAt,
                onDuty: state.onDuty
            )
        )
        return true
    }
}
