# Hand-off: iOS Swift client drift (passkey login start)

Status: **partially fixed in this branch; one step requires a Swift toolchain.**

## Symptom (CI)

Two jobs on the `CI` workflow were red once the `mobile-parity` gate was repaired
(previously these never ran because the parity gate failed first and gated them):

1. **API client — Swift generation and build** → step *Generated Swift client drift
   gate* fails (`npm run gen:api:swift` then `git diff --exit-code -- clients/swift`).
   The committed `clients/swift` generated sources are stale relative to
   `backend/openapi/openapi.yaml`.
2. **iOS app — Swift build** → `MaintenanceFieldCore/APIGateway.swift` failed to
   compile:
   ```
   error: type 'Components.Schemas' has no member 'PasskeyLoginStartRequest'
   error: cannot infer contextual base in reference to member 'json'
   ```

## Root cause

The OpenAPI spec evolved the passkey login-start endpoint to a **usernameless
(discoverable)** flow. `POST /api/v1/auth/passkey/login/start`
(`backend/openapi/openapi.yaml:1385`) now states *"No request body is required;
the user is resolved from the asserted credential at finish."* The
`PasskeyLoginStartRequest` schema no longer exists, and the generated operation
`postApiV1AuthPasskeyLoginStart` takes only `headers` (no body).

The hand-written `APIGateway.swift` was never updated and still sent a
`PasskeyLoginStartRequest(userId:)` body — hence the compile error.
(`finishPasskeyLogin` and its `PasskeyLoginFinishRequest` / `CredentialPayload`
types are unaffected; they still exist in the generated client.)

## What was fixed in this branch (not compile-verified here — no Swift toolchain in the web sandbox)

- `ios/Sources/MaintenanceFieldCore/APIGateway.swift` — `startPasskeyLogin` now
  takes no `userID` and calls `client.postApiV1AuthPasskeyLoginStart()` with no
  body, matching the spec and the committed generated signature.
- `ios/Sources/MaintenanceFieldCore/AuthRepository.swift` — the single call site
  (`login(userID:)`) now calls `gateway.startPasskeyLogin()`. `userID` is still
  used locally for the state-machine reduction (`.loginChallengeReceived`), so no
  unused-variable warning is expected.

These edits target the **iOS app — Swift build** job, which compiles against the
*committed* `clients/swift` (which already reflects the no-body signature). They
should turn that job green, but were authored without a local Swift compiler;
the next macOS CI run validates them.

## Remaining step — requires a machine with the Swift toolchain

The **drift gate** is independent of the app build: the committed generated
sources still differ from a fresh generation. Regenerate and commit:

```sh
npm run gen:api:swift          # builds apple/swift-openapi-generator (needs `swift`) and regenerates clients/swift
git add clients/swift
git diff --cached --stat        # review the regenerated delta
git commit -m "chore(api): regenerate Swift client from current OpenAPI spec"
```

Then run the iOS build locally to confirm both jobs are green:

```sh
npm run check:api-drift:swift   # gen + `git diff --exit-code -- clients/swift`
( cd ios && swift build )       # mirrors the "iOS app — Swift build" job
```

If the regeneration changes the `postApiV1AuthPasskeyLoginStart` signature
further, reconcile `APIGateway.swift` accordingly (it should remain a no-body
call for the usernameless flow).

## Why it wasn't finished here

The web execution sandbox has no Swift toolchain (`swift` is absent), so
`npm run gen:api:swift` (which builds `apple/swift-openapi-generator` via
`swift build`) cannot run, and `APIGateway.swift` cannot be compile-verified.
Editing generated output by hand would be unreliable, so regeneration is left to
a Swift-equipped environment (macOS CI or a developer machine).
