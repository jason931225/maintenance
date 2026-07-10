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
| Offline queue | Android Room queue with ULID request IDs and `/api/v1/sync` replay | `OfflineQueueRepository` uses stable ULID-style request IDs, Core Data-backed `CoreDataMutationQueueStore`, `X-Device-Id`, per-operation applied/failed handling, and keeps mutations queued on transport failure | `swift run MaintenanceFieldCoreBehaviorTests` |
| Evidence capture/upload | CameraX captures JPEG, stages evidence, presign PUT confirm, offline retry | `CameraCaptureView` uses AVFoundation on iOS; `EvidenceRepository` stages JPEG metadata, SHA-256, presigns, PUTs, confirms, and queues uploads for retry in `FileEvidenceUploadStore` | `swift build` |
| Localization/labels | Android Korean strings and field labels | `ko.lproj/Localizable.strings` includes Android keys plus SwiftUI aliases; label helpers mirror priority/status/result/sync mappings | `swift build` |

## Verified in T3.3

| Area | Android parity target | iOS implementation | Evidence |
| --- | --- | --- | --- |
| Messenger generated gateway | Android `GeneratedMaintenanceApiGateway` maps generated messenger REST methods for threads, messages, send, read receipt, and search | `GeneratedMaintenanceAPIGateway` conforms to `MessengerGateway` and maps the same generated Swift OpenAPI operations | `./gradlew build`; `swift build`; `swift run MaintenanceFieldCoreBehaviorTests` |
| Messenger domain reducer | Android `MessengerReducer` dedupes pages/live messages, sorts messages by `sentAt`/ID, updates thread last-message state, and exposes resume cursors | Swift `MessengerReducer` mirrors the same reducer actions, dedupe ordering, last-message tracking, and `resumeCursor()` behavior | `./gradlew testDebugUnitTest --tests com.maintenance.field.data.messenger.MessengerRepositoryTest`; `swift run MaintenanceFieldCoreBehaviorTests` |
| Messenger offline direct-send queue | Android stores offline-composed messages in `messenger_outbox` Room storage and replays by calling `sendMessage`, not `/sync` | iOS stores offline-composed messages in `FileMessengerOutboxStore` and `MessengerRepository.replayPending()` direct-sends through `MessengerGateway` | `./gradlew build`; `swift run MaintenanceFieldCoreBehaviorTests` |
| Messenger native realtime clients | Android `MessengerRealtimeClient` builds an OkHttp WebSocket request with `Authorization` and `last_message_id` resume cursor | iOS `MessengerRealtimeClient` builds a `URLSessionWebSocketTask` request with `Authorization` and `last_message_id` resume cursor | `./gradlew testDebugUnitTest --tests com.maintenance.field.data.messenger.MessengerRepositoryTest`; `swift run MaintenanceFieldCoreBehaviorTests` |
| Messenger mobile UI | Android Compose exposes a Messenger tab with thread list, message pages, older-message cursor loading, FTS search, composer send-or-queue, and read receipts | SwiftUI exposes a Messenger tab with the same thread list, message pages, older-message cursor loading, FTS search, composer send-or-queue, and read receipts | `./gradlew build`; `swift build` |
| Messenger web UI | Web console uses generated REST client for thread list, message pagination, FTS search, send, read receipts, and WO-bound evidence presign upload | iOS implements equivalent messenger workflows natively through the generated Swift client and repository layer | `npm --workspace web run test`; `npm --workspace web run lint`; `npm --workspace web run build`; `swift build` |
| Messenger localization | Android messenger UI labels are backed by `strings.xml` and parity keys match iOS where shared | iOS messenger UI labels are backed by `Localizable.strings` with matching shared keys and field-label helpers | `node scripts/check-i18n.mjs`; inline CI parity checklist/string-key gate |
## Verified in T2.2

| Area | Android parity target | iOS implementation | Evidence |
| --- | --- | --- | --- |
| Location consent API | Generated client exposes status, grant, suspend, resume, withdraw, ping ingestion, and ledger export routes | `GeneratedMaintenanceAPIGateway` calls the same generated Swift operations for status, consent transitions, and ping ingestion | `npm run check:api-drift:portable`; `npm run check:api-drift:swift`; `npm run check:kotlin`; `npm run check:swift` |
| Always-visible GPS off switch | Authenticated work list, work-order detail, and evidence camera surfaces show direct GPS suspend/resume/withdraw controls, not settings-only controls | `LocationConsentSection` appears at the top of `TodayListView` and `WorkOrderDetailView` with GPS off, GPS on, withdrawal, and grant buttons | `JAVA_HOME=/Applications/Android Studio.app/Contents/jbr/Contents/Home ANDROID_HOME=/Users/jasonlee/Library/Android/sdk ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`; `swift build --package-path ios` |
| Local collection gate | `GpsCollectionState.mayCollect` requires granted consent and on-duty state before ping upload | `GPSCollectionState.mayCollect` mirrors the same rule with `.granted && onDuty` | Android `LocationConsentStateMachineTest`; `swift run --package-path ios MaintenanceFieldCoreBehaviorTests` |
| Withdrawal behavior | Client state machine makes withdrawal a non-collecting terminal eligibility state until fresh consent | iOS behavior runner verifies granted/suspended -> withdrawn and `mayCollect == false`; backend route test verifies withdrawal deletes `location_pings` and `location_collection_logs` | `DATABASE_URL=postgres://jasonlee@localhost/mnt_dev cargo test`; `swift run --package-path ios MaintenanceFieldCoreBehaviorTests` |

## Verification

- `cd ios && swift build` passed with Apple Swift 6.3.2 Command Line Tools.
- `cd ios && swift test` passed. This CLT installation has neither importable `XCTest` nor built-in `Testing`, so the SwiftPM test target is build-only.
- `cd ios && swift run MaintenanceFieldCoreBehaviorTests` passed and executes the Android-mirroring auth, mapper, and offline queue assertions.

## Readiness states

- **SwiftPM build/test:** The main CI `ios-app` job builds the Swift package and
  runs `swift test` plus `swift run MaintenanceFieldCoreBehaviorTests`. This is
  package-level build and behavior-test readiness only.
- **XcodeGen/XCUITest workflow:** `.github/workflows/ios-ui-tests.yml` installs
  XcodeGen, generates `ios/MaintenanceField.xcodeproj` from `ios/project.yml`,
  resolves packages, and runs Simulator-bound XCUITest/accessibility-audit tests.
  The generated project is a CI artifact, not a committed Xcode project or
  TestFlight packaging guarantee. Real-session coverage requires the
  `MNT_UITEST_BASE_URL` secret plus one of `MNT_UITEST_REFRESH_TOKEN` or
  `MNT_UITEST_OTP`, and the Simulator build must be entitled to the shared
  Keychain group used for session seeding (`MNT_IOS_KEYCHAIN_GROUP` is only an
  optional explicit override). Protected branch/required push contexts must set
  `MNT_UITEST_REQUIRE_REAL=1` and fail closed when those inputs or entitlements
  are missing; fork PRs or explicitly optional runs may skip session-dependent
  tests with truthful optional/skipped output and must not be cited as real
  post-login parity evidence.
- **Android Gradle Managed Device post-login E2E:** `.github/workflows/ci.yml`
  runs the `android-instrumented` job on Linux/KVM and executes
  `./gradlew fieldApi34DebugAndroidTest`. Required real-session contexts need
  `FIELD_E2E_BASE_URL` plus `FIELD_E2E_SEED_REFRESH_TOKEN`; CI exchanges the
  seed refresh token for a fresh access/refresh pair, masks the values, and
  hands them to `WorkOrderFlowTest` through the runner-local
  `FIELD_E2E_SESSION_ASSETS_DIR` androidTest asset fixture rather than GitHub
  outputs or raw Gradle CLI arguments. Protected branch/required push contexts
  must fail closed when those inputs or the refresh/fixture handoff are missing.
  Fork PRs or explicitly optional runs may skip via JUnit `Assume` only with
  truthful optional/skipped output and must not be cited as real Android
  post-login parity evidence.
- **Signing/capability validation:** `ios/Config/App.xcconfig` defaults the app
  identity to `com.maintenance.field` under Team `98Q89GFZWP` and ad-hoc signs
  the Simulator build so keychain-sharing entitlements can be exercised in tests.
  Associated Domains, distribution certificates/profiles, App Store Connect app
  registration, and production provisioning still need validation on a signed
  device/archive build.
- **TestFlight packaging:** The mobile release workflow and fastlane lane have an
  iOS/TestFlight path, but upload is not ready unless App Store Connect secrets,
  distribution signing material, `IOS_APP_IDENTIFIER`, `IOS_SCHEME`, and either
  `IOS_XCODE_PROJECT` or `IOS_XCODE_WORKSPACE` are present and point at an
  archive-capable project/workspace. The current XcodeGen UI-test project does
  not by itself prove archive/export or TestFlight readiness.
- **Production go-live:** A green SwiftPM build/test or XCUITest run is not
  production readiness. Go-live still requires the registered bundle ID, enabled
  capabilities, signing/provisioning assets, TestFlight/internal pilot evidence,
  release secrets, and operator approval captured in the release checklist.
- Generated evidence presign headers are currently emitted by the Swift OpenAPI generator as untyped `OpenAPIArrayContainer` values; the iOS repository performs presign, PUT, and confirm, but schema tightening is needed before typed header replay can be asserted in unit tests.
