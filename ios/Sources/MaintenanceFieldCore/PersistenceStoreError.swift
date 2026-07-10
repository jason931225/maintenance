import Foundation

public enum PersistenceStoreError: Error, Sendable, Equatable, CustomStringConvertible {
    case readFailed(String, String)
    case corruptJSON(String, String)
    case encodeFailed(String, String)
    case writeFailed(String, String)
    case fetchFailed(String, String)
    case saveFailed(String, String)

    public var description: String {
        switch self {
        case let .readFailed(store, underlying):
            return "\(store) read failed: \(underlying)"
        case let .corruptJSON(store, underlying):
            return "\(store) contains corrupt JSON: \(underlying)"
        case let .encodeFailed(store, underlying):
            return "\(store) encode failed: \(underlying)"
        case let .writeFailed(store, underlying):
            return "\(store) write failed: \(underlying)"
        case let .fetchFailed(store, underlying):
            return "\(store) fetch failed: \(underlying)"
        case let .saveFailed(store, underlying):
            return "\(store) save failed: \(underlying)"
        }
    }

    public static func sanitizedUnderlyingDescription(_ error: Error) -> String {
        let nsError = error as NSError
        return "\(nsError.domain):\(nsError.code)"
    }
}
