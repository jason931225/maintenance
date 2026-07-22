# iOS build configuration (CI XCUITest wrapper)

These files exist so CI can build a real, generated `.xcodeproj` for XCUITest.
The normal developer build is still `swift build` / `swift test` against
`../Package.swift`. The XcodeGen project is a CI/test artifact, not proof that a
distribution archive, TestFlight upload, or production go-live path is ready.

## Files

| File | Purpose |
| --- | --- |
| `App.xcconfig` | Build settings for the app target. Hermetic CI uses the repository defaults `com.maintenance.field` and `98Q89GFZWP`; a separately governed release build may override `MNT_IOS_BUNDLE_ID` and `MNT_IOS_TEAM_ID`. |
| `MaintenanceFieldApp.entitlements` | App entitlements: shared keychain access group + associated domain for passkeys. |
| `MaintenanceFieldUITestSeeder.entitlements` | CI-only seeder app entitlement: the SAME shared keychain access group as the production app. |
| `../project.yml` | XcodeGen definition consumed by CI (`xcodegen generate`) to produce `MaintenanceField.xcodeproj` (a build artifact, not committed). |

## Bundle ID and signing status

The configured default bundle ID is `com.maintenance.field`, matching the Android
application ID and the shared keychain suffix used by the entitlement files.
Apple Team ID defaults to `98Q89GFZWP`. These defaults appear in
`App.xcconfig`, so local and CI project generation resolve a concrete identity
without repository variables or Apple signing secrets.

That configured default is **not** the same as production readiness: the App ID
still has to be registered/confirmed in the Apple Developer portal with the
required capabilities, matched to `MNT_IOS_APP_IDS` in
`deploy/apps/maintenance/base/configmap.yaml` as `98Q89GFZWP.com.maintenance.field`,
and paired with distribution certificates/provisioning before TestFlight or
go-live.

The flow is:

1. The hermetic CI job generates the project with the two repository defaults;
   it does not read identity variables or Apple credentials.
2. A future signed distribution lane may supply `MNT_IOS_BUNDLE_ID` and
   `MNT_IOS_TEAM_ID` as explicit Xcode build settings after the registered App ID,
   Team ID, entitlements, and provisioning profile are independently proven.
3. `App.xcconfig` maps those settings into `PRODUCT_BUNDLE_IDENTIFIER`,
   `DEVELOPMENT_TEAM`, and the keychain access group.
4. The CI Simulator build is ad-hoc signed so keychain-sharing entitlements can
   be embedded for XCUITest. This validates the CI test wrapper, not App Store
   distribution signing.

> Before TestFlight/go-live, confirm `com.maintenance.field` is the registered
> App ID, set the matching distribution build setting when it differs, verify
> `98Q89GFZWP.com.maintenance.field` is the `MNT_IOS_APP_IDS` entry, and install
> the release signing/App Store Connect secrets documented in
> `docs/release/SECRETS.md`. No source change is required if the default remains
> `com.maintenance.field`.

## Why a shared keychain access group

`KeychainSessionTokenStore` (in `MaintenanceFieldCore`) persists the session
token pair as a `kSecClassGenericPassword` item. The separate CI-only seeder
app writes a **real** session into that item so the production app's normal
`restore()` path authenticates — with **no fake `AuthRepository`** and **no
test-only branch in `AppContainer`**.

Production refresh consumes a rotating refresh token only after deletion from
both the primary and legacy Keychain stores is proven. A deletion failure blocks
the refresh request; logout/invalidation failures preserve truthful authenticated
state and surface an error instead of claiming that restorable credentials are gone.

For the production app to read the CI seeder's Keychain item, both apps must
declare the **same** `keychain-access-groups` entitlement. That group
(`$(AppIdentifierPrefix)com.maintenance.field.shared`) is declared in the app
and dedicated seeder entitlement files above.

### Runtime group resolution (app and test agree on ONE value)

`$(AppIdentifierPrefix)` is resolved by signing and must not be guessed or
reconstructed in application code. Both sides normally add a uniquely named
probe without an explicit access group, which makes Keychain Services select the
process's first entitled group, then read back and suffix-validate the exact
`kSecAttrAccessGroup` the system assigned:

- App: `KeychainAccessGroup.resolveShared(suffix:)` (production, in
  `MaintenanceFieldCore`). `AppContainer.live()` uses it to build the session
  store on the shared group, with a legacy default-group store for one-time
  forward migration so existing installs are not logged out.
- CI-only seeder app: `MaintenanceFieldUITestSeeder` uses the same probe and
  writes a real session only after the test protocol authorizes it. It is a
  separate product from the production app; it does not add an authentication
  bypass to production code. Hermetic CI verifies the Xcode-signed production
  app and seeder app, then parses each executable's link-time Mach-O
  `__TEXT,__entitlements` section and requires one identical, suffix-valid
  keychain group. The generated XCTest Runner remains Xcode-signed and
  untouched; no keychain-group value is injected into `.xctestrun`.

### Ad-hoc signing is required

The shared-group entitlement is only embedded in a **signed** binary. The CI
Simulator build is ad-hoc signed (`CODE_SIGN_IDENTITY = -` in `App.xcconfig`);
an entirely unsigned build (`CODE_SIGNING_ALLOWED = NO`) embeds no entitlement
and `SecItemAdd` returns `errSecMissingEntitlement (-34018)`.

Ad-hoc signing is sufficient for the Simulator XCUITest wrapper only. TestFlight
and production builds still require Apple Distribution signing assets,
provisioning profiles, App Store Connect credentials, and an archive-capable
Xcode project/workspace in the release workflow.

### Hermetic CI session and networking boundary

The UI workflow injects `MNT_UITEST_BASE_URL`, but its value is a job-local
loopback URL, not a stored secret or external service address. It runs
every triggered push/tag or public/untrusted pull-request gate on one
GitHub-hosted `macos-15` VM. Repository code does not execute on a reusable self-hosted macOS
runner; a future self-hosted lane requires a separately governed ephemeral/JIT
runner group with teardown attestation.

Each job:

1. Verifies Xcode 16.4 build `16F6`, the exact iOS 18.5 Simulator runtime, and
   the checkout against `GITHUB_SHA` before building the candidate Rust backend.
2. Creates one mode-`0700` root below `$RUNNER_TEMP`. `CARGO_HOME`,
   `RUSTUP_HOME`, `CARGO_TARGET_DIR`, XcodeGen, PostgreSQL, backend state,
   DerivedData, `.xctestrun`, and result artifacts stay below that owned root.
3. Downloads PostgreSQL 18.4 from the official source location and verifies
   SHA-256
   `81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094`
   before building it. PostgreSQL and the exact-candidate backend use separate
   random loopback ports.
4. Seeds deterministic test records and, before each test-class shard, generates
   a fresh random one-use OTP, stores only its SHA-256 digest, and redeems it for
   a new access/refresh pair. Each shard has a 720-second (12-minute) hard bound,
   below the backend's 15-minute access-token TTL. The production app implements
   serialized rotating refresh with proactive expiry handling, delete-before-use
   persistence, and one reactive retry, but the CI gate does not depend on refresh
   to finish a shard.
5. Keeps the generated `.xctestrun` below job-local DerivedData so its
   `__TESTROOT__` paths remain valid, sets mode `0600`, and patches it in place
   with the loopback URL, fresh token pair, and deterministic fixture IDs.
6. Runs the full XCUITest and strict accessibility suite as separate class
   shards. Structured aggregation across each shard's `.xcresult`, summary JSON,
   and test-tree JSON must equal the XCTest methods discovered from
   `ios/UITests`, with no duplicate, missing, skipped, failed, or errored test.
7. Scans the artifact tree for every raw OTP, access token, and refresh token
   before upload and fails on any match. It uploads the diagnostic artifacts
   with seven-day retention, then runs unconditional cleanup.
8. Cleanup compares the backend PID with its recorded command before signaling
   it, proves the backend stopped, stops PostgreSQL and proves it is inactive,
   deletes the exact Simulator and proves its UUID is absent, removes generated
   CI files, deletes the entire owned job root, and proves the root is gone.

Missing environment, fixture, entitlement, session, exact-test evidence,
secret-scan evidence, or cleanup proof fails XCTest or the workflow. There is no
`XCTSkip`, external backend/session secret, or fork-specific reduced suite.

Plain HTTP is allowed only for the job-local loopback backend through the
CI-generated Xcode project configuration. The production
`Sources/MaintenanceFieldApp/Info.plist`, TestFlight archive configuration, and
release networking policy remain unchanged. This workflow is test evidence only;
it does not prove TestFlight packaging, signing, production deployment, or
shipping readiness.
