# Android Field App — Manual Smoke (Passkey Ceremony)

The passkey ceremony cannot be automated: the Android **Credential Manager** bottom sheet
is a system overlay rendered by Google Play Services, outside the process under test, so it
is unreachable by Espresso and Compose-UI test (which can only drive views inside the app's
own window). The create/assert ceremony is therefore covered by this **real-device manual
smoke**, run by a human against staging. Everything *after* login is automated (see
`WorkOrderFlowTest`, which seeds a real backend session into the real `SessionTokenStore`).

## Why manual (sources)

- Credential Manager UI is a system component; UI Automator can reach system UI but the WebAuthn
  authenticator selection + biometric/device-credential prompt are driven by the platform's
  secure surface, not deterministically scriptable in CI.
- An emulator with `google_apis_playstore` can complete a passkey ceremony interactively, but it
  requires manual biometric/PIN interaction that an unattended CI job cannot supply.

## Preconditions

- Physical Android device (API 26+; the app's `minSdk` is 26) with:
  - A Google account signed in (Credential Manager / Google Password Manager enabled).
  - A screen lock set (PIN/pattern/biometric) — required to create and assert a passkey.
- The debug APK built against staging:
  - `API_BASE_URL` must point at staging. The debug default is `http://10.0.2.2:8080`
    (emulator loopback). For a physical device, build a variant whose `API_BASE_URL` resolves
    to the staging ingress, or port-forward. Production/release points at `https://fsm.knllogistic.com`
    (which now 301-redirects to the console host `https://console.knllogistic.com`).
- Staging Relying Party (RP) is `knllogistic.com`; the device's Digital Asset Links must
  authorize the app's signing cert for that origin.
- A test technician user provisioned on staging with permission to register a passkey.

## Checklist — Passkey CREATE (registration)

1. Fresh install the debug APK; launch. Confirm the login screen shows the Korean title
   **패스키 로그인** and the **사용자 ID** field.
2. Trigger registration for the test user (per the staging onboarding flow / admin-issued
   registration link).
3. The system **Credential Manager** sheet appears (`Create a passkey for knllogistic.com`).
   Confirm the RP/origin shown is `knllogistic.com`, NOT a phishing origin.
4. Complete the biometric / device-credential prompt.
5. Confirm the app reports registration success and the credential appears in
   Google Password Manager → Passkeys for `knllogistic.com`.

   - [ ] Sheet shows correct RP origin `knllogistic.com`
   - [ ] Biometric/device-credential prompt accepted
   - [ ] Passkey listed under the Google account
   - [ ] App advanced past registration with no error toast

## Checklist — Passkey ASSERT (login)

1. From a signed-out state, start login (usernameless / discoverable).
2. The **Credential Manager** sheet appears (`Use a passkey for knllogistic.com`) and lists
   the credential created above.
3. Select it and complete the biometric / device-credential prompt.
4. Confirm the app:

   - [ ] Receives an access + **refresh** token (mobile transport returns the refresh token
         in the body — the app requires it; a missing refresh token is a login failure).
   - [ ] Registers the Android device (platform = ANDROID).
   - [ ] Lands on **오늘 작업** (Today) — i.e. `LoginState.Authenticated`.
   - [ ] Korean labels render with the Pretendard font.

## Checklist — Negative paths

- [ ] Cancel the Credential Manager sheet → app shows **로그인에 실패했습니다.** and stays signed out.
- [ ] Wrong biometric repeatedly → ceremony fails → app stays signed out, session store empty.
- [ ] Airplane mode during finish → login fails gracefully (no crash), session store cleared.

## Hand-off to the automated suite

Once a real login succeeds on the device, the resulting **refresh token** for the test user is
the input to the automated, no-fakes E2E:

- CI refreshes that token at run start (`POST /api/v1/auth/refresh`) and passes the fresh
  access+refresh pair to `WorkOrderFlowTest` via the `FIELD_E2E_ACCESS_TOKEN` /
  `FIELD_E2E_REFRESH_TOKEN` instrumentation arguments.
- The test seeds them into the real `SessionTokenStore` and lets the app's normal boot path
  restore the session — no fake auth, no test-only code path in the app.
