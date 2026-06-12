# iOS Technician App Parity Checklist

Reference: Android technician app under `android/app/src`, generated Swift client under `clients/swift`, and `backend/openapi/openapi.yaml`.

## Verified in T1.7

| Area | Android parity target | iOS implementation | Evidence |
| --- | --- | --- | --- |
| Package layout | Native mobile deliverable lives under platform directory | `ios/Package.swift` builds `MaintenanceFieldCore`, `MaintenanceFieldApp`, and `MaintenanceFieldCoreBehaviorTests` | `swift build` |
| Generated API client | Android gateway uses generated client and OpenAPI routes | `GeneratedMaintenanceAPIGateway` uses `clients/swift` generated `APIProtocol`, `URLSessionTransport`, bearer middleware, `/api/v1/work-orders`, `/api/work-orders/{id}/start`, `/api/work-orders/{id}/report`, `/api/v1/sync`, `/api/v1/evidence/*`, `/api/v1/devices`, and passkey login routes | `swift build` |
| Passkey login | Credential Manager passkey login then device registration | `PasskeyAuthRepository` mirrors the login state machine; `AuthorizationPasskeyCredentialProvider` uses `ASAuthorizationController` with platform and security-key public-key assertion requests | `swift run MaintenanceFieldCoreBehaviorTests` covers the login state machine; compile covers bridge |
| Device registration | Android registers `DevicePlatform.ANDROID` with stable `X-Device-Id` | iOS registers `DevicePlatform.ios` after token issuance and persists a stable device ID in `UserDefaultsDeviceIDStore` | `swift run MaintenanceFieldCoreBehaviorTests` |
| Today list | `assigned_to=me`, limit 100, priority/due sorting, empty state | SwiftUI today list calls generated `listWorkOrders(assignedTo: "me", limit: 100, offset: 0)`, maps generated items to `TechnicianWorkOrder`, and renders empty/loading/refresh/logout states | `swift build` |
| Detail/start/report | Detail refresh, start, result chips, diagnosis/action validation, report submit | SwiftUI detail sheet supports start, result picker, diagnosis/action entry, validation, submit, and cached fallback | `swift build` |
| Generated mappers | Android `WorkOrderMappersTest` behavior | Swift mapper preserves IDs, request number, management number fallback, model, customer/site, priority/status/sync, assignees, and priority sort order | `swift run MaintenanceFieldCoreBehaviorTests` |
| Offline queue | Android Room queue with ULID request IDs and `/api/v1/sync` replay | `OfflineQueueRepository` uses stable ULID-style request IDs, Core Data-backed `CoreDataMutationQueueStore`, `X-Device-Id`, per-operation applied/failed handling, and keeps mutations pending on transport failure | `swift run MaintenanceFieldCoreBehaviorTests` |
| Evidence capture/upload | CameraX captures JPEG, stages evidence, presign PUT confirm, offline retry | `CameraCaptureView` uses AVFoundation on iOS; `EvidenceRepository` stages JPEG metadata, SHA-256, presigns, PUTs, confirms, and queues pending uploads in `FileEvidenceUploadStore` | `swift build` |
| Localization/labels | Android Korean strings and field labels | `ko.lproj/Localizable.strings` includes Android keys plus SwiftUI aliases; label helpers mirror priority/status/result/sync mappings | `swift build` |

## Verification

- `cd ios && swift build` passed with Apple Swift 6.3.2 Command Line Tools.
- `cd ios && swift test` passed. This CLT installation has neither importable `XCTest` nor built-in `Testing`, so the SwiftPM test target is build-only.
- `cd ios && swift run MaintenanceFieldCoreBehaviorTests` passed and executes the Android-mirroring auth, mapper, and offline queue assertions.

## CI/Xcode Deferred

- `xcodebuild` is not available in this worktree/toolchain, so iOS Simulator launch, app signing, entitlements, and Info.plist capability validation are CI-deferred.
- Camera permission UX and `NSCameraUsageDescription` must be validated in the Xcode project or CI packaging layer.
- Passkey associated domains/relying-party configuration must be validated on a signed iOS build with real device or simulator passkey support.
- Generated evidence presign headers are currently emitted by the Swift OpenAPI generator as untyped `OpenAPIArrayContainer` values; the iOS repository performs presign, PUT, and confirm, but schema tightening is needed before typed header replay can be asserted in unit tests.
