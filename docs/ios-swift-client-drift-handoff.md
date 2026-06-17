# Hand-off: mobile ↔ OpenAPI drift (passkey login + refresh-token nullability)

Status: **mobile app code fixed in this branch; the Swift *client* regeneration
still requires a Swift toolchain.**

These breakages were all pre-existing on `main`; they only became visible in CI
once the `mobile-parity` gate was repaired (it previously failed first and gated
the iOS/Android build jobs).

## Drift 1 — usernameless passkey login (both platforms)

The spec made `POST /api/v1/auth/passkey/login/start` usernameless
(`backend/openapi/openapi.yaml:1385`): *"No request body is required; the user is
resolved from the asserted credential at finish."* The `PasskeyLoginStartRequest`
schema was removed and the operation now takes no body. The hand-written gateways
still sent that body:

```
iOS:     APIGateway.swift — type 'Components.Schemas' has no member 'PasskeyLoginStartRequest'
Android: MaintenanceApiGateway.kt — Unresolved reference 'PasskeyLoginStartRequest'
                                   — Too many arguments for 'apiV1AuthPasskeyLoginStartPost()'
```

**Fixed in this branch** (gateway protocol/interface, implementation, and the
single `AuthRepository`/`PasskeyAuthRepository` call site on each platform):
`startPasskeyLogin` no longer takes a `userID`/`userId` and calls the operation
with no body. `userID` is still used locally for the login challenge reduction.

## Drift 2 — `TokenPairResponse.refresh_token` is nullable (Android now; iOS after regen)

`refresh_token` is `nullable: true` (`openapi.yaml`): *"null in the cookie
transport (web)… [present in] the body transport (mobile)."* The generated
mobile clients type it as optional, but the app code assumed non-null:

```
Android: PasskeyAuthRepository.kt — Argument type mismatch: 'String?' vs 'String'
```

**Fixed for Android in this branch**: `PasskeyAuthRepository` now does
`val refreshToken = requireNotNull(tokens.refreshToken) { … }` (mobile always
receives the body token; absence falls into the existing `catch` → `login_failed`).

**iOS is not affected yet** because the *committed* `clients/swift` is stale and
still types `refreshToken` as non-optional, so `AuthRepository.swift` compiles as
is. **After the Swift client is regenerated (below), `refreshToken` becomes
`String?`** and the same guard must be added in
`ios/Sources/MaintenanceFieldCore/AuthRepository.swift` (the two `tokens.refreshToken`
uses around lines 64 and 70), e.g.:

```swift
guard let refreshToken = tokens.refreshToken else {
    await sessionStore.clear()
    return stateMachine.reduce(state, .failed(messageKey: "login_failed"))
}
// …use `refreshToken` for .passkeyVerified(refreshToken:) and AuthTokens(refreshToken:)
```

## Remaining step — requires a machine with the Swift toolchain

The **"API client — Swift generation and build" → Generated Swift client drift
gate** is independent of the app build: regenerating produces a diff because the
committed `clients/swift` is stale (e.g. `ListSupportTickets.Input.Query` is
missing the `limit`/`cursor` query params; `refresh_token` nullability; etc.).
Regenerate and commit on a Swift-equipped machine (macOS CI or a dev box):

```sh
npm run gen:api:swift          # builds apple/swift-openapi-generator (needs `swift`) and regenerates clients/swift
git add clients/swift
git diff --cached --stat        # review the regenerated delta
git commit -m "chore(api): regenerate Swift client from current OpenAPI spec"
```

Then apply the iOS refresh-token guard (Drift 2) and verify both jobs locally:

```sh
npm run check:api-drift:swift   # gen + `git diff --exit-code -- clients/swift`
( cd ios && swift build )       # mirrors the "iOS app — Swift build" job
```

## Why it wasn't fully finished here

The web execution sandbox has **no Swift toolchain** (`swift` is absent), so
`npm run gen:api:swift` (which builds `apple/swift-openapi-generator` via
`swift build`) cannot run, and the Swift edits cannot be compile-verified locally.
The Android app edits likewise could not be run through Gradle here (no Android
SDK), but they match the committed, drift-gate-clean generated Kotlin client.
All app-code edits are authored against the generated client signatures and are
validated by the next CI run; editing generated output by hand would be
unreliable, so the Swift regeneration is left to a Swift-equipped environment.
