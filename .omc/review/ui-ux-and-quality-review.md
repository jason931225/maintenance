# UI/UX and Quality Review — Synthesis

**Scope:** Production logistics-equipment maintenance system (Rust backend, React web console, Android Compose, iOS SwiftUI).
**Method:** Adversarially-verified static review across UI/UX, accessibility, security, performance, correctness, architecture, AI-slop, and simplification. False positives already removed; severities reflect post-verification adjustment.
**Out of scope / by design (not findings):** backend sets no CORS; passkeys + JWT auth; the verifier returning 503 when JWT is unconfigured.

---

## Summary

| Severity | Count |
|---|---|
| CRITICAL | 1 |
| HIGH | 4 |
| MEDIUM | 13 |
| LOW | 11 |
| INFO | 1 |
| **Total** | **30** |

The single CRITICAL is an iOS camera that will hard-crash on a real device. The HIGH cluster is dominated by silent failure handling: web write-mutations that swallow errors, iOS camera failures with no user feedback, an unindexed per-keystroke autocomplete query, and a per-user/per-branch consent data-model contradiction that degrades emergency dispatch. A recurring cross-cutting theme is **platform parity divergence** (iOS vs Android vs web each handle errors, loading, and field display differently) and **missing in-flight / error feedback** in the web console.

The most consequential, device-dependent items (camera crash, touch targets, real screen-reader behavior) cannot be fully confirmed by static review and are flagged in the dedicated section at the end.

---

## CRITICAL

### iOS camera will crash on a real device — no permission flow, no usage description
- **`ios/Sources/MaintenanceFieldApp/CameraCaptureView.swift:25-74`** — `CameraCaptureView` builds an `AVCaptureSession` and calls `session.startRunning()` with no `AVCaptureDevice.authorizationStatus(for: .video)` check and no `requestAccess`. There is no `NSCameraUsageDescription` anywhere in `ios/` (`Package.swift` declares no `infoPlist` settings; grep finds no usage-description key). On a physical device, the system attempting to prompt for camera access with no usage-description string present is a guaranteed TCC crash. Even with the string, the missing `requestAccess` means the first capture either shows a black preview or relies on an implicit prompt with no graceful denied-path handling.
  - Parity break: Android correctly gates with `ContextCompat.checkSelfPermission` + a `RequestPermission` launcher and surfaces `camera_permission_denied` (`android/.../ui/FieldApp.kt:1064-1080`). A matching iOS `camera_permission_denied` string already exists (`ios/.../Resources/ko.lproj/Localizable.strings:55`) but is **dead** — never referenced in Swift.
  - **Fix:** add `NSCameraUsageDescription` to the app target; check `authorizationStatus(for: .video)` before building the session; call `requestAccess` on `.notDetermined` and only build the session on grant; on `.denied`/`.restricted` show an explanatory state with a Settings deep-link, wiring up the existing `camera_permission_denied` string to match Android.

---

## HIGH

### Web write-mutations silently swallow failures (assign / approve / reject)
- **`web/src/App.tsx:198-227`** — `assignWorkOrder`, `approveWorkOrder`, `rejectWorkOrder` act only when `response.data` is truthy and have no error branch. The openapi-fetch client returns `{ error }` with `data` undefined on HTTP errors (400/403/409/500 — the realistic state-transition failures) and does **not** throw, so the guard is silently skipped: no error state, no message, board left stale. Network rejections throw, but call sites fire these as bare `void` with no `.catch`, and there is no `ErrorBoundary`/`unhandledrejection` handler in `web/src`. The read path correctly sets `readState='error'` and renders a `role="alert"`; these three writes — the console's most consequential actions — have no equivalent.
  - **Fix:** add a write-error state surfaced via `role="alert"`, mirroring the existing read-error block. (Aside, out of cited scope: `createWorkOrder`/`IntakeForm` has the same gap.)

### iOS camera failures are swallowed silently with no user feedback
- **`ios/Sources/MaintenanceFieldApp/CameraCaptureView.swift:30-39, 95-104`** — Two silent paths: (1) input/output guarded by `if let … canAddInput`; a missing camera or failed input add leaves an empty black preview with no message. (2) `photoOutput(...)` does `guard … else { return }` and the write `catch { return }` — capture errors and disk-write failures produce no callback and no surfaced error; the sheet just sits there. The iOS caller (`FieldViews.swift:24-31`) wires only `onCapture`/`onCancel`. Android routes `onError` to a snackbar (`CameraCaptureScreen.kt:82,134` → `FieldApp.kt:204-206` `operation_failed`). `FieldViewModel` already exposes a published `messageKey`, so the fix is feasible with existing infrastructure.
  - **Fix:** add an `onError`/`onFailure` callback to `CameraCaptureView` and invoke it on missing-device, permission-denied, capture-error, and write-failure; set `messageKey` so the sheet shows an inline error instead of returning silently.

### Equipment autocomplete ILIKE prefix search has no usable index (per-keystroke sequential scan)
- **`backend/crates/workorder/rest/src/lib.rs:1705-1713`** — Filters with `management_no ILIKE $1 OR equipment_no ILIKE $1 OR model ILIKE $1` (pattern `raw%`). The only relevant index is a default-collation B-tree `(branch_id, management_no)`; PostgreSQL cannot use it for `ILIKE`. No `pg_trgm`/GIN, no `*_pattern_ops`, no `lower()` functional index, no `citext` exists across the 19 migrations. Each call scans the branch's equipment and applies three-column OR ILIKE row-by-row. For `BranchScope::All` (SUPER_ADMIN/EXECUTIVE) the scope filter emits literal `TRUE`, making it a full-table scan — worse than the finding originally stated. The web client fires this on **every** `managementNo` keystroke with no debounce, plus a parallel `/equipment/lookup` call (two queries per keystroke, `web/src/App.tsx:113-157`).
  - **Fix:** `CREATE EXTENSION pg_trgm;` then a GIN trigram index over the three columns (or per-column), or a `lower(col) text_pattern_ops` functional index for anchored prefix. Verify with `EXPLAIN`. Independently, debounce the client-side autocomplete.

### On-duty location consent rejected on branch mismatch (consent is per-user, queried per-branch)
- **`backend/crates/compliance/adapter-postgres/src/lib.rs:248-277`** — `location_consents` has `UNIQUE (user_id)` (one row per user, one `branch_id`), but `record_location_ping` queries `WHERE user_id = $1 AND branch_id = $2`. Multi-branch users are an explicit, designed concept (`user_branches PK (user_id, branch_id)`), and the ping's branch is freely chosen within the principal's scope (`compliance/rest/src/lib.rs:339-345`). So a mechanic who consented in branch A and pings branch B gets `None` → 403 "location consent is not granted," despite having granted consent.
  - This compounds in dispatch scoring: `scored_candidates` joins `location_consents lc ON lc.user_id = r.user_id AND lc.branch_id = d.branch_id` (`dispatch/adapter-postgres/src/lib.rs:1248-1249`); a branch mismatch makes the join miss and `.unwrap_or(false)` silently demotes a consented mechanic to schedule-fallback GPS rank — degrading P1 emergency dispatch. The schema and domain doc ("Current consent ledger head for one user") say per-user; only the two read-path filters impose per-branch.
  - **Fix:** the schema/domain intend per-user — drop `AND branch_id = $2` in `record_location_ping` and `AND lc.branch_id = d.branch_id` in `scored_candidates`, and reconsider the branch-mismatch error in `current_or_unrecorded`. If per-branch is actually intended, change the constraint to `UNIQUE (user_id, branch_id)` and update the user_id-only lock/read paths.

---

## MEDIUM

### Security
- **`android/.../data/session/SessionTokenStore.kt:7-18`** (and **`ios/.../PersistenceStores.swift:42-75`**) — Long-lived refresh token (30-day TTL vs 15-min access token) stored in **plaintext** SharedPreferences / UserDefaults on both clients; no EncryptedSharedPreferences/Keystore (Android) or Keychain (iOS). *Downgraded HIGH→MEDIUM:* Android already sets `android:allowBackup="false"` with explicit cloud-backup/device-transfer exclusion rules, so the most-cited backup vector is closed on Android; residual risk is rooted-device / forensic extraction. **iOS remains exposed** — UserDefaults plists are included in iCloud/Finder backups by default with no exclusion here. **Fix:** Keychain on iOS with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; EncryptedSharedPreferences on Android.
- **`backend/crates/platform/storage/src/lib.rs:1042-1050`** — `validate_upload_command` only checks `content_type` non-empty and `size_bytes >= 0`; no max size, no content-type allowlist. An assigned mechanic can presign an arbitrarily large object (storage-exhaustion / cost-amplification — unconditional, authz-gated) or an arbitrary content-type (`text/html`, `image/svg+xml`). The stored-XSS leg is **latent only** — no inline same-origin serve endpoint exists today. **Fix:** enforce an explicit max `size_bytes` and a content-type allowlist (jpeg/png/heic/pdf) before presign; add `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment` if/when evidence is ever served back.

### UX — missing in-flight / error feedback (web)
- **`web/src/features/approvals/ApprovalQueue.tsx:72-96`** — Approve/Reject buttons never disabled and show no busy state during the async mutation; double-click fires two POSTs; no success/error confirmation (card just disappears). Inconsistent with `IntakeForm`, which tracks `saving` and disables submit. Double-submit is largely self-limiting (FSM rejects the duplicate server-side), but the missing feedback is real. **Fix:** track a per-work-order `busyId`, disable + label both buttons during the mutation, surface a transient success/error.
- **`web/src/features/messenger/MessengerPanel.tsx:384-399`** — Send button never disabled for empty composer / missing thread, and no busy state during the multi-step presign→upload→confirm attachment flow; a double-click can produce a duplicate message **and** duplicate evidence upload. **Fix:** disable Send when `!selectedThread || !composer.trim()`; add an `isSending` state with a pending label across the full `handleSend`.
- **`web/src/features/kpi/KpiDashboard.tsx:105-114`** — KPI period is a bare `Input` with only `aria-label`: no placeholder, no helper text, no validation. Each keystroke triggers a full dashboard refetch (no debounce), and a partial value reliably 400s → loading/error flicker. **Correction to the original finding:** the required format is `YYYY-MM-DD..YYYY-MM-DD` (a date range, per `kpi-format.ts` + backend `parse_period`), **not** `YYYY-MM`. Mitigated by a valid pre-populated default. **Fix:** add a placeholder/hint showing the range format, validate before refetch, debounce.
- **`web/src/features/location/LocationConsentPanel.tsx:117-244`** — `isLoading` only disables the refresh button; no spinner/skeleton/`role="status"` on initial or refresh load, so the panel shows fallback defaults (`NO_RECORD`, `may_collect=false`) that look like a real wrong state. CSV export has no busy/success feedback; transition buttons show only `disabled` with no pending label. Deviates from the app's own `role="status"` + `ko.common.loading` convention. **Fix:** render a `role="status"` loader while `isLoading`; add busy/success to export; add pending labels to transition buttons.

### UX — platform parity (mobile)
- **`android/.../ui/FieldApp.kt:215-432`** — Zero progress indicators anywhere in Android (`grep` for any `*ProgressIndicator` returns nothing); `busy` only sets `enabled=!busy`. iOS renders `ProgressView("loading")` overlays on Today and Messenger. Slow field networks look frozen. (LoginScreen swaps its label to "처리 중" — the lone exception.) **Fix:** add a `CircularProgressIndicator`/`LinearProgressIndicator` driven by `busy` on Today, Messenger, detail, and camera-upload flows.
- **`ios/.../FieldViews.swift:292-370`** — Work-order detail field set diverges: iOS shows `symptom` but not the target due date; Android shows due date (`due_format`) but not `symptom` (and `symptom` is absent from Android's `TechnicianWorkOrder` model entirely). Row subtitles diverge too (iOS: customer only; Android: customer + site). A scheduling risk when technicians switch devices. **Fix:** pick a canonical field set — add `targetDueAt` + site to iOS, add `symptom` to Android (requires extending the Android model/mappers).
- **`ios/.../FieldViews.swift:255-259`** — Messenger timestamps show time-only (`date: .omitted`); Android uses `ISO_LOCAL_TIME` (`FieldApp.kt:825`). Both drop the date. With "load older" paginating prior-day messages into a flat list with no day separators, send-date is unrecoverable — material for an auditable chat. **Fix:** date-aware/relative format on iOS; localized date-time formatter (not `ISO_LOCAL_TIME`) on Android.
- **`ios/.../CameraCaptureView.swift:46-65`** — Cancel/shutter are bare `UIButton(type: .system)` with only title + position constraints; no width/height anchors. 2-glyph Korean labels ("촬영"/"취소") give an intrinsic hit area that can fall below the 44×44pt HIG minimum — hard to hit with gloves. Android enforces `heightIn(min = 48.dp)` full-width buttons. **Fix:** give the iOS controls explicit ≥44pt hit areas (anchors or `UIButton.Configuration`); consider a filled/circular shutter. *(Exact rendered size is device-dependent — see final section.)*

### Architecture / correctness (backend)
- **`backend/crates/financial/adapter-postgres/src/lib.rs:231-253`** — `prepare_expenditure` reads the purchase and `purchase_threshold` **outside any transaction** to compute `next`, but `transition_purchase` re-reads under `FOR UPDATE` and recomputes `to` whenever `status == AdminApproved` (always true on this path), discarding `next`. Dead logic on the live path + a redundant unlocked SELECT (and a second redundant row read). The in-lock recompute is correct, so this is maintainability, not a bug. **Fix:** drop the unlocked reads and `next`; pass a placeholder and let `transition_purchase` derive `to` under the lock.

### Slop (clients)
- **`web/src/features/messenger/MessengerPanel.tsx:232-246`** — In `uploadWorkOrderAttachment`, `presign.data` is rebuilt by spreading the object/`upload` and `.map`-ing `headers` to the identical `[string, string]` tuple the schema already declares — a pure no-op that falsely implies normalization. **Fix:** pass `presign.data` / `presign.data.upload` / `presign.data.id` directly (keep the `EvidencePresignResponse` import; it's still `putEvidenceUpload`'s param type).
- **`web/src/features/messenger/MessengerPanel.tsx:435-439`** — `putEvidenceUpload` does `await fetch(...)` and never inspects the response, so a failed presigned PUT (403/5xx) is treated as success and the code confirms an evidence id pointing at zero bytes. Both siblings guard: Android `EvidenceRepository.kt:69-72` throws on `!isSuccessful`; iOS `EvidenceRepository.swift:243-246` throws on non-2xx. Web is the lone divergent path. **Fix:** `if (!res.ok) throw …` before confirming, so `handleSend`'s catch surfaces `ko.messenger.sendFailed`.

---

## LOW

### Security
- **`backend/crates/workorder/rest/src/lib.rs:712-765`** — `/sync` batch enforces no upper bound on `operations.len()`; `Vec::with_capacity(len)` then a sequential per-op DB-write loop. *Downgraded MEDIUM→LOW:* axum 0.8 applies a built-in 2 MB `DefaultBodyLimit` (never disabled), capping a real batch at ~10k–17k ops (not "hundreds of thousands"), neutralizing the memory-exhaustion lead. Residual: one authenticated principal can monopolize a pooled DB connection with a ~10k-op sequential replay. **Fix:** cap `operations.len()` (e.g. reject >200 with 413/422 before the loop and `with_capacity`).
- **`backend/crates/workorder/rest/src/lib.rs:652-665`** — `RestError::from_db` returns raw `sqlx` error strings (and the 23505 constraint name) verbatim in 500/conflict bodies; the same copy-pasted mapper appears across financial/inspection/registry/messenger/compliance crates, so the schema-disclosure is system-wide (OWASP A05). **Fix:** log full error server-side with `trace_id`, return a generic stable client message; generic conflict message for 23505. *(verdict: unverified — confirm the mapper is shared as described.)*

### Correctness (backend) — *all unverified; confirm before acting*
- **`backend/crates/dispatch/worker/src/lib.rs:133-167`** — Disabled-Alimtalk branch calls `claim_alimtalk_no_ack_alerts`, which sets `status='SENDING'` before `skip` marks them SKIPPED — directly contradicting the comment that says alerts must not transiently enter SENDING. A crash in the window leaves rows SENDING until the 2-min lease TTL reclaims them (self-healing). **Fix:** add a select-PENDING→mark-SKIPPED store method that never enters SENDING, or correct the comment.
- **`backend/crates/dispatch/worker/src/lib.rs:227-249`** — `mark_alert_sent`/`failed`/`skipped` return a documented lost-lease `bool` that the worker never inspects, so the designed double-send signal is dead (mitigated by provider idempotency key). **Fix:** consume the `bool` (log/metric) or change to `()` and drop the doc-comment.
- **`backend/crates/workorder/adapter-postgres/src/lib.rs:1555-1583`** — `ensure_actor_assignment` uses `assigned == 1` exact match; if a mechanic legitimately holds two assignment rows (multiple roles) the actor is rejected as "not assigned." Reachability depends on whether a `UNIQUE (work_order_id, mechanic_id)` constraint exists. **Fix:** use `assigned >= 1`, or confirm/document the unique constraint.

### Accessibility (web) — *kpi/wallboard items unverified*
- **`web/src/features/messenger/MessengerPanel.tsx:300-322`** — Thread buttons set `aria-pressed` but `className` is a static literal — no visual selected state for sighted users (the `aria`-announced state has no visual counterpart). Sibling `KpiDashboard.tsx:122-131` pairs `aria-pressed` with a visible variant change, confirming this is a deviation. **Fix:** apply a conditional selected style (e.g. `border-slate-900`/ring or `bg-slate-100`).
- **`web/src/components/ui/input.tsx:10-17`** (and `textarea.tsx`) — `aria-invalid` is set by callers but the primitives render a static `border-slate-300`; Tailwind doesn't auto-style on `aria-invalid`, so invalid fields announce as invalid but look neutral. *Downgraded MEDIUM→LOW:* visible red error text already exists, so WCAG 3.3.1 is satisfied — this is presentation consistency, not a Level-A failure. A related gap: error `<p>` elements have no `id` and inputs no `aria-describedby`. **Fix:** add `aria-invalid:border-red-500`/`ring` variants and `aria-describedby` linkage.
- **`web/src/features/kpi/KpiDashboard.tsx:104-138`** *(unverified)* — Rollup scope switcher is four `aria-pressed` buttons with no `role="group"`/`radiogroup` container, so AT announces them as independent toggles rather than a single-select set. **Fix:** wrap in `role="group"` with an `aria-label`, or model as a radiogroup.
- **`web/src/features/kpi/WallBoard.tsx:44-52`** *(unverified)* — Wallboard polls and re-renders exception/metric counts with no `aria-live` region, so a screen-reader user is never notified when urgent/overdue counts change. **Fix:** wrap the exception strip in `aria-live="polite"`.

### UX (web/mobile) — *all unverified*
- **`web/src/features/messenger/MessengerPanel.tsx:289-291`** — Search has no empty-result message and no loading state; zero matches look identical to never-searched, and results reuse `MessageRow` with no "search results" label. **Fix:** labeled results section with an explicit empty state and a loading indicator.
- **`web/src/features/dispatch/WorkOrderList.tsx:10-18`** — Renders `dispatch.empty` whenever `length === 0`, so the loading phase (before async data arrives) misrepresents as "no work orders." Same pattern in `DispatchBoard`. **Fix:** pass a loading/error signal so the empty message shows only after a successful load.
- **`web/src/features/dispatch/DispatchBoard.tsx:87-91`** — Cards carry a bare `draggable` attribute but there are zero drag handlers/drop targets anywhere in `web/src` — dead, misleading affordance with no keyboard equivalent (the in-card assign Button is the only real path; the test name even references "dropped card"). *Downgraded HIGH→MEDIUM in findings, listed here as a UX affordance defect.* **Fix:** remove `draggable` until real DnD exists, or implement it with a keyboard-accessible alternative (move buttons / per-card status `<select>`) plus proper `onDrop` and `aria-grabbed`/roving-tabindex.
- **`ios/.../FieldViews.swift:59-60`** — Login user-ID field uses `.textContentType(.username)` for a raw UUID (inappropriate AutoFill), with no autocapitalization/autocorrect disabling and no inline format error (Android shows `error_required`); an autocapitalized/autocorrected UUID silently fails login. **Fix:** `.textInputAutocapitalization(.never)` + `.autocorrectionDisabled()`, drop `.username`, validate UUID with an inline error. Better: reconsider typing raw UUIDs at all.
- **`ios/.../FieldViews.swift:123-195`** — Messenger search shows no "no results" state on either platform; a zero-match search looks like no search ran. **Fix:** explicit post-search empty state distinct from the pre-search state, both platforms.

### Simplification (iOS) — *both unverified*
- **`ios/Sources/MaintenanceFieldCore/Messenger.swift:177-179`** — Dead `reduce(_:action:)` overload (just calls `reduce(_:_:)`); every caller uses the unlabeled form; no Android/web counterpart. **Fix:** delete the overload.
- **`ios/Sources/MaintenanceFieldCore/Messenger.swift:320-326`** — `InMemoryMessengerOutboxStore` declares both `get(requestID:)` (protocol requirement) and an identical unlabeled `get(_:)`; tests bind to the unlabeled one, so the protocol method is never exercised, and `get` has no production caller. **Fix:** remove the extra overload and update tests; reconsider whether `get` belongs on the protocol at all.

---

## INFO

- **`web/src/App.tsx:191-227`** *(unverified)* — Inconsistent API path versioning: `createWorkOrder` POSTs `/api/work-orders`, `assignWorkOrder` PUTs `/api/work-orders/{id}/assignments`, `approveWorkOrder` POSTs `/api/work-orders/{id}/approve` (all unversioned), while `rejectWorkOrder` and all reads use `/api/v1/...`. Copy-paste-divergence smell; may be load-bearing or a latent bug. **Action:** verify the four mutation paths against the server OpenAPI routes and align on `/api/v1/...` unless intentionally distinct.

---

## Requires human / device / visual verification

These items have a real, source-verifiable code defect, but their full impact (rendered pixels, screen-reader announcements, real-device behavior, gloved-hand ergonomics) cannot be confirmed by static review and should be checked on a device / with assistive tech.

- **iOS camera crash — `CameraCaptureView.swift:25-74` (CRITICAL).** The missing permission flow and absent `NSCameraUsageDescription` are confirmed in source, but the actual TCC crash and the black-preview-on-denied behavior must be reproduced on a physical iOS device (the SwiftPM build cannot be run in a simulator harness here).
- **iOS touch-target sizing — `CameraCaptureView.swift:46-65` (MEDIUM).** No enforced minimum is confirmed in source, but whether the rendered hit area truly falls below 44×44pt under a given Dynamic Type setting, and the gloved-use miss rate, are rendered-pixel / subjective-UX claims best confirmed on-device.
- **Web `aria-pressed` without visual selected state — `MessengerPanel.tsx:300-322` (LOW).** The static `className` is confirmed; the *experienced* affordance gap for sighted users and the screen-reader-vs-visual mismatch are best confirmed with a real screen reader.
- **Wallboard auto-refresh with no `aria-live` — `WallBoard.tsx:44-52` (LOW, unverified).** Whether a screen-reader user is actually never notified of count changes needs confirmation with VoiceOver/NVDA.
- **Rollup scope group semantics — `KpiDashboard.tsx:104-138` (LOW, unverified).** The "announced as four independent toggles" claim needs a real AT pass to confirm the mental-model impact.
- **iOS messenger date display and search empty-state — `FieldViews.swift:255-259, 123-195` (MEDIUM/LOW).** The formatting/empty-state code is verifiable, but the practical confusion in a real multi-day thread is a UX judgment best validated with a tester.

---

*Note: items marked "(unverified)" were not independently re-confirmed against source in this verification pass; the remaining findings are adversarially confirmed. Treat unverified backend correctness items (`ensure_actor_assignment` exact-match, API path versioning, lost-lease bool) as "confirm before acting."*
