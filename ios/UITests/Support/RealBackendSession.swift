import Foundation

/// Before each test-class shard, the workflow mints a fresh real access/refresh
/// pair against its isolated backend and injects both into the UI-test runner.
/// The test bundle only consumes that shard-local pair: it never redeems an OTP,
/// so each test restores the exact server-issued session the workflow prepared.
enum RealBackendSession {
    struct TokenPair {
        let accessToken: String
        let refreshToken: String
    }

    enum SeedError: Error, LocalizedError {
        case missingBaseURL
        case missingAccessToken
        case missingRefreshToken

        var errorDescription: String? {
            switch self {
            case .missingBaseURL:
                return "MNT_UITEST_BASE_URL is required for every iOS UI-test launch."
            case .missingAccessToken:
                return "MNT_UITEST_ACCESS_TOKEN is missing or empty; the workflow must mint and inject a real access token."
            case .missingRefreshToken:
                return "MNT_UITEST_REFRESH_TOKEN is missing or empty; the workflow must mint and inject its matching real refresh token."
            }
        }
    }

    static func baseURL(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> String {
        guard let value = environment["MNT_UITEST_BASE_URL"], value.isEmpty == false,
              URL(string: value) != nil
        else {
            throw SeedError.missingBaseURL
        }
        return value
    }

    static func tokens(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> TokenPair {
        let accessToken = environment["MNT_UITEST_ACCESS_TOKEN"] ?? ""
        guard accessToken.isEmpty == false else {
            throw SeedError.missingAccessToken
        }
        let refreshToken = environment["MNT_UITEST_REFRESH_TOKEN"] ?? ""
        guard refreshToken.isEmpty == false else {
            throw SeedError.missingRefreshToken
        }
        return TokenPair(accessToken: accessToken, refreshToken: refreshToken)
    }
}
