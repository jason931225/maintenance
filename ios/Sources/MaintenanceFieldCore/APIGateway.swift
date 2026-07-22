import Foundation
import HTTPTypes
import MaintenanceAPIClient
import OpenAPIRuntime
import OpenAPIURLSession

public enum MaintenanceGatewayError: Error, Sendable, CustomStringConvertible {
    case unexpectedResponse(String)
    case invalidUploadURL(String)
    case apiResponse(operation: String, statusCode: Int)
    case temporaryServerFailure(statusCode: Int, message: String)

    public var description: String {
        switch self {
        case let .unexpectedResponse(message): message
        case let .invalidUploadURL(url): "Invalid upload URL: \(url)"
        case let .apiResponse(operation, statusCode): "\(operation) returned HTTP \(statusCode)"
        case let .temporaryServerFailure(statusCode, message): "Temporary server failure HTTP \(statusCode): \(message)"
        }
    }

    public var isRetryable: Bool {
        switch self {
        case let .temporaryServerFailure(statusCode, _):
            Self.isRetryableHTTPStatus(statusCode)
        case .unexpectedResponse, .invalidUploadURL, .apiResponse:
            false
        }
    }

    public static func isRetryableHTTPStatus(_ statusCode: Int) -> Bool {
        statusCode == 408 || statusCode == 429 || (500..<600).contains(statusCode)
    }
}

public protocol PasskeyAuthGateway: Sendable {
    func startPasskeyLogin() async throws -> Components.Schemas.PasskeyLoginStartResponse
    func finishPasskeyLogin(ceremonyID: Components.Schemas.Uuid, credential: Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload) async throws -> Components.Schemas.TokenPairResponse
    func registerDevice(deviceID: String, appVersion: String) async throws -> Components.Schemas.DeviceRegistrationResponse
}

/// Performs a refresh request without passing through authenticated middleware.
public protocol TokenRefreshGateway: Sendable {
    func refresh(using refreshToken: String) async throws -> AuthTokens
}

public enum SessionRefreshError: Error, Sendable, Equatable {
    /// The refresh token was rejected, reused, or the server omitted its rotated replacement.
    case invalidSession
}

/// Serializes token rotation so concurrent 401 responses never reuse a refresh token.
public actor RotatingTokenRefresher {
    private let gateway: any TokenRefreshGateway
    private let sessionStore: any SessionTokenStore
    private let tokenProvider: CurrentTokenProvider
    private let clock: any FieldClock
    private let refreshLeeway: TimeInterval
    private var inFlight: Task<AuthTokens, Error>?

    public init(
        gateway: any TokenRefreshGateway,
        sessionStore: any SessionTokenStore,
        tokenProvider: CurrentTokenProvider,
        clock: any FieldClock = SystemFieldClock(),
        refreshLeeway: TimeInterval = 60
    ) {
        self.gateway = gateway
        self.sessionStore = sessionStore
        self.tokenProvider = tokenProvider
        self.clock = clock
        self.refreshLeeway = refreshLeeway
    }

    public func refresh() async throws -> AuthTokens {
        if let inFlight {
            return try await inFlight.value
        }

        let gateway = self.gateway
        let sessionStore = self.sessionStore
        let tokenProvider = self.tokenProvider
        let task = Task {
            guard let current = try await sessionStore.consumeForRefresh() else {
                try await sessionStore.clear()
                tokenProvider.set(nil)
                throw SessionRefreshError.invalidSession
            }
            do {
                let rotated = try await gateway.refresh(using: current.refreshToken)
                try await sessionStore.save(rotated)
                tokenProvider.set(rotated.accessToken)
                return rotated
            } catch {
                try await sessionStore.clear()
                tokenProvider.set(nil)
                throw error
            }
        }
        inFlight = task
        defer { inFlight = nil }
        return try await task.value
    }

    /// Arbitrates a 401 using the actor's current rotation state. A request that
    /// raced with token consumption waits for the same rotation rather than
    /// treating the temporarily-cleared provider as a terminal signed-out state.
    public func recover(afterRejectedAccessToken rejectedAccessToken: String?) async throws -> String? {
        if let inFlight {
            return try await inFlight.value.accessToken
        }
        guard let currentAccessToken = tokenProvider.get(), !currentAccessToken.isEmpty else {
            return nil
        }
        if rejectedAccessToken != currentAccessToken {
            return currentAccessToken
        }
        return (try await refresh()).accessToken
    }

    public func requiresProactiveRefresh(accessToken: String) -> Bool {
        guard let expiration = Self.jwtExpiration(accessToken) else { return false }
        return expiration.timeIntervalSince(clock.now()) <= refreshLeeway
    }

    public func clearSession() async throws {
        try await sessionStore.clear()
        tokenProvider.set(nil)
    }

    private static func jwtExpiration(_ accessToken: String) -> Date? {
        let segments = accessToken.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3 else { return nil }
        var encodedPayload = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        encodedPayload.append(contentsOf: String(repeating: "=", count: (4 - encodedPayload.count % 4) % 4))
        guard
            let data = Data(base64Encoded: encodedPayload),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let expiration = payload["exp"] as? NSNumber
        else {
            return nil
        }
        return Date(timeIntervalSince1970: expiration.doubleValue)
    }
}

public struct GeneratedTokenRefreshGateway: TokenRefreshGateway {
    private let client: any APIProtocol

    public init(client: any APIProtocol) {
        self.client = client
    }

    public func refresh(using refreshToken: String) async throws -> AuthTokens {
        let output = try await client.postApiV1AuthTokenRefresh(
            body: .json(Components.Schemas.RefreshTokenRequest(refreshToken: refreshToken))
        )
        switch output {
        case let .ok(response):
            let tokens = try response.body.json
            guard let refreshToken = tokens.refreshToken, !refreshToken.isEmpty else {
                throw SessionRefreshError.invalidSession
            }
            return AuthTokens(accessToken: tokens.accessToken, refreshToken: refreshToken)
        case .unauthorized:
            throw SessionRefreshError.invalidSession
        case let .undocumented(statusCode, _) where statusCode == 401:
            throw SessionRefreshError.invalidSession
        case let .undocumented(statusCode, _):
            throw MaintenanceGatewayError.apiResponse(operation: "refreshToken", statusCode: statusCode)
        case .tooManyRequests:
            throw MaintenanceGatewayError.apiResponse(operation: "refreshToken", statusCode: 429)
        }
    }
}

public protocol PasskeyStepUpGateway: Sendable {
    func startMobilePasskeyStepUp(
        binding: Components.Schemas.MobilePasskeyStepUpBinding
    ) async throws -> Components.Schemas.MobilePasskeyStepUpStartResponse
}

public protocol MaintenanceAPIGateway: SyncGateway, MessengerGateway, MobileOperationsGateway, PasskeyStepUpGateway {
    func listTodayWorkOrders() async throws -> [TechnicianWorkOrder]
    func getWorkOrderDetail(id: Components.Schemas.Uuid) async throws -> TechnicianWorkOrder
    func startWorkOrder(id: Components.Schemas.Uuid) async throws
    func submitReport(id: Components.Schemas.Uuid, draft: ReportDraft) async throws
    func presignEvidence(_ request: Components.Schemas.EvidencePresignRequest) async throws -> Components.Schemas.EvidencePresignResponse
    func confirmEvidence(evidenceID: Components.Schemas.Uuid) async throws -> Components.Schemas.EvidenceConfirmResponse
    func getLocationConsentStatus() async throws -> Components.Schemas.LocationConsentStatus
    func grantLocationConsent() async throws -> Components.Schemas.LocationConsentStatus
    func suspendLocationConsent() async throws -> Components.Schemas.LocationConsentStatus
    func resumeLocationConsent() async throws -> Components.Schemas.LocationConsentStatus
    func withdrawLocationConsent() async throws -> Components.Schemas.LocationConsentStatus
    func recordLocationPing(_ request: Components.Schemas.LocationPingRequest) async throws
}

public struct GeneratedMaintenanceAPIGateway: MaintenanceAPIGateway, PasskeyAuthGateway {
    private let client: any APIProtocol
    private let bootstrapClient: (any APIProtocol)?

    public init(client: any APIProtocol) {
        self.client = client
        self.bootstrapClient = nil
    }

    public init(serverURL: URL, tokenProvider: CurrentTokenProvider) {
        self.init(
            serverURL: serverURL,
            tokenProvider: tokenProvider,
            sessionStore: KeychainSessionTokenStore(tokenProvider: tokenProvider)
        )
    }

    public init(
        serverURL: URL,
        tokenProvider: CurrentTokenProvider,
        sessionStore: any SessionTokenStore,
        transport: any ClientTransport = URLSessionTransport(),
        clock: any FieldClock = SystemFieldClock()
    ) {
        let refreshClient = Client(
            serverURL: serverURL,
            transport: transport
        )
        let refresher = RotatingTokenRefresher(
            gateway: GeneratedTokenRefreshGateway(client: refreshClient),
            sessionStore: sessionStore,
            tokenProvider: tokenProvider,
            clock: clock
        )
        self.client = Client(
            serverURL: serverURL,
            transport: transport,
            middlewares: [
                BearerAuthMiddleware(tokenProvider: tokenProvider),
                RefreshingAuthMiddleware(tokenProvider: tokenProvider, refresher: refresher),
            ]
        )
        self.bootstrapClient = refreshClient
    }

    public func listTodayWorkOrders() async throws -> [TechnicianWorkOrder] {
        let output = try await client.listWorkOrders(
            query: Operations.ListWorkOrders.Input.Query(assignedTo: "me", limit: 100, offset: 0)
        )
        let page = try output.ok.body.json
        return page.items
            .map { $0.toTechnicianWorkOrder(syncState: .synced) }
            .sorted { lhs, rhs in
                if lhs.prioritySort != rhs.prioritySort {
                    return lhs.prioritySort < rhs.prioritySort
                }
                return (lhs.targetDueAt ?? lhs.createdAt) < (rhs.targetDueAt ?? rhs.createdAt)
            }
    }

    public func getWorkOrderDetail(id: Components.Schemas.Uuid) async throws -> TechnicianWorkOrder {
        let output = try await client.getWorkOrderDetail(
            path: Operations.GetWorkOrderDetail.Input.Path(workOrderId: id)
        )
        return try output.ok.body.json.toTechnicianWorkOrder(syncState: .synced)
    }

    public func startWorkOrder(id: Components.Schemas.Uuid) async throws {
        let output = try await client.startWorkOrder(
            path: Operations.StartWorkOrder.Input.Path(workOrderId: id)
        )
        switch output {
        case let .ok(response):
            _ = try response.body.json
        case let .undocumented(statusCode, _):
            throw MaintenanceGatewayError.apiResponse(operation: "startWorkOrder", statusCode: statusCode)
        }
    }

    public func submitReport(id: Components.Schemas.Uuid, draft: ReportDraft) async throws {
        let output = try await client.submitWorkOrderReport(
            path: Operations.SubmitWorkOrderReport.Input.Path(workOrderId: id),
            body: .json(draft.toSubmitReportRequest())
        )
        switch output {
        case let .ok(response):
            _ = try response.body.json
        case let .undocumented(statusCode, _):
            throw MaintenanceGatewayError.apiResponse(operation: "submitWorkOrderReport", statusCode: statusCode)
        }
    }

    public func replay(
        deviceID: String,
        request: Components.Schemas.SyncBatchRequest
    ) async throws -> Components.Schemas.SyncBatchResponse {
        let output = try await client.replayOfflineSyncBatch(
            headers: Operations.ReplayOfflineSyncBatch.Input.Headers(xDeviceId: deviceID),
            body: .json(request)
        )
        return try output.ok.body.json
    }

    // Usernameless (discoverable) login: the spec's POST /api/v1/auth/passkey/login/start
    // takes no request body — the user is resolved from the asserted credential at finish.
    public func startPasskeyLogin() async throws -> Components.Schemas.PasskeyLoginStartResponse {
        let output = try await (bootstrapClient ?? client).postApiV1AuthPasskeyLoginStart()
        return try output.ok.body.json
    }

    public func finishPasskeyLogin(
        ceremonyID: Components.Schemas.Uuid,
        credential: Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload
    ) async throws -> Components.Schemas.TokenPairResponse {
        let output = try await (bootstrapClient ?? client).postApiV1AuthPasskeyLoginFinish(
            body: .json(Components.Schemas.PasskeyLoginFinishRequest(ceremonyId: ceremonyID, credential: credential))
        )
        return try output.ok.body.json
    }

    public func registerDevice(deviceID: String, appVersion: String) async throws -> Components.Schemas.DeviceRegistrationResponse {
        try await registerDevice(deviceID: deviceID, appVersion: appVersion, pushToken: nil)
    }

    public func startMobilePasskeyStepUp(
        binding: Components.Schemas.MobilePasskeyStepUpBinding
    ) async throws -> Components.Schemas.MobilePasskeyStepUpStartResponse {
        let output = try await client.startMobilePasskeyStepUp(
            body: .json(Components.Schemas.MobilePasskeyStepUpStartRequest(binding: binding))
        )
        return try output.ok.body.json
    }

    public func registerDevice(
        deviceID: String,
        appVersion: String,
        pushToken: String?
    ) async throws -> Components.Schemas.DeviceRegistrationResponse {
        let output = try await client.registerMobileDevice(
            headers: Operations.RegisterMobileDevice.Input.Headers(xDeviceId: deviceID),
            body: .json(Components.Schemas.DeviceRegistrationRequest(platform: .ios, pushToken: pushToken, appVersion: appVersion))
        )
        return try output.ok.body.json
    }

    public func listApprovalItems(limit: Int64, offset: Int64) async throws -> Components.Schemas.ApprovalItemsPage {
        let output = try await client.listApprovalItems(
            query: Operations.ListApprovalItems.Input.Query(limit: limit, offset: offset)
        )
        return try output.ok.body.json
    }

    public func approveWorkOrder(
        workOrderID: Components.Schemas.Uuid,
        comment: String,
        stepUp: Components.Schemas.MobilePasskeyStepUpEnvelope
    ) async throws {
        let output = try await client.approveMobileWorkOrder(
            path: Operations.ApproveMobileWorkOrder.Input.Path(workOrderId: workOrderID),
            body: .json(Components.Schemas.MobileApproveWorkOrderRequest(comment: comment, stepUp: stepUp))
        )
        _ = try output.ok.body.json
    }

    public func listMailFolders() async throws -> [Components.Schemas.MailFolderView] {
        let output = try await client.listMailFolders()
        return try output.ok.body.json
    }

    public func listMailThreads(
        unread: Bool?,
        query: String?,
        folderID: Components.Schemas.Uuid?,
        before: Int64?,
        limit: Int64
    ) async throws -> [Components.Schemas.MailThreadView] {
        let output = try await client.listMailThreads(
            query: Operations.ListMailThreads.Input.Query(
                unread: unread,
                q: query,
                folder: folderID,
                before: before,
                limit: limit
            )
        )
        return try output.ok.body.json
    }

    public func setMailThreadReadState(threadID: Components.Schemas.Uuid, seen: Bool) async throws {
        let output = try await client.setMailThreadReadState(
            path: Operations.SetMailThreadReadState.Input.Path(id: threadID),
            body: .json(Components.Schemas.MailThreadReadStateRequest(seen: seen))
        )
        _ = try output.noContent
    }

    public func listCalendarEvents(
        from: Components.Schemas.Timestamp?,
        to: Components.Schemas.Timestamp?,
        limit: Int64
    ) async throws -> [Components.Schemas.CalendarEventResponse] {
        let output = try await client.listCollaborationCalendarEvents(
            query: Operations.ListCollaborationCalendarEvents.Input.Query(from: from, to: to, limit: limit)
        )
        return try output.ok.body.json.items
    }

    public func listPolls(
        status: Components.Schemas.PollStatus?,
        limit: Int64
    ) async throws -> [Components.Schemas.PollResponse] {
        let output = try await client.listCollaborationPolls(
            query: Operations.ListCollaborationPolls.Input.Query(status: status, limit: limit)
        )
        return try output.ok.body.json.items
    }

    public func votePoll(
        pollID: Components.Schemas.Uuid,
        selectedOptionIDs: [Components.Schemas.Uuid],
        stepUp: Components.Schemas.MobilePasskeyStepUpEnvelope
    ) async throws -> Components.Schemas.PollResponse {
        let output = try await client.voteMobileCollaborationPoll(
            path: Operations.VoteMobileCollaborationPoll.Input.Path(id: pollID),
            body: .json(Components.Schemas.MobileVotePollRequest(selectedOptionIds: selectedOptionIDs, stepUp: stepUp))
        )
        return try output.ok.body.json
    }

    public func presignEvidence(_ request: Components.Schemas.EvidencePresignRequest) async throws -> Components.Schemas.EvidencePresignResponse {
        let output = try await client.presignEvidenceUpload(body: .json(request))
        switch output {
        case let .ok(response):
            return try response.body.json
        case let .serviceUnavailable(response):
            let message = (try? response.body.json.error.message) ?? "evidence presign returned HTTP 503"
            throw MaintenanceGatewayError.temporaryServerFailure(statusCode: 503, message: message)
        case let .undocumented(statusCode, _) where MaintenanceGatewayError.isRetryableHTTPStatus(statusCode):
            throw MaintenanceGatewayError.temporaryServerFailure(
                statusCode: statusCode,
                message: "evidence presign returned HTTP \(statusCode)"
            )
        default:
            throw MaintenanceGatewayError.unexpectedResponse("evidence presign returned \(String(describing: output))")
        }
    }

    public func confirmEvidence(evidenceID: Components.Schemas.Uuid) async throws -> Components.Schemas.EvidenceConfirmResponse {
        let output = try await client.confirmEvidenceUpload(
            path: Operations.ConfirmEvidenceUpload.Input.Path(evidenceId: evidenceID)
        )
        switch output {
        case let .ok(response):
            return try response.body.json
        case let .serviceUnavailable(response):
            let message = (try? response.body.json.error.message) ?? "evidence confirm returned HTTP 503"
            throw MaintenanceGatewayError.temporaryServerFailure(statusCode: 503, message: message)
        case let .undocumented(statusCode, _) where MaintenanceGatewayError.isRetryableHTTPStatus(statusCode):
            throw MaintenanceGatewayError.temporaryServerFailure(
                statusCode: statusCode,
                message: "evidence confirm returned HTTP \(statusCode)"
            )
        default:
            throw MaintenanceGatewayError.unexpectedResponse("evidence confirm returned \(String(describing: output))")
        }
    }

    public func listThreads(limit: Int64 = 50) async throws -> [MessengerThread] {
        let output = try await client.listMessengerThreads(
            query: Operations.ListMessengerThreads.Input.Query(limit: limit)
        )
        return try output.ok.body.json.items.map { $0.toMessengerThread() }
    }

    public func listMessages(
        threadID: Components.Schemas.Uuid,
        beforeMessageID: Components.Schemas.Uuid? = nil,
        limit: Int64 = 50
    ) async throws -> MessengerMessagePage {
        let output = try await client.listMessengerMessages(
            path: Operations.ListMessengerMessages.Input.Path(threadId: threadID),
            query: Operations.ListMessengerMessages.Input.Query(
                beforeMessageId: beforeMessageID,
                limit: limit
            )
        )
        let page = try output.ok.body.json
        return MessengerMessagePage(
            items: page.items.map { $0.toMessengerMessage() },
            nextCursor: page.nextCursor
        )
    }

    public func sendMessage(
        threadID: Components.Schemas.Uuid,
        body: String,
        attachmentEvidenceIDs: [Components.Schemas.Uuid]
    ) async throws -> MessengerMessage {
        let output = try await client.sendMessengerMessage(
            path: Operations.SendMessengerMessage.Input.Path(threadId: threadID),
            body: .json(
                Components.Schemas.SendMessengerMessageRequest(
                    body: body,
                    attachmentEvidenceIds: attachmentEvidenceIDs
                )
            )
        )
        return try output.created.body.json.toMessengerMessage()
    }

    public func markRead(
        threadID: Components.Schemas.Uuid,
        lastReadMessageID: Components.Schemas.Uuid
    ) async throws {
        let output = try await client.markMessengerThreadRead(
            path: Operations.MarkMessengerThreadRead.Input.Path(threadId: threadID),
            body: .json(Components.Schemas.MarkMessengerThreadReadRequest(lastReadMessageId: lastReadMessageID))
        )
        _ = try output.ok.body.json
    }

    public func search(query: String, limit: Int64 = 50) async throws -> [MessengerMessage] {
        let output = try await client.searchMessengerMessages(
            query: Operations.SearchMessengerMessages.Input.Query(q: query, limit: limit)
        )
        return try output.ok.body.json.items.map { $0.toMessengerMessage() }
    }

    public func getLocationConsentStatus() async throws -> Components.Schemas.LocationConsentStatus {
        let output = try await client.getLocationConsentStatus()
        return try output.ok.body.json
    }

    public func grantLocationConsent() async throws -> Components.Schemas.LocationConsentStatus {
        let output = try await client.grantLocationConsent(
            body: .json(Components.Schemas.LocationConsentTransitionRequest())
        )
        return try output.ok.body.json
    }

    public func suspendLocationConsent() async throws -> Components.Schemas.LocationConsentStatus {
        let output = try await client.suspendLocationConsent(
            body: .json(Components.Schemas.LocationConsentTransitionRequest())
        )
        return try output.ok.body.json
    }

    public func resumeLocationConsent() async throws -> Components.Schemas.LocationConsentStatus {
        let output = try await client.resumeLocationConsent(
            body: .json(Components.Schemas.LocationConsentTransitionRequest())
        )
        return try output.ok.body.json
    }

    public func withdrawLocationConsent() async throws -> Components.Schemas.LocationConsentStatus {
        let output = try await client.withdrawLocationConsent(
            body: .json(Components.Schemas.LocationConsentTransitionRequest())
        )
        return try output.ok.body.json
    }

    public func recordLocationPing(_ request: Components.Schemas.LocationPingRequest) async throws {
        let output = try await client.recordLocationPing(body: .json(request))
        _ = try output.noContent
    }
}

public struct BearerAuthMiddleware: ClientMiddleware {
    private let tokenProvider: CurrentTokenProvider

    public init(tokenProvider: CurrentTokenProvider) {
        self.tokenProvider = tokenProvider
    }

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        if let accessToken = tokenProvider.get(), accessToken.isEmpty == false {
            request.headerFields[.authorization] = "Bearer \(accessToken)"
        }
        return try await next(request, body, baseURL)
    }
}

/// Retries a failed authenticated request once after the shared token rotation completes.
public struct RefreshingAuthMiddleware: ClientMiddleware {
    private let tokenProvider: CurrentTokenProvider
    private let refresher: RotatingTokenRefresher

    public init(tokenProvider: CurrentTokenProvider, refresher: RotatingTokenRefresher) {
        self.tokenProvider = tokenProvider
        self.refresher = refresher
    }

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        if let accessToken = tokenProvider.get(), await refresher.requiresProactiveRefresh(accessToken: accessToken) {
            _ = try await refresher.refresh()
            if let freshAccessToken = tokenProvider.get(), !freshAccessToken.isEmpty {
                request.headerFields[.authorization] = "Bearer \(freshAccessToken)"
            }
        }

        let response = try await next(request, body, baseURL)
        guard response.0.status.code == 401 else {
            return response
        }

        guard body?.iterationBehavior != .single else {
            return response
        }

        let rejectedAccessToken = Self.accessToken(from: request.headerFields[.authorization])
        guard let retryAccessToken = try await refresher.recover(afterRejectedAccessToken: rejectedAccessToken) else {
            return response
        }
        var retry = request
        retry.headerFields[.authorization] = "Bearer \(retryAccessToken)"
        let retried = try await next(retry, body, baseURL)
        if retried.0.status.code == 401 {
            try await refresher.clearSession()
        }
        return retried
    }

    private static func accessToken(from authorization: String?) -> String? {
        guard let authorization, authorization.hasPrefix("Bearer ") else { return nil }
        return String(authorization.dropFirst("Bearer ".count))
    }
}
