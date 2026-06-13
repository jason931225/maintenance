import Foundation
import HTTPTypes
import MaintenanceAPIClient
import OpenAPIRuntime
import OpenAPIURLSession

public enum MaintenanceGatewayError: Error, Sendable, CustomStringConvertible {
    case unexpectedResponse(String)
    case invalidUploadURL(String)

    public var description: String {
        switch self {
        case let .unexpectedResponse(message): message
        case let .invalidUploadURL(url): "Invalid upload URL: \(url)"
        }
    }
}

public protocol MaintenanceAPIGateway: SyncGateway, MessengerGateway {
    func listTodayWorkOrders() async throws -> [TechnicianWorkOrder]
    func getWorkOrderDetail(id: Components.Schemas.Uuid) async throws -> TechnicianWorkOrder
    func startWorkOrder(id: Components.Schemas.Uuid) async throws
    func submitReport(id: Components.Schemas.Uuid, draft: ReportDraft) async throws
    func startPasskeyLogin(userID: Components.Schemas.Uuid) async throws -> Components.Schemas.PasskeyLoginStartResponse
    func finishPasskeyLogin(ceremonyID: Components.Schemas.Uuid, credential: Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload) async throws -> Components.Schemas.TokenPairResponse
    func registerDevice(deviceID: String, appVersion: String) async throws -> Components.Schemas.DeviceRegistrationResponse
    func presignEvidence(_ request: Components.Schemas.EvidencePresignRequest) async throws -> Components.Schemas.EvidencePresignResponse
    func confirmEvidence(evidenceID: Components.Schemas.Uuid) async throws -> Components.Schemas.EvidenceConfirmResponse
    func getLocationConsentStatus() async throws -> Components.Schemas.LocationConsentStatus
    func grantLocationConsent() async throws -> Components.Schemas.LocationConsentStatus
    func suspendLocationConsent() async throws -> Components.Schemas.LocationConsentStatus
    func resumeLocationConsent() async throws -> Components.Schemas.LocationConsentStatus
    func withdrawLocationConsent() async throws -> Components.Schemas.LocationConsentStatus
    func recordLocationPing(_ request: Components.Schemas.LocationPingRequest) async throws
}

public struct GeneratedMaintenanceAPIGateway: MaintenanceAPIGateway {
    private let client: any APIProtocol

    public init(client: any APIProtocol) {
        self.client = client
    }

    public init(serverURL: URL, tokenProvider: CurrentTokenProvider) {
        self.client = Client(
            serverURL: serverURL,
            transport: URLSessionTransport(),
            middlewares: [BearerAuthMiddleware(tokenProvider: tokenProvider)]
        )
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
        _ = try output.ok.body.json
    }

    public func submitReport(id: Components.Schemas.Uuid, draft: ReportDraft) async throws {
        let output = try await client.submitWorkOrderReport(
            path: Operations.SubmitWorkOrderReport.Input.Path(workOrderId: id),
            body: .json(draft.toSubmitReportRequest())
        )
        _ = try output.ok.body.json
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

    public func startPasskeyLogin(userID: Components.Schemas.Uuid) async throws -> Components.Schemas.PasskeyLoginStartResponse {
        let output = try await client.postApiV1AuthPasskeyLoginStart(
            body: .json(Components.Schemas.PasskeyLoginStartRequest(userId: userID))
        )
        return try output.ok.body.json
    }

    public func finishPasskeyLogin(
        ceremonyID: Components.Schemas.Uuid,
        credential: Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload
    ) async throws -> Components.Schemas.TokenPairResponse {
        let output = try await client.postApiV1AuthPasskeyLoginFinish(
            body: .json(Components.Schemas.PasskeyLoginFinishRequest(ceremonyId: ceremonyID, credential: credential))
        )
        return try output.ok.body.json
    }

    public func registerDevice(deviceID: String, appVersion: String) async throws -> Components.Schemas.DeviceRegistrationResponse {
        let output = try await client.registerMobileDevice(
            headers: Operations.RegisterMobileDevice.Input.Headers(xDeviceId: deviceID),
            body: .json(Components.Schemas.DeviceRegistrationRequest(platform: .ios, appVersion: appVersion))
        )
        return try output.ok.body.json
    }

    public func presignEvidence(_ request: Components.Schemas.EvidencePresignRequest) async throws -> Components.Schemas.EvidencePresignResponse {
        let output = try await client.presignEvidenceUpload(body: .json(request))
        return try output.ok.body.json
    }

    public func confirmEvidence(evidenceID: Components.Schemas.Uuid) async throws -> Components.Schemas.EvidenceConfirmResponse {
        let output = try await client.confirmEvidenceUpload(
            path: Operations.ConfirmEvidenceUpload.Input.Path(evidenceId: evidenceID)
        )
        return try output.ok.body.json
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
