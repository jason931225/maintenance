# MaintenanceField Native Parity Checklist

References: `android/app/src`, `ios/`, generated clients under `clients/{kotlin,swift}`, `backend/openapi/openapi.yaml`, ADR-0009, and ADR-0012.

## Scope boundary

This checklist is the release parity source for the MaintenanceField native iOS and Android technician apps only. It covers user-visible mobile capability in `ios/**`, `android/app/**`, generated Swift/Kotlin client use, mobile string keys, and the browser enrollment/admin flows that are prerequisites for mobile passkey or admin-managed stories.

The standalone COSS public-site React Native application was retired by ADR-0026 and is not a repository surface. MaintenanceField parity evidence must not cite historical COSS RN artifacts, public-site native hosts, or their former release evidence.

Before adding a new mobile user-visible capability, update this checklist with the Android parity target, the iOS implementation path, the evidence command or manual sign-off path, and any new localized string keys. A release candidate fails the ADR-0009 gate when a row is blank, contains placeholder language, or does not have current Android+iOS evidence.

## ADR-0009 release evidence gate

Each ADR-0009 release must attach evidence for every applicable row below. Local runs are preferred; CI/manual-deferred entries are acceptable only when the platform surface cannot be exercised locally and the deferral reason is recorded in the PR or Kanban handoff.

| Evidence class | Required release proof | Applies when | Command, workflow, or sign-off source |
| --- | --- | --- | --- |
| Checklist and native string keys | This checklist has complete T1.7, T3.3, and T2.2 rows; Android `strings.xml` keys are present in iOS `Localizable.strings` except declared iOS aliases | Every mobile release and before adding a new mobile user-visible capability | `node scripts/check-i18n.mjs`; CI `Mobile parity — checklist and strings` |
| Generated client drift | Portable Kotlin/TypeScript and Swift generated clients remain contract-clean; no generated client is hand-edited in this lane | Backend/OpenAPI or generated-client consumers change | `npm run check:api-drift:portable`; `npm run check:api-drift:swift`; `npm run check:kotlin`; `npm run check:swift` |
| Swift package build and behavior | iOS package builds, SwiftPM test target resolves, and behavior runner covers auth/session/device registration/mapping/offline/messenger/location reducers | Every release with iOS or shared mobile capability impact | `cd ios && swift build`; `cd ios && swift test`; `cd ios && swift run MaintenanceFieldCoreBehaviorTests` |
| iOS Simulator UI and accessibility | XcodeGen project builds, XCUITest launches the real app, post-login tests use a real backend session source when configured, and accessibility-audit findings are attached | `ios/**` UI changes, mobile-visible workflow changes, or release candidates requiring iOS UI evidence | `.github/workflows/ios-ui-tests.yml` (`iOS — XCUITest + accessibility audit (Simulator)`) |
| iOS secure passkey ceremony | Real device Face ID/Touch ID + iCloud Keychain passkey create/assert/persistence/negative-path sign-off | Native passkey/auth changes, release candidates requiring secure-system UI proof, or when real ceremony evidence is stale for the release | `ios/E2E-MANUAL-SMOKE.md` |
| Android Gradle build/unit/UI/screenshot | Android release/debug build gate, Robolectric Compose UI/accessibility tests, and Roborazzi screenshot regression all pass | Every release with Android or shared mobile capability impact | `cd android && ./gradlew build -x testReleaseUnitTest -x testDebugUnitTest`; `cd android && ./gradlew testDebugUnitTest`; `cd android && ./gradlew verifyRoborazziDebug` |
| Android instrumented post-login E2E | Gradle Managed Device uses an isolated PostgreSQL 18.4 database and exact-candidate backend, then proves a random-OTP mechanic session can call the protected work-order API; missing, skipped, failed, or errored evidence fails | Android post-login flows, release candidates requiring Android end-to-end evidence, or token/session transport changes | CI `android-instrumented`; local `cd android && ./gradlew fieldApi34DebugAndroidTest` after equivalent harness setup |
| Android secure passkey ceremony | Real device Credential Manager create/assert/negative-path sign-off, including RP-origin confirmation and refresh-token persistence hand-off | Native passkey/auth changes, release candidates requiring secure-system UI proof, or when real ceremony evidence is stale for the release | `android/E2E-MANUAL-SMOKE.md` |
| Browser enrollment/admin prerequisites | Web console enrollment/admin/passkey create story works through the real browser harness before native login evidence depends on it | Mobile user story depends on web enrollment, admin provisioning, passkey create, or console-managed setup | `bash e2e/run.sh`; relevant web lint/test/build evidence from CI |
| MaintenanceField-only boundary | Evidence does not rely on retired COSS RN public-site artifacts or public-site native hosts | Every release | Historical COSS RN artifacts are not a valid parity or release-evidence source; ADR-0026 governs the retirement |

## Verified in T1.7

| Area | Android parity target | iOS implementation | Evidence |
| --- | --- | --- | --- |
| Package layout | Native mobile deliverable lives under `android/app` and builds from the monorepo contract | `ios/Package.swift` builds `MaintenanceFieldCore`, `MaintenanceFieldApp`, and `MaintenanceFieldCoreBehaviorTests` | `cd android && ./gradlew build -x testReleaseUnitTest -x testDebugUnitTest`; `cd ios && swift build`; CI `android-app` and `ios-app` jobs |
| Generated API client | Android gateway uses generated Kotlin client and OpenAPI routes for work orders, sync, evidence, device registration, and passkey login | `GeneratedMaintenanceAPIGateway` uses `clients/swift` generated `APIProtocol`, `URLSessionTransport`, bearer middleware, `/api/v1/work-orders`, `/api/work-orders/{id}/start`, `/api/work-orders/{id}/report`, `/api/v1/sync`, `/api/v1/evidence/*`, `/api/v1/devices`, and passkey login routes | `npm run check:api-drift:portable`; `npm run check:api-drift:swift`; `npm run check:kotlin`; `npm run check:swift` |
| Passkey login | Credential Manager passkey login returns access+refresh tokens and then registers the Android device | `PasskeyAuthRepository` mirrors the login state machine; `AuthorizationPasskeyCredentialProvider` uses `ASAuthorizationController` with platform and security-key public-key assertion requests | `cd android && ./gradlew fieldApi34DebugAndroidTest`; `cd ios && swift run MaintenanceFieldCoreBehaviorTests`; `ios/E2E-MANUAL-SMOKE.md`; `android/E2E-MANUAL-SMOKE.md` |
| Device registration | Android registers `DevicePlatform.ANDROID` with stable `X-Device-Id` after login | iOS registers `DevicePlatform.ios` after token issuance and persists a stable device ID in `UserDefaultsDeviceIDStore` | `cd android && ./gradlew testDebugUnitTest`; `cd ios && swift run MaintenanceFieldCoreBehaviorTests` |
| Today list | `assigned_to=me`, limit 100, priority/due sorting, loading/empty/error states, and post-login restore path render in Compose | SwiftUI today list calls generated `listWorkOrders(assignedTo: "me", limit: 100, offset: 0)`, maps generated items to `TechnicianWorkOrder`, and renders loading/empty/refresh/logout states | `cd android && ./gradlew testDebugUnitTest`; `cd android && ./gradlew verifyRoborazziDebug`; `.github/workflows/ios-ui-tests.yml`; `cd ios && swift build` |
| Detail/start/report | Detail refresh, start, result chips, diagnosis/action validation, report submit, and offline fallback are native UI flows | SwiftUI detail sheet supports start, result picker, diagnosis/action entry, validation, submit, and cached fallback | `cd android && ./gradlew testDebugUnitTest`; `cd android && ./gradlew verifyRoborazziDebug`; `.github/workflows/ios-ui-tests.yml`; `cd ios && swift build` |
| Generated mappers | Android `WorkOrderMappersTest` behavior preserves IDs, request number, management number fallback, model, customer/site, priority/status/sync, assignees, and priority sort order | Swift mapper preserves the same work-order fields and ordering behavior | `cd android && ./gradlew testDebugUnitTest`; `cd ios && swift run MaintenanceFieldCoreBehaviorTests` |
| Offline queue | Android Room queue uses ULID request IDs and `/api/v1/sync` replay with retry semantics | `OfflineQueueRepository` uses stable ULID-style request IDs, Core Data-backed `CoreDataMutationQueueStore`, `X-Device-Id`, per-operation applied/failed handling, and keeps mutations pending on transport failure | `cd android && ./gradlew testDebugUnitTest`; `cd ios && swift run MaintenanceFieldCoreBehaviorTests` |
| Evidence capture/upload | CameraX captures JPEG, stages evidence, presigns PUT, confirms upload, and retries pending uploads | `CameraCaptureView` uses AVFoundation; `EvidenceRepository` stages JPEG metadata, SHA-256, presigns, PUTs, confirms, and queues pending uploads in `FileEvidenceUploadStore` | `cd android && ./gradlew testDebugUnitTest`; `.github/workflows/ios-ui-tests.yml` camera suite; `cd ios && swift build` |
| Localization/labels | Android Korean UI strings and field labels resolve through `android/app/src/main/res/values/strings.xml` | `ko.lproj/Localizable.strings` includes Android keys plus declared SwiftUI aliases; label helpers mirror priority/status/result/sync mappings | `node scripts/check-i18n.mjs`; CI `Mobile parity — checklist and strings` |

## Verified in T3.3

| Area | Android parity target | iOS implementation | Evidence |
| --- | --- | --- | --- |
| Messenger generated gateway | Android `GeneratedMaintenanceApiGateway` maps generated messenger REST methods for threads, messages, send, read receipt, and search | `GeneratedMaintenanceAPIGateway` conforms to `MessengerGateway` and maps the same generated Swift OpenAPI operations | `npm run check:api-drift:portable`; `npm run check:api-drift:swift`; `cd android && ./gradlew build -x testReleaseUnitTest -x testDebugUnitTest`; `cd ios && swift build` |
| Messenger domain reducer | Android `MessengerReducer` dedupes pages/live messages, sorts messages by `sentAt`/ID, updates thread last-message state, and exposes resume cursors | Swift `MessengerReducer` mirrors the same reducer actions, dedupe ordering, last-message tracking, and `resumeCursor()` behavior | `cd android && ./gradlew testDebugUnitTest`; `cd ios && swift run MaintenanceFieldCoreBehaviorTests` |
| Messenger offline direct-send queue | Android stores offline-composed messages in `messenger_outbox` Room storage and replays by calling `sendMessage`, not `/sync` | iOS stores offline-composed messages in `FileMessengerOutboxStore` and `MessengerRepository.replayPending()` direct-sends through `MessengerGateway` | `cd android && ./gradlew testDebugUnitTest`; `cd ios && swift run MaintenanceFieldCoreBehaviorTests` |
| Messenger native realtime clients | Android `MessengerRealtimeClient` builds an OkHttp WebSocket request with `Authorization` and `last_message_id` resume cursor | iOS `MessengerRealtimeClient` builds a `URLSessionWebSocketTask` request with `Authorization` and `last_message_id` resume cursor | `cd android && ./gradlew testDebugUnitTest`; `cd ios && swift run MaintenanceFieldCoreBehaviorTests` |
| Messenger mobile UI | Android Compose exposes a Messenger tab with thread list, message pages, older-message cursor loading, FTS search, composer send-or-queue, and read receipts | SwiftUI exposes a Messenger tab with the same thread list, message pages, older-message cursor loading, FTS search, composer send-or-queue, and read receipts | `cd android && ./gradlew testDebugUnitTest`; `cd android && ./gradlew verifyRoborazziDebug`; `.github/workflows/ios-ui-tests.yml`; `cd ios && swift build` |
| Messenger web UI prerequisite | Web console uses generated REST client for thread list, message pagination, FTS search, send, read receipts, and WO-bound evidence presign upload | Native apps implement equivalent messenger workflows through generated Swift/Kotlin client repository layers | `npm --workspace web run test`; `npm --workspace web run lint`; `npm --workspace web run build`; `bash e2e/run.sh` when release story depends on browser enrollment/admin |
| Messenger localization | Android messenger UI labels are backed by `strings.xml` and shared parity keys match iOS | iOS messenger UI labels are backed by `Localizable.strings` with matching shared keys and field-label helpers | `node scripts/check-i18n.mjs`; CI `Mobile parity — checklist and strings` |

## Verified in T2.2

| Area | Android parity target | iOS implementation | Evidence |
| --- | --- | --- | --- |
| Location consent API | Generated client exposes status, grant, suspend, resume, withdraw, ping ingestion, and ledger export routes | `GeneratedMaintenanceAPIGateway` calls the same generated Swift operations for status, consent transitions, and ping ingestion | `npm run check:api-drift:portable`; `npm run check:api-drift:swift`; `npm run check:kotlin`; `npm run check:swift` |
| Always-visible GPS off switch | Authenticated work list, work-order detail, and evidence camera surfaces show direct GPS suspend/resume/withdraw controls, not settings-only controls | `LocationConsentSection` appears at the top of `TodayListView` and `WorkOrderDetailView` with GPS off, GPS on, withdrawal, and grant buttons | `cd android && ./gradlew testDebugUnitTest`; `cd android && ./gradlew verifyRoborazziDebug`; `.github/workflows/ios-ui-tests.yml`; `cd ios && swift build` |
| Local collection gate | `GpsCollectionState.mayCollect` requires granted consent and on-duty state before ping upload | `GPSCollectionState.mayCollect` mirrors the same rule with `.granted && onDuty` | Android `LocationConsentStateMachineTest` via `cd android && ./gradlew testDebugUnitTest`; `cd ios && swift run MaintenanceFieldCoreBehaviorTests` |
| Withdrawal behavior | Client state machine makes withdrawal a non-collecting terminal eligibility state until fresh consent; backend deletes location pings/logs on withdrawal | iOS behavior runner verifies granted/suspended to withdrawn transition and `mayCollect == false` | Android state-machine test via `cd android && ./gradlew testDebugUnitTest`; backend route tests when API changes; `cd ios && swift run MaintenanceFieldCoreBehaviorTests` |

## Tool availability and evidence recording

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
  `./gradlew fieldApi34DebugAndroidTest`. CI starts PostgreSQL 18.4, verifies
  and builds the exact candidate SHA, seeds the deterministic mechanic/work-order
  fixtures, redeems a random short-lived OTP, masks the resulting tokens, and
  hands them to `WorkOrderFlowTest` through the runner-local
  `FIELD_E2E_SESSION_ASSETS_DIR` androidTest asset fixture rather than GitHub
  outputs or raw Gradle CLI arguments. The test calls the protected work-order
  API and requires the assigned seeded work order; JUnit parsing fails on a
  missing, skipped, failed, or errored `WorkOrderFlowTest`. Debug cleartext is
  limited to emulator host `10.0.2.2`, while release remains HTTPS.
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
- Use a clean worktree for parity edits. Do not modify generated clients in this lane; route generated drift to the contract/Swift/Kotlin cards.
- Local Command Line Tools can run SwiftPM package evidence (`swift build`, `swift test`, behavior runner). XCUITest, Simulator signing/entitlements, and accessibility audit evidence come from `.github/workflows/ios-ui-tests.yml` or a full local Xcode install.
- Android Gradle unit/UI/screenshot evidence requires Java 21 and the Android SDK. Instrumented GMD evidence additionally requires KVM/emulator support; otherwise record CI evidence or the exact local platform constraint.
- Real passkey create/assert ceremonies are secure-system UI and require manual real-device sign-off through `ios/E2E-MANUAL-SMOKE.md` and `android/E2E-MANUAL-SMOKE.md` when release evidence requires those ceremonies.
- Browser E2E evidence is required only for browser enrollment/admin/provisioning flows that native mobile stories depend on; otherwise record the browser evidence class as not applicable for that release.
