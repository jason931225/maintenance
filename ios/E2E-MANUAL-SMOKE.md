# iOS Field App — Manual E2E Smoke (passkey ceremony)

This checklist covers the **one** flow that cannot be automated by XCUITest: the
real passkey ceremony (create + assert). Everything *after* a real session exists
is covered by the automated XCUITest suite (`ios/UITests/`). This document is the
human-run gate for the auth ceremony itself.

## Why this is manual (not a gap, a platform constraint)

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

## Preconditions

- A physical iPhone (Face ID or Touch ID), signed into an Apple ID with **iCloud
  Keychain enabled** (Settings → [name] → iCloud → Passwords and Keychain → ON).
- The app installed from a signed build whose **bundle id** is registered in the
  Apple Developer portal under Team ID **98Q89GFZWP**, with the **Associated
  Domains** entitlement `webcredentials:knllogistic.com` (the RP id — apex per
  `deploy/apps/maintenance/base/configmap.yaml` `MNT_WEBAUTHN_RP_ID`).
- The backend reachable at the RP origin **https://fsm.knllogistic.com** (staging
  or prod) serving the Apple App Site Association document at
  `https://knllogistic.com/.well-known/apple-app-site-association` with this
  build's app id present in `MNT_IOS_APP_IDS`
  (`98Q89GFZWP.<bundle-id>`). Until that ConfigMap value is populated the
  ceremony **cannot** succeed — passkeys are inert without the AASA association
  (see `deploy/SECRETS.md`, "Native passkeys are inert until …").
- A field-mechanic user provisioned on that backend with permission to enroll a
  passkey.

> If the app is launched with `MAINTENANCE_API_BASE_URL` unset it targets
> production (`https://fsm.knllogistic.com`) — see
> `ios/Sources/MaintenanceFieldApp/AppContainer.swift` `resolveServerURL()`.
> To smoke against staging, set that environment override on the build.

## Part A — Passkey CREATE (enrollment)

Enrollment is performed via the **web console** (the native field app today only
performs *login* assertions — `PasskeyAuthRepository.login` calls
`startPasskeyLogin` / `finishPasskeyLogin`, there is no native create flow). The
created passkey must be a **platform** (iCloud Keychain) credential so it syncs to
the iPhone.

- [ ] On the iPhone, open Safari → `https://fsm.knllogistic.com`, sign in, and
      enroll a passkey for the test mechanic. Confirm Face ID prompts and the
      "Save a passkey for fsm.knllogistic.com?" system sheet appears.
- [ ] Approve with Face ID. Verify the passkey is saved (Settings → Passwords →
      search `knllogistic.com` shows the credential).

**Expected:** the credential is stored in iCloud Keychain, scoped to the RP id
`knllogistic.com`, and visible across the user's devices.

## Part B — Passkey ASSERT (native login)

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

## Part C — Session persistence (restore path the UITests rely on)

This is the bridge to the automated suite: it proves the real session that the
ceremony produces is persisted in the **real Keychain** and restored on the next
cold launch — the exact path the XCUITest pre-launch seeding emulates.

- [ ] After a successful Part B login, force-quit the app and cold-launch again.
- [ ] **Expected:** the app restores straight into the authenticated tab bar
      **without** re-presenting the passkey sheet (the session token pair was
      persisted by `KeychainSessionTokenStore` and re-read by
      `restore()`). This confirms the seam the UITests exercise: a valid token
      pair in the Keychain ⇒ authenticated launch.

## Part D — Failure / negative paths

- [ ] Cancel the Face ID sheet → app shows **로그인에 실패했습니다.** and stays on
      the login screen (`PasskeyAuthRepository.login` catch → `.failed`).
- [ ] Airplane mode during Part B → login fails gracefully (no crash), error copy
      shown.

## Sign-off

| Field | Value |
| --- | --- |
| Tester | |
| Date | |
| Device / iOS version | |
| App build (bundle id + version) | |
| Backend env (staging/prod) | |
| RP origin | https://fsm.knllogistic.com |
| Part A (create) | ☐ pass ☐ fail |
| Part B (assert) | ☐ pass ☐ fail |
| Part C (persistence) | ☐ pass ☐ fail |
| Part D (negative) | ☐ pass ☐ fail |
| Notes | |
