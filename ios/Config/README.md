# iOS build configuration (CI XCUITest wrapper)

These files exist so CI can build a real, generated `.xcodeproj` for XCUITest.
The normal developer build is still `swift build` / `swift test` against
`../Package.swift`. The XcodeGen project is a CI/test artifact, not proof that a
distribution archive, TestFlight upload, or production go-live path is ready.

## Files

| File | Purpose |
| --- | --- |
| `App.xcconfig` | Build settings for the app target. Defaults the bundle id to `com.maintenance.field` and Team ID to `98Q89GFZWP`, while still allowing CI/release overrides through `MNT_IOS_BUNDLE_ID` and `MNT_IOS_TEAM_ID`. |
| `MaintenanceFieldApp.entitlements` | App entitlements: shared keychain access group + associated domain for passkeys. |
| `MaintenanceFieldUITests.entitlements` | UITests entitlements: the SAME shared keychain access group, so the test runner can seed a real session the app reads back. |
| `../project.yml` | XcodeGen definition consumed by CI (`xcodegen generate`) to produce `MaintenanceField.xcodeproj` (a build artifact, not committed). |

## Bundle ID and signing status

The configured default bundle ID is `com.maintenance.field`, matching the Android
application ID and the shared keychain suffix used by the entitlement files.
Apple Team ID defaults to `98Q89GFZWP`. These defaults appear in
`App.xcconfig` and the CI XCUITest workflow so local/CI project generation can
resolve a concrete identity.

That configured default is **not** the same as production readiness: the App ID
still has to be registered/confirmed in the Apple Developer portal with the
required capabilities, matched to `MNT_IOS_APP_IDS` in
`deploy/apps/maintenance/base/configmap.yaml` as `98Q89GFZWP.com.maintenance.field`,
and paired with distribution certificates/provisioning before TestFlight or
go-live.

The flow is:

1. The CI job exports two environment values before generating the project:
   - `MNT_IOS_BUNDLE_ID` — defaults to `com.maintenance.field`; override only if
     the registered App ID changes.
   - `MNT_IOS_TEAM_ID` — defaults to `98Q89GFZWP`; override only if the Apple
     team changes.
2. `App.xcconfig` reads those into `PRODUCT_BUNDLE_IDENTIFIER` /
   `DEVELOPMENT_TEAM` / the keychain access group.
3. The CI Simulator build is ad-hoc signed so keychain-sharing entitlements can
   be embedded for XCUITest. This validates the CI test wrapper, not App Store
   distribution signing.

> Before TestFlight/go-live, confirm `com.maintenance.field` is the registered
> App ID, set or verify the matching `MNT_IOS_BUNDLE_ID` repo variable, verify
> `98Q89GFZWP.com.maintenance.field` is the `MNT_IOS_APP_IDS` entry, and install
> the release signing/App Store Connect secrets documented in
> `docs/release/SECRETS.md`. No source change is required if the default remains
> `com.maintenance.field`.

## Why a shared keychain access group

`KeychainSessionTokenStore` (in `MaintenanceFieldCore`) persists the session
token pair as a `kSecClassGenericPassword` item. The XCUITest suite seeds a
**real** session into that item from the test-runner process so the app's normal
`restore()` path authenticates — with **no fake `AuthRepository`** and **no
test-only branch in `AppContainer`**.

For one process to read another's Keychain item, both must declare the **same**
`keychain-access-groups` entitlement. That group
(`$(AppIdentifierPrefix)com.maintenance.field.shared`) is declared in both
entitlement files above.

### Runtime group resolution (app and test agree on ONE value)

`$(AppIdentifierPrefix)` is the Team ID on a properly-signed device build but a
**placeholder** on the ad-hoc-signed Simulator build, so the fully-qualified
group string is **not** hardcoded. Both sides resolve the *granted* group at
runtime by probing the Keychain and reading back the actual `kSecAttrAccessGroup`
the system assigned:

- App: `KeychainAccessGroup.resolveShared(suffix:)` (production, in
  `MaintenanceFieldCore`). `AppContainer.live()` uses it to build the session
  store on the shared group, with a legacy default-group store for one-time
  forward migration so existing installs are not logged out.
- Test: `RealSessionSeed.resolvedAccessGroup()` uses the identical probe, so it
  seeds into exactly the group the app reads from.

### Ad-hoc signing is required

The shared-group entitlement is only embedded in a **signed** binary. The CI
Simulator build is ad-hoc signed (`CODE_SIGN_IDENTITY = -` in `App.xcconfig`);
an entirely unsigned build (`CODE_SIGNING_ALLOWED = NO`) embeds no entitlement
and `SecItemAdd` returns `errSecMissingEntitlement (-34018)`.

Ad-hoc signing is sufficient for the Simulator XCUITest wrapper only. TestFlight
and production builds still require Apple Distribution signing assets,
provisioning profiles, App Store Connect credentials, and an archive-capable
Xcode project/workspace in the release workflow.

### Honest feasibility boundary

On a build with no granted shared group, the seeding cannot happen and the
dependent tests skip with an actionable message rather than fake auth — see
`UITests/Support/RealSessionSeed.swift` and `../E2E-MANUAL-SMOKE.md`. To stop an
all-skip run from passing silently, `PreflightUITests` **fails** (not skips) when
`MNT_UITEST_REQUIRE_REAL=1` (set by CI for push/protected contexts before checking
whether the required real-session secrets exist).
