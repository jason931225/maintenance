import CryptoKit
import Foundation
import MaintenanceAPIClient

public struct PendingEvidenceUpload: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var workOrderID: Components.Schemas.Uuid
    public var fileURL: URL
    public var contentType: String
    public var sizeBytes: Int64
    public var checksumSHA256: String
    public var syncState: SyncState
    public var lastError: String?
    public var retryAttemptCount: Int
    public var nextRetryAt: Date?

    public var isRetrying: Bool {
        syncState == .pending && lastError != nil
    }

    public func isReadyForUpload(at date: Date) -> Bool {
        guard syncState == .pending else { return false }
        guard let nextRetryAt else { return true }
        return nextRetryAt <= date
    }

    public init(
        id: String,
        workOrderID: Components.Schemas.Uuid,
        fileURL: URL,
        contentType: String,
        sizeBytes: Int64,
        checksumSHA256: String,
        syncState: SyncState = .pending,
        lastError: String? = nil,
        retryAttemptCount: Int = 0,
        nextRetryAt: Date? = nil
    ) {
        self.id = id
        self.workOrderID = workOrderID
        self.fileURL = fileURL
        self.contentType = contentType
        self.sizeBytes = sizeBytes
        self.checksumSHA256 = checksumSHA256
        self.syncState = syncState
        self.lastError = lastError
        self.retryAttemptCount = retryAttemptCount
        self.nextRetryAt = nextRetryAt
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case workOrderID
        case fileURL
        case contentType
        case sizeBytes
        case checksumSHA256
        case syncState
        case lastError
        case retryAttemptCount
        case nextRetryAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        workOrderID = try container.decode(Components.Schemas.Uuid.self, forKey: .workOrderID)
        fileURL = try container.decode(URL.self, forKey: .fileURL)
        contentType = try container.decode(String.self, forKey: .contentType)
        sizeBytes = try container.decode(Int64.self, forKey: .sizeBytes)
        checksumSHA256 = try container.decode(String.self, forKey: .checksumSHA256)
        syncState = try container.decode(SyncState.self, forKey: .syncState)
        lastError = try container.decodeIfPresent(String.self, forKey: .lastError)
        retryAttemptCount = try container.decodeIfPresent(Int.self, forKey: .retryAttemptCount) ?? 0
        nextRetryAt = try container.decodeIfPresent(Date.self, forKey: .nextRetryAt)
    }
}

public protocol EvidenceUploadStore: Sendable {
    func upsert(_ upload: PendingEvidenceUpload) async throws
    func pending() async throws -> [PendingEvidenceUpload]
    func markSynced(id: String) async throws
    func markRetrying(id: String, message: String, retryAttemptCount: Int, nextRetryAt: Date) async throws
    func markFailed(id: String, message: String) async throws
}

public struct EvidenceUploadSummary: Equatable, Sendable {
    public let attempted: Int
    public let uploaded: Int
    public let retrying: Int
    public let failed: Int

    public init(attempted: Int, uploaded: Int, retrying: Int, failed: Int) {
        self.attempted = attempted
        self.uploaded = uploaded
        self.retrying = retrying
        self.failed = failed
    }
}

public actor FileEvidenceUploadStore: EvidenceUploadStore {
    private let fileURL: URL
    private var uploads: [String: PendingEvidenceUpload]

    public init(fileURL: URL) throws {
        self.fileURL = fileURL
        if FileManager.default.fileExists(atPath: fileURL.path) {
            let data: Data
            do {
                data = try Data(contentsOf: fileURL)
            } catch {
                throw PersistenceStoreError.readFailed(
                    "evidence_upload",
                    PersistenceStoreError.sanitizedUnderlyingDescription(error)
                )
            }
            do {
                self.uploads = try JSONDecoder().decode([String: PendingEvidenceUpload].self, from: data)
            } catch {
                throw PersistenceStoreError.corruptJSON(
                    "evidence_upload",
                    PersistenceStoreError.sanitizedUnderlyingDescription(error)
                )
            }
        } else {
            self.uploads = [:]
        }
    }

    public static func defaultStoreURL() throws -> URL {
        let root = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appendingPathComponent("MaintenanceField", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root.appendingPathComponent("evidence-upload-queue.json")
    }

    public func upsert(_ upload: PendingEvidenceUpload) throws {
        var updated = uploads
        updated[upload.id] = upload
        try save(updated)
        uploads = updated
    }

    public func pending() throws -> [PendingEvidenceUpload] {
        uploads.values
            .filter { $0.syncState == .pending }
            .sorted { $0.id < $1.id }
    }

    public func markSynced(id: String) throws {
        guard var upload = uploads[id] else { return }
        upload.syncState = .synced
        upload.lastError = nil
        upload.retryAttemptCount = 0
        upload.nextRetryAt = nil
        var updated = uploads
        updated[id] = upload
        try save(updated)
        uploads = updated
    }

    public func markRetrying(id: String, message: String, retryAttemptCount: Int, nextRetryAt: Date) throws {
        guard var upload = uploads[id] else { return }
        upload.syncState = .pending
        upload.lastError = message
        upload.retryAttemptCount = retryAttemptCount
        upload.nextRetryAt = nextRetryAt
        var updated = uploads
        updated[id] = upload
        try save(updated)
        uploads = updated
    }

    public func markFailed(id: String, message: String) throws {
        guard var upload = uploads[id] else { return }
        upload.syncState = .failed
        upload.lastError = message
        upload.nextRetryAt = nil
        var updated = uploads
        updated[id] = upload
        try save(updated)
        uploads = updated
    }

    private func save(_ uploads: [String: PendingEvidenceUpload]) throws {
        let data: Data
        do {
            data = try JSONEncoder().encode(uploads)
        } catch {
            throw PersistenceStoreError.encodeFailed(
                "evidence_upload",
                PersistenceStoreError.sanitizedUnderlyingDescription(error)
            )
        }
        do {
            try data.write(to: fileURL, options: [.atomic])
        } catch {
            throw PersistenceStoreError.writeFailed(
                "evidence_upload",
                PersistenceStoreError.sanitizedUnderlyingDescription(error)
            )
        }
    }
}

public actor FileMessengerOutboxStore: MessengerOutboxStore {
    private let fileURL: URL
    private var messages: [String: QueuedMessengerMessage]

    public init(fileURL: URL) throws {
        self.fileURL = fileURL
        if FileManager.default.fileExists(atPath: fileURL.path) {
            let data: Data
            do {
                data = try Data(contentsOf: fileURL)
            } catch {
                throw PersistenceStoreError.readFailed(
                    "messenger_outbox",
                    PersistenceStoreError.sanitizedUnderlyingDescription(error)
                )
            }
            do {
                self.messages = try JSONDecoder().decode([String: QueuedMessengerMessage].self, from: data)
            } catch {
                throw PersistenceStoreError.corruptJSON(
                    "messenger_outbox",
                    PersistenceStoreError.sanitizedUnderlyingDescription(error)
                )
            }
        } else {
            self.messages = [:]
        }
    }

    public static func defaultStoreURL() throws -> URL {
        let root = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appendingPathComponent("MaintenanceField", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root.appendingPathComponent("messenger-outbox.json")
    }

    public func upsert(_ message: QueuedMessengerMessage) throws {
        var updated = messages
        updated[message.requestID] = message
        try save(updated)
        messages = updated
    }

    public func pending() throws -> [QueuedMessengerMessage] {
        messages.values
            .filter { $0.state == .pending }
            .sorted { $0.createdAt < $1.createdAt }
    }

    public func get(requestID: String) -> QueuedMessengerMessage? {
        messages[requestID]
    }

    public func markSent(requestID: String) throws {
        guard let message = messages[requestID] else { return }
        var updated = messages
        updated[requestID] = QueuedMessengerMessage(
            requestID: message.requestID,
            threadID: message.threadID,
            body: message.body,
            attachmentEvidenceIDs: message.attachmentEvidenceIDs,
            createdAt: message.createdAt,
            state: .sent,
            lastError: nil
        )
        try save(updated)
        messages = updated
    }

    public func markFailed(requestID: String, message errorMessage: String) throws {
        guard let message = messages[requestID] else { return }
        var updated = messages
        updated[requestID] = QueuedMessengerMessage(
            requestID: message.requestID,
            threadID: message.threadID,
            body: message.body,
            attachmentEvidenceIDs: message.attachmentEvidenceIDs,
            createdAt: message.createdAt,
            state: .failed,
            lastError: errorMessage
        )
        try save(updated)
        messages = updated
    }

    private func save(_ messages: [String: QueuedMessengerMessage]) throws {
        let data: Data
        do {
            data = try JSONEncoder().encode(messages)
        } catch {
            throw PersistenceStoreError.encodeFailed(
                "messenger_outbox",
                PersistenceStoreError.sanitizedUnderlyingDescription(error)
            )
        }
        do {
            try data.write(to: fileURL, options: [.atomic])
        } catch {
            throw PersistenceStoreError.writeFailed(
                "messenger_outbox",
                PersistenceStoreError.sanitizedUnderlyingDescription(error)
            )
        }
    }
}

public struct EvidenceRepository: Sendable {
    private let gateway: any MaintenanceAPIGateway
    private let store: any EvidenceUploadStore
    private let urlSession: URLSession
    private let clock: any FieldClock

    public init(
        gateway: any MaintenanceAPIGateway,
        store: any EvidenceUploadStore,
        urlSession: URLSession = .shared,
        clock: any FieldClock = SystemFieldClock()
    ) {
        self.gateway = gateway
        self.store = store
        self.urlSession = urlSession
        self.clock = clock
    }

    @discardableResult
    public func stageEvidence(
        workOrderID: Components.Schemas.Uuid,
        fileURL: URL,
        contentType: String = "image/jpeg"
    ) async throws -> String {
        let data = try Data(contentsOf: fileURL)
        let upload = PendingEvidenceUpload(
            id: UUID().uuidString.lowercased(),
            workOrderID: workOrderID,
            fileURL: fileURL,
            contentType: contentType,
            sizeBytes: Int64(data.count),
            checksumSHA256: Self.sha256Hex(data)
        )
        try await store.upsert(upload)
        return upload.id
    }

    public func uploadPending() async throws -> EvidenceUploadSummary {
        let pending = try await store.pending()
        let now = clock.now()
        let readyUploads = pending.filter { $0.isReadyForUpload(at: now) }
        var uploaded = 0
        var retrying = 0
        var failed = 0

        for upload in readyUploads {
            do {
                let data = try Data(contentsOf: upload.fileURL)
                let ticket = try await gateway.presignEvidence(
                    Components.Schemas.EvidencePresignRequest(
                        workOrderId: upload.workOrderID,
                        stage: .after,
                        contentType: upload.contentType,
                        sizeBytes: Int64(data.count),
                        checksumSha256: upload.checksumSHA256
                    )
                )
                try await putEvidence(data: data, ticket: ticket)
                _ = try await gateway.confirmEvidence(evidenceID: ticket.id)
                try await store.markSynced(id: upload.id)
                uploaded += 1
            } catch let error as PersistenceStoreError {
                throw error
            } catch {
                let message = Self.failureMessage(error)
                if Self.isRetryableUploadFailure(error) {
                    let retryAttemptCount = max(0, upload.retryAttemptCount) + 1
                    try await store.markRetrying(
                        id: upload.id,
                        message: message,
                        retryAttemptCount: retryAttemptCount,
                        nextRetryAt: now.addingTimeInterval(Self.retryDelay(forAttempt: retryAttemptCount))
                    )
                    retrying += 1
                } else {
                    try await store.markFailed(id: upload.id, message: message)
                    failed += 1
                }
            }
        }

        return EvidenceUploadSummary(
            attempted: readyUploads.count,
            uploaded: uploaded,
            retrying: retrying,
            failed: failed
        )
    }

    private func putEvidence(data: Data, ticket: Components.Schemas.EvidencePresignResponse) async throws {
        guard let url = URL(string: ticket.upload.url) else {
            throw MaintenanceGatewayError.invalidUploadURL(ticket.upload.url)
        }
        var request = URLRequest(url: url)
        request.httpMethod = ticket.upload.method.rawValue
        for header in ticket.upload.headers {
            let value = header.value
            guard value.count == 2,
                  let name = value[0] as? String,
                  let headerValue = value[1] as? String else { continue }
            request.setValue(headerValue, forHTTPHeaderField: name)
        }
        let (_, response) = try await urlSession.upload(for: request, from: data)
        if let httpResponse = response as? HTTPURLResponse,
           !(200..<300).contains(httpResponse.statusCode) {
            let message = "evidence upload returned HTTP \(httpResponse.statusCode)"
            if MaintenanceGatewayError.isRetryableHTTPStatus(httpResponse.statusCode) {
                throw MaintenanceGatewayError.temporaryServerFailure(
                    statusCode: httpResponse.statusCode,
                    message: message
                )
            }
            throw MaintenanceGatewayError.unexpectedResponse(message)
        }
    }

    private static func failureMessage(_ error: Error) -> String {
        let message = String(describing: error)
        return message.isEmpty ? "evidence upload failed" : message
    }

    private static func isRetryableUploadFailure(_ error: Error) -> Bool {
        if let gatewayError = error as? MaintenanceGatewayError {
            return gatewayError.isRetryable
        }

        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return false }
        switch URLError.Code(rawValue: nsError.code) {
        case .timedOut,
             .cannotFindHost,
             .cannotConnectToHost,
             .networkConnectionLost,
             .dnsLookupFailed,
             .notConnectedToInternet,
             .internationalRoamingOff,
             .callIsActive,
             .dataNotAllowed,
             .secureConnectionFailed,
             .cannotLoadFromNetwork,
             .backgroundSessionInUseByAnotherProcess,
             .backgroundSessionWasDisconnected:
            return true
        default:
            return false
        }
    }

    private static func retryDelay(forAttempt retryAttemptCount: Int) -> TimeInterval {
        let exponent = min(max(retryAttemptCount - 1, 0), 6)
        return min(pow(2.0, Double(exponent)) * 60, 3_600)
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
