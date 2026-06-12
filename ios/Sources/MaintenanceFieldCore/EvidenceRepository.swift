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

    public init(
        id: String,
        workOrderID: Components.Schemas.Uuid,
        fileURL: URL,
        contentType: String,
        sizeBytes: Int64,
        checksumSHA256: String,
        syncState: SyncState = .pending,
        lastError: String? = nil
    ) {
        self.id = id
        self.workOrderID = workOrderID
        self.fileURL = fileURL
        self.contentType = contentType
        self.sizeBytes = sizeBytes
        self.checksumSHA256 = checksumSHA256
        self.syncState = syncState
        self.lastError = lastError
    }
}

public protocol EvidenceUploadStore: Sendable {
    func upsert(_ upload: PendingEvidenceUpload) async
    func pending() async -> [PendingEvidenceUpload]
    func markSynced(id: String) async
    func markFailed(id: String, message: String) async
}

public actor FileEvidenceUploadStore: EvidenceUploadStore {
    private let fileURL: URL
    private var uploads: [String: PendingEvidenceUpload]

    public init(fileURL: URL) throws {
        self.fileURL = fileURL
        if let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode([String: PendingEvidenceUpload].self, from: data) {
            self.uploads = decoded
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

    public func upsert(_ upload: PendingEvidenceUpload) {
        uploads[upload.id] = upload
        save()
    }

    public func pending() -> [PendingEvidenceUpload] {
        uploads.values
            .filter { $0.syncState == .pending }
            .sorted { $0.id < $1.id }
    }

    public func markSynced(id: String) {
        uploads[id]?.syncState = .synced
        uploads[id]?.lastError = nil
        save()
    }

    public func markFailed(id: String, message: String) {
        uploads[id]?.syncState = .failed
        uploads[id]?.lastError = message
        save()
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(uploads) else { return }
        try? data.write(to: fileURL, options: [.atomic])
    }
}

public struct EvidenceRepository: Sendable {
    private let gateway: any MaintenanceAPIGateway
    private let store: any EvidenceUploadStore
    private let urlSession: URLSession

    public init(
        gateway: any MaintenanceAPIGateway,
        store: any EvidenceUploadStore,
        urlSession: URLSession = .shared
    ) {
        self.gateway = gateway
        self.store = store
        self.urlSession = urlSession
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
        await store.upsert(upload)
        return upload.id
    }

    public func uploadPending() async -> (attempted: Int, uploaded: Int, failed: Int) {
        let pending = await store.pending()
        var uploaded = 0
        var failed = 0

        for upload in pending {
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
                await store.markSynced(id: upload.id)
                uploaded += 1
            } catch {
                await store.markFailed(id: upload.id, message: String(describing: error))
                failed += 1
            }
        }

        return (attempted: pending.count, uploaded: uploaded, failed: failed)
    }

    private func putEvidence(data: Data, ticket: Components.Schemas.EvidencePresignResponse) async throws {
        guard let url = URL(string: ticket.upload.url) else {
            throw MaintenanceGatewayError.invalidUploadURL(ticket.upload.url)
        }
        var request = URLRequest(url: url)
        request.httpMethod = ticket.upload.method.rawValue
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await urlSession.upload(for: request, from: data)
        if let httpResponse = response as? HTTPURLResponse,
           !(200..<300).contains(httpResponse.statusCode) {
            throw MaintenanceGatewayError.unexpectedResponse("evidence upload returned HTTP \(httpResponse.statusCode)")
        }
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
