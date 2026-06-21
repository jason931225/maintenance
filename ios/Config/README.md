# iOS build configuration (CI XCUITest wrapper)

These files exist so CI can build a real `.xcodeproj` for XCUITest. The normal
developer build is still `swift build` / `swift test` against `../Package.swift`
and does not use anything here.

## Files

| File | Purpose |
| --- | --- |
| `App.xcconfig` | Build settings for the app target. Sources the bundle id + Team ID from the environment (`MNT_IOS_BUNDLE_ID`, `MNT_IOS_TEAM_ID`) so nothing is hardcoded. |
| `MaintenanceFieldApp.entitlements` | App entitlements: shared keychain access group + associated domain for passkeys. |
| `MaintenanceFieldUITests.entitlements` | UITests entitlements: the SAME shared keychain access group, so the test runner can seed a real session the app reads back. |
| `../project.yml` | XcodeGen definition consumed by CI (`xcodegen generate`) to produce `MaintenanceField.xcodeproj` (a build artifact, not committed). |

## Where the real bundle id goes

The iOS bundle id is **pending registration**. Apple Team ID is **98Q89GFZWP**;
`MNT_IOS_APP_IDS` in `deploy/apps/maintenance/base/configmap.yaml` awaits the
registered bundle id to form `98Q89GFZWP.<bundle-id>`.

This repo does **not** hardcode a guessed bundle id. Instead:

1. The CI job exports two environment values before generating the project:
   - `MNT_IOS_BUNDLE_ID` — the registered bundle id (e.g. `com.maintenance.field`,
     matching the Android `applicationId`). Sourced from the repo variable/secret
     `MNT_IOS_BUNDLE_ID`.
   - `MNT_IOS_TEAM_ID` — `98Q89GFZWP` (sourced from the repo variable
     `MNT_IOS_TEAM_ID`, defaulted in `App.xcconfig`).
2. `App.xcconfig` reads those into `PRODUCT_BUNDLE_IDENTIFIER` /
   `DEVELOPMENT_TEAM` / the keychain access group.
3. If the CI variable is absent, `App.xcconfig` falls back to a clearly-marked
   placeholder (`com.maintenance.field.uitests-placeholder`) that is valid for an
   **unsigned Simulator build** but must never ship. The placeholder lets the
   build resolve so the suite can run on the Simulator; the entitlement-gated
   keychain seeding then either works (entitled build) or the dependent tests
   skip honestly via `XCTSkip` (see `UITests/Support/RealSessionSeed.swift`).

> When the bundle id is registered, set the `MNT_IOS_BUNDLE_ID` repo variable to
> the real value and add `98Q89GFZWP.<bundle-id>` to `MNT_IOS_APP_IDS` in the
> deploy ConfigMap. No source change is required here.

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

### Honest feasibility boundary

On a build with no granted shared group, the seeding cannot happen and the
dependent tests skip with an actionable message rather than fake auth — see
`UITests/Support/RealSessionSeed.swift` and `../E2E-MANUAL-SMOKE.md`. To stop an
all-skip run from passing silently, `PreflightUITests` **fails** (not skips) when
`MNT_UITEST_REQUIRE_REAL=1` (set by CI on pushes where the session secrets
exist).
