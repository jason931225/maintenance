# Hand-off: mobile ↔ OpenAPI drift (passkey login + refresh-token nullability)

Status: **resolved / revalidated on 2026-07-02**.

This hand-off used to track two OpenAPI ↔ native-client drift items:

1. `POST /api/v1/auth/passkey/login/start` is usernameless and takes no request
   body.
2. `TokenPairResponse.refresh_token` is nullable in the OpenAPI schema and is
   modeled as `String?` by the generated Swift client.

Current `origin/main` already contains the required app-side adaptations and the
committed Swift client is current against `backend/openapi/openapi.yaml`.

## Closure evidence

Revalidated from clean worktree `/private/tmp/maintenance-t_ccc6fa14` at head
`c4f56bc2fc604d75009cbdcdc6845e5214aa01c2`.

Toolchain observed locally:

- macOS 26.5.1 (`25F80`)
- Apple Swift 6.3.2 (`swiftlang-6.3.2.1.108 clang-2100.1.1.101`)
- `apple/swift-openapi-generator` 1.12.2, as pinned by
  `scripts/generate-swift-client.mjs`

Code markers verified at that head:

- `clients/swift/Sources/MaintenanceAPIClient/Generated/Types.swift:13080`
  models `TokenPairResponse.refreshToken` as `Swift.String?`.
- `ios/Sources/MaintenanceFieldCore/AuthRepository.swift:59` guards
  `tokens.refreshToken` before persisting or reducing to `.passkeyVerified`.
- `ios/Sources/MaintenanceFieldCore/APIGateway.swift:103` calls
  `client.postApiV1AuthPasskeyLoginStart()` with no request body.

Commands run, all successful:

```sh
npm run gen:api:swift
git diff --exit-code -- clients/swift
npm run check:swift
( cd ios && swift build )
( cd ios && swift test )
( cd ios && swift run MaintenanceFieldCoreBehaviorTests )
```

Result summary:

- Swift regeneration completed and `clients/swift` remained clean.
- `npm run check:swift` completed with exit 0.
- `ios` SwiftPM build completed with exit 0.
- `ios` SwiftPM tests completed with exit 0.
- `MaintenanceFieldCoreBehaviorTests` completed with exit 0 and printed
  `MaintenanceFieldCoreBehaviorTests passed`.

## XCUITest / accessibility gate

The local machine used for this revalidation has Command Line Tools only, not a
full Xcode installation:

```text
xcodebuild_exit=1
xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance
simctl_exit=72
xcrun: error: unable to find utility "simctl", not a developer tool or in PATH
```

Therefore the Simulator-bound XCUITest/accessibility suite remains a CI-only gate
as documented in `.github/workflows/ios-ui-tests.yml`. The latest observed
`ios-ui-tests.yml` run was successful on `main` at `e7b165a8c7ec`:
`https://github.com/jason931225/maintenance/actions/runs/28576802389`.
Subsequent `main` commits through `c4f56bc2` did not modify `ios/**`, so no newer
path-filtered iOS UI run was available during this closeout.

The real passkey ceremony is still intentionally manual, not automated. Keep the
manual smoke checklist below for release/device sign-off.

## Original drift context

### Drift 1 — usernameless passkey login

The spec made `POST /api/v1/auth/passkey/login/start` usernameless
(`backend/openapi/openapi.yaml`): *"No request body is required; the user is
resolved from the asserted credential at finish."* The removed
`PasskeyLoginStartRequest` schema used to break handwritten native gateways when
those gateways still sent a body.

Current iOS status: resolved. `MaintenanceAPIGateway.startPasskeyLogin()` takes no
`userID`, and `GeneratedMaintenanceAPIGateway.startPasskeyLogin()` calls the
generated no-body operation. `userID` is still used locally for the login
challenge reduction.

### Drift 2 — `TokenPairResponse.refresh_token` is nullable

`refresh_token` is `nullable: true` in `openapi.yaml`: it is null for web cookie
transport and present for mobile body transport. The generated Swift type is
therefore `String?`.

Current iOS status: resolved. `PasskeyAuthRepository.login` requires the optional
mobile refresh token before session persistence:

```swift
guard let refreshToken = tokens.refreshToken else {
    await sessionStore.clear()
    return stateMachine.reduce(state, .failed(messageKey: "login_failed"))
}
```

A nil mobile refresh token is treated as a server contract violation and falls
into the existing graceful login-failure state instead of crashing or persisting a
partial session.

## Manual E2E smoke checklist: real passkey ceremony

This checklist covers the **one** flow that cannot be automated by XCUITest: the
real passkey ceremony (create + assert). Everything *after* a real session exists
is covered by the automated XCUITest suite (`ios/UITests/`). This document is the
human-run gate for the auth ceremony itself.

### Why this is manual (not a gap, a platform constraint)

A real passkey ceremony is **not automatable** in XCUITest, by design:

- The `ASAuthorization*` sheet that `AuthorizationPasskeyCredentialProvider`
  presents (`ios/Sources/MaintenanceFieldApp/AuthorizationPasskeyCredentialProvider.swift`)
  is rendered and owned by **SpringBoard**, a separate system process. XCUITest
  drives the app under test; it cannot reach into SpringBoard's secure UI.
- There is **no Apple-provided virtual authenticator** for the Simulator
  (unlike WebAuthn's `virtualAuthenticators` in Chrome/Safari WebDriver). The
  Simulator has no Secure Enclave and no iCloud Keychain passkey store.
- The **iOS-18 biometric `notify_post` hack** (posting
  `com.apple.BiometricKit.enrollmentChanged` / matching notifications to fake a
  Face ID match) **no longer works** on current iOS for the passkey sheet — it
  was never a supported path and Apple closed it.

Therefore the ceremony is verified by a human on a **real device**, with **real
Face ID**, a **real iCloud Keychain passkey**, and the **real backend**.

### Preconditions

- A physical iPhone (Face ID or Touch ID), signed into an Apple ID with **iCloud
  Keychain enabled** (Settings → [name] → iCloud → Passwords and Keychain → ON).
- The app installed from a signed build whose **bundle id** is registered in the
  Apple Developer portal under Team ID **98Q89GFZWP**, with the **Associated
  Domains** entitlement `webcredentials:knllogistic.com` (the RP id — apex per
  `deploy/apps/maintenance/base/configmap.yaml` `MNT_WEBAUTHN_RP_ID`).
- The backend reachable at the RP origin **https://console.knllogistic.com**
  (staging or prod) serving the Apple App Site Association document at
  `https://knllogistic.com/.well-known/apple-app-site-association` with this
  build's app id present in `MNT_IOS_APP_IDS`
  (`98Q89GFZWP.<bundle-id>`). Until that ConfigMap value is populated the
  ceremony **cannot** succeed — passkeys are inert without the AASA association
  (see `deploy/SECRETS.md`, "Native passkeys are inert until …").
- A field-mechanic user provisioned on that backend with permission to enroll a
  passkey.

> If the app is launched with `MAINTENANCE_API_BASE_URL` unset it targets
> production (`https://fsm.knllogistic.com`, which now 301-redirects to
> `https://console.knllogistic.com`) — see
> `ios/Sources/MaintenanceFieldApp/AppContainer.swift` `resolveServerURL()`.
> To smoke against staging, set that environment override on the build.

### Part A — Passkey CREATE (enrollment)

Enrollment is performed via the **web console** (the native field app today only
performs *login* assertions — `PasskeyAuthRepository.login` calls
`startPasskeyLogin` / `finishPasskeyLogin`, there is no native create flow). The
created passkey must be a **platform** (iCloud Keychain) credential so it syncs to
the iPhone.

- [ ] On the iPhone, open Safari → `https://console.knllogistic.com`, sign in,
      and enroll a passkey for the test mechanic. Confirm Face ID prompts and the
      "Save a passkey for knllogistic.com?" system sheet appears (the prompt names
      the RP id — the apex — not the served host).
- [ ] Approve with Face ID. Verify the passkey is saved (Settings → Passwords →
      search `knllogistic.com` shows the credential).

**Expected:** the credential is stored in iCloud Keychain, scoped to the RP id
`knllogistic.com`, and visible across the user's devices.

### Part B — Passkey ASSERT (native login)

- [ ] Cold-launch the field app (kill from app switcher first, so session restore
      starts from a signed-out state — `FieldViewModel.restore()` →
      `PasskeyAuthRepository.restore()` returns `.signedOut` when the Keychain has
      no session).
- [ ] On the login screen (Korean title **패스키 로그인**), enter the mechanic's
      user id (a UUID) and tap **로그인** (`login.button`).
- [ ] The **system** passkey sheet (SpringBoard) appears offering the
      `knllogistic.com` credential. Confirm with **Face ID**.

**Expected:**

- [ ] Face ID succeeds and the sheet dismisses.
- [ ] The app transitions to the authenticated tab bar; the **오늘 작업** (Today)
      tab shows the mechanic's real work orders (or the empty state
      **오늘 배정된 작업이 없습니다.** if none are assigned).
- [ ] No **로그인에 실패했습니다.** (login_failed) error is shown.

### Part C — Session persistence (restore path the UITests rely on)

This is the bridge to the automated suite: it proves the real session that the
ceremony produces is persisted in the **real Keychain** and restored on the next
cold launch — the exact path the XCUITest pre-launch seeding emulates.

- [ ] After a successful Part B login, force-quit the app and cold-launch again.
- [ ] **Expected:** the app restores straight into the authenticated tab bar
      **without** re-presenting the passkey sheet (the session token pair was
      persisted by `KeychainSessionTokenStore` and re-read by `restore()`). This
      confirms the seam the UITests exercise: a valid token pair in the Keychain ⇒
      authenticated launch.

### Part D — Failure / negative paths

- [ ] Cancel the Face ID sheet → app shows **로그인에 실패했습니다.** and stays on
      the login screen (`PasskeyAuthRepository.login` catch → `.failed`).
- [ ] Airplane mode during Part B → login fails gracefully (no crash), error copy
      shown.

### Sign-off

| Field | Value |
| --- | --- |
| Tester | |
| Date | |
| Device / iOS version | |
| App build (bundle id + version) | |
| Backend env (staging/prod) | |
| RP origin | https://console.knllogistic.com |
| Part A (create) | ☐ pass ☐ fail |
| Part B (assert) | ☐ pass ☐ fail |
| Part C (persistence) | ☐ pass ☐ fail |
| Part D (negative) | ☐ pass ☐ fail |
| Notes | |
