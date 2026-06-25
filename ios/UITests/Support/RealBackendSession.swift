import Foundation
import XCTest

/// Obtains a **real** session token pair from the **real** backend — no fakes.
///
/// The passkey ceremony cannot be automated (see `E2E-MANUAL-SMOKE.md`), so the
/// suite mints a real session through one of the backend's other real,
/// non-passkey token paths. Both are genuine server flows that issue genuine
/// JWTs the backend will accept on every subsequent API call:
///
/// - **Refresh** (`POST /api/v1/auth/token/refresh`): exchange a seeded,
///   long-lived refresh token (held by CI as the `MNT_UITEST_REFRESH_TOKEN`
///   secret) for a fresh access/refresh pair. The mobile body transport is used
///   (`refresh_token` in the JSON body) so the response carries both tokens.
/// - **OTP redeem** (`POST /api/v1/auth/otp/redeem`): redeem a one-time passcode
///   (issued out-of-band by an admin) for a token pair.
///
/// Which path is used is driven entirely by CI-provided environment, so nothing
/// is hardcoded and no credential lives in the repo. If neither is configured the
/// caller throws `XCTSkip` with an actionable message — it never fabricates a
/// token.
enum RealBackendSession {
    struct TokenPair {
        let accessToken: String
        let refreshToken: String
    }

    enum SeedError: Error, CustomStringConvertible {
        case notConfigured
        case badResponse(Int, String)
        case missingTokens

        var description: String {
            switch self {
            case .notConfigured:
                return """
                No real-backend session source configured. Set MNT_UITEST_BASE_URL plus \
                either MNT_UITEST_REFRESH_TOKEN or MNT_UITEST_OTP in the UITest launch \
                environment (CI injects these from secrets). The suite refuses to fake a \
                session.
                """
            case let .badResponse(status, body):
                return "Backend returned HTTP \(status): \(body)"
            case .missingTokens:
                return "Backend response did not include both access and refresh tokens."
            }
        }
    }

    /// Reads the CI-injected configuration from the process environment.
    /// `ProcessInfo` here is the **UITest runner's** environment, which the test
    /// sets via `app.launchEnvironment` is NOT what we read — instead the runner
    /// process reads its own environment, populated by `xcodebuild test`'s
    /// environment (the CI job exports these before invoking xcodebuild).
    static func fetch(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) async throws -> TokenPair {
        guard
            let baseURLString = environment["MNT_UITEST_BASE_URL"],
            let baseURL = URL(string: baseURLString)
        else {
            throw SeedError.notConfigured
        }

        if let refreshToken = environment["MNT_UITEST_REFRESH_TOKEN"], refreshToken.isEmpty == false {
            return try await refresh(baseURL: baseURL, refreshToken: refreshToken)
        }
        if let otp = environment["MNT_UITEST_OTP"], otp.isEmpty == false {
            return try await redeemOTP(baseURL: baseURL, otp: otp)
        }
        throw SeedError.notConfigured
    }

    private static func refresh(baseURL: URL, refreshToken: String) async throws -> TokenPair {
        // Mobile body transport: refresh_token in the JSON body returns both
        // tokens in the body (the web cookie transport returns null refresh).
        let body = try JSONSerialization.data(withJSONObject: ["refresh_token": refreshToken])
        return try await post(
            url: baseURL.appendingPathComponent("api/v1/auth/token/refresh"),
            body: body
        )
    }

    private static func redeemOTP(baseURL: URL, otp: String) async throws -> TokenPair {
        let body = try JSONSerialization.data(withJSONObject: ["code": otp])
        return try await post(
            url: baseURL.appendingPathComponent("api/v1/auth/otp/redeem"),
            body: body
        )
    }

    private static func post(url: URL, body: Data) async throws -> TokenPair {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(status) else {
            throw SeedError.badResponse(status, String(data: data, encoding: .utf8) ?? "")
        }

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        // The generated client maps snake_case -> camelCase, but the wire format
        // is snake_case; accept both so this stays robust to either.
        let access = (json?["access_token"] ?? json?["accessToken"]) as? String
        let refresh = (json?["refresh_token"] ?? json?["refreshToken"]) as? String
        guard let access, let refresh, access.isEmpty == false, refresh.isEmpty == false else {
            throw SeedError.missingTokens
        }
        return TokenPair(accessToken: access, refreshToken: refresh)
    }
}
