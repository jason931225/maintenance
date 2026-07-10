# UI-M13 — Identity Console charter (build-ready)

Status: DRAFT charter (read-only planning pass, 2026-07-09). Program: Oyatie Console.
Authority: `docs/design/oyatie-console/DESIGN.md` (§3.9 lifecycle, §3.10 guardrails, §4.5 PBAC,
§4.7 grammar catalog, §4.8 rail↔main/self, §4-12 no-explanatory-UI). Backlog gate:
`docs/design/oyatie-console/LEGACY-PARITY-BACKLOG.md` Tier-1 items **1, 2, 3, 21** (item **5
operator console is OUT** — §6 boundary). Backend gap source:
`.omc/research/oyatie/backend-adequacy-audit.md`.

> **One-line thesis (verified):** the identity/credential **backend already exists and is
> fully wired** — every legacy endpoint below is live on `main`. This charter is overwhelmingly
> a **frontend re-expression** of five legacy React pages into the Oyatie person/account object
> grammar, plus **one** genuinely-new small backend surface (`/me/authz` projection). Do not
> rebuild the credential mechanics; re-express them as objects with single CTAs on the person
> card (Palantir/Teams/Slack: one action on the person, never a settings-form farm).

---

## 1. Scope statement — the superset rule

Every legacy identity capability, re-expressed in Oyatie grammar. Legacy carriers (verified files):
`web/src/pages/UsersPage.tsx`, `AdminSettingsPage.tsx` (/settings/security), `OnboardingPage.tsx`,
`ProfilePage.tsx` + `features/auth/SecurityPanel.tsx`, `GroupAdminPage.tsx`; shared auth helper
`web/src/auth/webauthn.ts`; scope switcher `web/src/features/group/GroupScopeSwitcher.tsx`; shell
`web/src/components/shell/Topbar.tsx`.

| Legacy capability (carrier) | Oyatie re-expression | Backlog |
|---|---|---|
| User CRUD + deactivate, employee-link (UsersPage) | **Account/Person** as first-class objects (BE-OBJ resolve + card); create/edit = §3.9 draft→기안, deactivate = guarded lifecycle transition (보관≠삭제), employee-link = audited `object_link` edge (person↔employee) | item 1 |
| Multi-role assignment (UsersPage drawer) | Role change = **policy-evaluated mutation with audit chip** on the person card; roles rendered as **principal attributes** (converges with the UI-M11 policy screen per the PBAC direction); assignment writes through the **receipt-gated impact preview** (§3.9.1 사전점검 reference impl) | item 1 |
| Multi-branch scope assignment (UsersPage drawer) | Scope = principal-attribute chips on the person card; edit = policy-evaluated mutation, audited | item 1 |
| Sign-in OTP issuance (UsersPage `IssueOtpDialog` + AdminSettingsPage) | **Audited action object** (`OTP issuance`) as a **single CTA on the person card** with reason; the standalone `/settings/security` OTP console is **deleted** (duplication) | item 1 |
| Credential reset = passkey wipe + re-OTP (UsersPage `ResetCredentialsDialog`) | **Audited action object** (`credential reset`) as a single guarded CTA on the person card, **step-up (passkey) + reason** required for privileged targets | item 1 |
| First-sign-in PIPA consent gate (OnboardingPage) | **Consent = versioned object** (`kr-pipa-v1-2026-06-25`), status/accept as a lifecycle transition, ties into the multi-jurisdiction PII backlog | item 2 |
| Platform-passkey enrollment + phone-QR enroll (OnboardingPage, EnrollHandoffQr) | Guided first-login flow **reusing the M5 passkey ceremony components** (`assertPasskeyStepUp`, `EnrollHandoffQr`); passkey = object born with lifecycle | item 2 |
| Desktop QR-login approval (OnboardingPage `?desktop_approve`) | **Notification-center action** (approve/deny row) — rides UI-M2b notification center | item 2 |
| Self passkey list/register/revoke + last-credential guard (SecurityPanel) | Passkey = **object with lifecycle on the self card** (셀프서비스 zone, §4.8); register = guided transition, revoke = **guarded transition** (last-credential 409 surfaced) | item 3 |
| Self name/phone edit (ProfilePage) | §3.9.0 whitelist ① **self-owned draft-direct** save via `PATCH /api/v1/users/me` | item 3 |
| Enter-subsidiary MANAGE context + per-group health (GroupAdminPage) | **Scope switcher gains a policy-gated manage context** (전결/DoA) in the Oyatie topbar; per-group health = dashboard rows, not a bespoke page; view-as is audited | item 21 |

Grammar invariants every surface must satisfy (DESIGN §4): person/account/passkey/OTP/reset/consent
are all **typed objects** (click=pin panel, drag=reference token, canonical code, audit chip);
status = chips, **no explanatory captions/subtitles** (§4-12); sensitive categories on the person
card = 접힘 + "열람 — 기록 남음" gate emitting a real view-audit event; render = policy decision
(deny-by-omission).

---

## 2. Backend gap list — exists vs needs building

**Verified EXISTS on `main` (do not rebuild — re-express):**

| Capability | Live endpoint(s) | Source (verified) |
|---|---|---|
| User list/create/update/deactivate | `GET/POST /api/v1/users`, `PATCH /api/v1/users/{id}`, `POST /api/v1/users/{id}/deactivate` | `identity/rest/src/lib.rs:185-188` |
| Self profile read/edit | `GET/PATCH /api/v1/users/me` | `identity/rest/src/lib.rs:185` |
| Role assignment + **receipt-gated impact preview** | `PUT /api/v1/policy/users/{id}/assignments`, `.../assignments/preview`; roles/templates/features/audit under `/api/v1/policy/*` | routes `identity/rest/src/lib.rs:217-223`; receipt `identity/adapter-postgres/src/lib.rs:1053,1080` (consumed in write txn — client cannot skip) |
| Multi-branch scope | `GET/POST /api/v1/branches` + branch_ids on user | `identity/rest/src/lib.rs:194` |
| Admin sign-in OTP issuance (IDOR-hardened) | `POST /api/v1/auth/admin/otp/issue` | `auth-rest/src/lib.rs:65,1197` |
| Credential reset (wipe all passkeys + mint OTP) | `POST /api/v1/auth/admin/credential-reset` | `auth-rest/src/lib.rs:66,1273` |
| Self passkey list/revoke + **last-credential guard** | `GET /api/v1/auth/passkeys`, `DELETE /api/v1/auth/passkeys/{id}` (409 on last) | `auth-rest/src/lib.rs:67-68,301-302,1446`; also `identity/rest` `/api/v1/passkeys` |
| Passkey register (self, step-up when enrolled) | `POST /api/v1/auth/passkey/register/{start,finish}` | `auth-rest/src/lib.rs:60-61` |
| Passkey step-up ceremony | `POST /api/v1/auth/passkey/login/{start,finish}` (`assertPasskeyStepUp`) | `auth-rest/src/lib.rs:62-63` |
| Phone-QR enroll handoff | `POST /api/v1/auth/passkey/enroll-handoff` + `.../device-login/poll` | `auth-rest/src/lib.rs:69-71` |
| Desktop QR-login approve | `POST /api/v1/auth/device-login/{start,poll,approve,approve-session}` | `auth-rest/src/lib.rs:70-73,304-309` |
| PIPA consent status/accept (versioned) | `POST /api/v1/auth/privacy-consent/{status,accept}` (`REQUIRED_PRIVACY_TERMS_VERSION`) | `auth-rest/src/lib.rs:74-75` |
| Group-admin manage-context | `GET /api/v1/group-admin/groups`, `POST /api/v1/group-admin/tenant-context`, `.../tenant-context/exit` | `auth-rest/src/lib.rs:78-80` |
| Audit envelope on all of the above | `with_audit` (`auth.otp.signin`, `auth.passkey.revoke`, credential-reset, policy.* …) | audit `EXISTS`, gap register |

**NEEDS BUILDING (small, mapped to audit gaps):**

| # | What | Audit gap | Cedar dependency | Ships legacy-first? |
|---|---|---|---|---|
| G-a | **`GET /api/v1/me/authz` projection** — the person/account card's PBAC-gated rendering (which role/scope/credential actions are permitted) needs one stable contract instead of JWT-claim parsing. **VERIFIED absent** (grep: zero hits). | **gap 17** | Roles-as-principal-attributes direction. **Ship legacy-matrix-backed now, marked non-authoritative**; Cedar promotion later flips the source, UI unchanged. | ✅ yes |
| G-b | **Account/Person/Credential/Consent object-kind registration** in the BE-OBJ registry (resolve + canonical code issuance) so person/account chips, `!`-code deref, and the card's history tab work. Frontend `objectRegistry.ts` fabricates person codes it cannot dereference today. | gaps 1, 2 | none (legacy-matrix identity) | ✅ ships legacy-matrix-backed; **canonical codes ride BE-OBJ2** |
| G-c | **Audit per-target timeline** (`target_id` filter on `AuditQuery`) for the person/account card History tab and the credential action-object chips. | gap 3 (smallest gap in the set; index exists) | none | ✅ yes (do first, tiny) |
| G-d | **Generalize person view-audit** (sensitive-category "열람 — 기록 남음" gate emitting a real view event, self-view exempt). | gap 18 | none | ✅ pattern **already merged** via #202/#203 person-view slice — generalize, don't build |
| G-e | **Reactivate handler** — deactivate is **one-way** (`adapter-postgres/src/lib.rs:347`, `is_active=false … AND is_active=true`); **no reactivate route exists**. For 보관≠삭제 / lifecycle-reversal the person card's activate transition needs a small `POST /api/v1/users/{id}/activate` (mirror deactivate authz). | (not in register) | none | ✅ small additive handler |

**Overlap note (S1):** self-passkey list/revoke exists on **two** surfaces — `/api/v1/auth/passkeys`
(`auth-rest`, `list_self_passkeys`/`delete_self_passkey`, guard `:1446`) and `/api/v1/passkeys`
(`identity/rest`, `list_passkeys`/`delete_passkey`, guard `:3100`). S1 should bind **one** and note the
other for later dedupe — do not wire both into the self card.

**Cedar-promotion pairing (explicit):** the 15 `authorize_org_manage_observed` role-manage sites
in `identity/rest` already run **Cedar shadow + legacy sole enforcer** (`cedar_pbac_shadow_role_manage`,
dark). This charter ships **legacy-matrix-backed** — role/scope assignment writes the legacy
assignment tables, and the UI renders roles **as principal attributes** so that when the enforce-flip
charter promotes Cedar (roles = principal attributes, policies own behavior), the assignment UI
**converges with the UI-M11 policy screen with no UI rewrite**. No slice in this charter blocks on
Cedar enforcement; all ACs phrase authorization as "policy-gated (legacy enforce, Cedar shadow)".

---

## 3. Slice plan — thin vertical slices (each independently mergeable/dark-landable)

Order: **S0 (backend, parallel) → S1 → S2 → S3 → S4 → S5**. Each = one PR to `main`, CI-green.
Frontend slices land into `ConsoleShell` (new person/account object cards) while legacy routes stay
on `AppShell` until their slice ships (two-shell coexistence, per plan AD-9/AD-10). Every slice
carries the **cross-cutting gates** below.

**Cross-cutting per-slice gates (all slices):**
- **Test/E2E**: Vitest + Testing Library units; **Playwright dev-auth browser user-story proof** for
  every credential/identity flow (real virtual authenticator for passkey ceremonies); MSW for unit
  mocks. API-only evidence is **rejected** for a UI feature claim (review-gate rule).
- **No-explanatory-UI gate**: `check-ui-strings` + a design-review pass asserting zero
  subtitles/captions/meta-notices; status via chips; only action-driving copy (§4-12).
- **RLS/mnt_rt**: any backend touch tested as real `mnt_rt` (arm `app.current_org`, NEVER BYPASSRLS);
  audit-coverage gate (`with_audit` on every mutation); PBAC persona matrix (deny-by-omission — an
  unauthorized principal sees no card/action/chip).
- **ko.ts** for every string; WCAG AA; window-grammar keyboard-operable.

### S0 — `/me/authz` projection + identity object kinds (backend-only, dark-landable)
Build **G-a** (`GET /api/v1/me/authz`, legacy-matrix-backed, marked non-authoritative) and register
**G-b/G-c/G-d** identity object kinds. G-b canonical codes coordinate with **BE-OBJ2** (do not define a
second registry — register person/account/credential/consent kinds in the BE-OBJ registry; resolve the
BE-OBJ **slice-2 decision** `url_path_for` vs `objectRegistry` authority *before* wiring the person-card
route). G-c is a ~1-handler additive change (`target_id`/`trace_id` on `AuditQuery`).
- **AC**: `/me/authz` returns the permitted identity actions for the caller (mnt_rt test, per-org RLS);
  a person object resolves via `GET /api/objects/{kind}/{id}` with a canonical (non-fabricated) code;
  `AuditQuery{target_id}` returns a person's timeline; person view-audit generalizes with self-view skip.
- **Dark**: `/me/authz` mounts in `build_router` (see §4 collision — coordinate the single touch).

### S1 — Self person card (셀프서비스 zone) — re-express ProfilePage + SecurityPanel
Self **person object** card in ConsoleShell: name/phone edit (§3.9.0 whitelist ① draft-direct,
`PATCH /users/me`); **passkey = object with lifecycle** — list, register-this-device (step-up when
enrolled), phone-QR add (`EnrollHandoffQr`), **revoke = guarded transition** (last-credential 409).
Reuses M5 ceremony components. Backend **adequate** (no S0 dependency for the self card beyond view-audit).
- **AC / E2E**: register a 2nd passkey via virtual authenticator → appears as a lifecycle object;
  revoke down to the last → blocked with the guard; self name/phone save persists; RLS owner-only;
  no-explanatory-UI gate green.

### S2 — Admin Account/Person card: CRUD + role/scope as policy-evaluated mutations — re-express UsersPage
Person/account admin card (the **same person object card** UI-M9 builds — see §4 overlap): user
create/edit/deactivate, employee-link edge, **multi-role** change (receipt-gated impact preview =
§3.9.1 사전점검) and **multi-branch scope**, all as **policy-evaluated mutations with audit chips**,
rendered from `/me/authz` (S0). Roles shown as principal attributes. Single CTA per action on the card
— **not** the legacy form-drawer farm. Depends on **S0** (projection + person kind).
- **AC / E2E**: assign a role → impact-preview receipt gate enforced (server rejects skip); audit chip
  shows the real `policy.*` event; deactivate = lifecycle transition (보관, not delete) **and reactivate
  reverses it** (needs G-e activate handler — deactivate is one-way today); PBAC persona: an
  unauthorized admin sees neither the card nor the action (deny-by-omission); mnt_rt RLS tests.

### S3 — Credential admin as audited action objects — re-express OTP + reset; delete /settings/security
OTP issuance and credential reset become **single guarded CTAs on the person card** as audited action
objects with reason; **step-up (passkey) required** for privileged-target reset. **Consolidates and
deletes** the standalone `/settings/security` OTP console (`AdminSettingsPage` duplicates UsersPage's
OTP — Palantir/Teams put the action on the person, not a separate console). Backend **adequate**
(`admin/otp/issue`, `admin/credential-reset`). Depends on **S2** (person card).
- **AC / E2E**: issue OTP from the person card → single-use code shown once, `auth.otp.*` audit event
  emitted, action-object chip on the card; credential reset requires a fresh step-up assertion +
  reason; IDOR guard proven (mnt_rt, cannot reset a more-privileged user); `/settings/security` route
  removed and its parity items covered here (backlog gate).

### S4 — First-login onboarding flow — re-express OnboardingPage
Guided first-login: **consent = versioned object** (status/accept, `kr-pipa-v1-2026-06-25`) gating
enrollment; platform-passkey + phone-QR enrollment (M5 components); **desktop QR-login approval =
notification-center action row** (rides UI-M2b, merged). Backend **adequate**. Depends on **S1**
(ceremony components) + UI-M2b (notification center).
- **AC / E2E**: full first-login in a browser with virtual authenticator — consent object accepted
  (versioned, audited) → passkey enrolled → routed to overview; a desktop QR session approved from the
  phone appears and resolves as a notification-center action; RLS; no-explanatory-UI (the Korean PIPA
  legal notice is action-driving legal copy, explicitly allowed — not a caption).

### S5 — Group manage-context via scope switcher — re-express GroupAdminPage
Fold enter-subsidiary MANAGE into the Oyatie **topbar scope switcher** (`GroupScopeSwitcher`): a
**policy-gated manage context** (전결/DoA) that starts a delegated tenant-context (view-as MANAGE,
audited) and enters the chosen module; per-group health = **dashboard rows**, not a bespoke page.
Retire the `/settings/group` route. Backend **adequate** (`group-admin/groups` + tenant-context + exit).
- **AC / E2E**: switch into a subsidiary MANAGE context → delegated token minted, view-as audited,
  scope chips reflect the authorized 법인 union ("그룹 전체" = union, never literal all); exit restores
  group scope; per-group health rows drill to the real member-org objects; PBAC persona.

---

## 4. Collision surface (vs active lanes)

- **BE-OBJ2** (object-layer): **real overlap, coordinate.** S0/S2/S3 consume the BE-OBJ registry for
  person/account/credential/consent kinds + canonical codes. Identity Console **must not define a
  second registry** — it registers identity kinds in BE-OBJ. Blocker to resolve first: the BE-OBJ
  **slice-2 decision** (`backend/app/src/objects.rs:570` `url_path_for` vs frontend `objectRegistry`
  route authority — they already diverge for `support_ticket`). Pick one authority before wiring the
  person-card route. Files: `backend/app/src/objects.rs`, `web/src/lib/objectRegistry.ts`.
- **WF-HARDEN** (engine reads + SoD): **no overlap.** Identity Console does not touch
  `decide_waiting_task` or workflow runtime. Boundary note: role/scope/org changes here are **direct
  policy mutations (legacy enforce)**, NOT engine approval documents in v1 — the UI-M9 "org edit =
  조직 개편 결재" path is a *separate* surface; do not conflate person-role assignment with org-restructure
  approvals.
- **audit-chain PR-2** (`GET /api/audit/attestation`): **shared file — `backend/app/src/build_router`
  (`app/src/lib.rs:1273`) is the monorepo collision hotspot.** S0's `/me/authz` mount is a second
  `.merge(...)` in `build_router`. Sequence the two `build_router` touches with the lead + audit-chain
  PR-2 (rebase-order coordination, not a design collision). audit-chain's worker/table are otherwise
  disjoint.
- **UI-M3** (overview) + **UI-M9** (person card): **real overlap, share don't fork.** (a) S4's desktop
  QR approval + first-login items are **rows in the UI-M2b notification center / UI-M3 action inbox** —
  reuse that aggregation, do not build an identity inbox. (b) **S2's admin person card is the SAME
  person object card UI-M9 builds** — Identity Console owns the **identity/credential zone** of that
  card (roles, scope, credentials, OTP/reset actions); UI-M9 owns the HR/기본/직무/민감 zones. One card,
  two contributing slices — coordinate ownership of `PersonCard` so it is built once. Person view-audit
  (gap 18) is the shared sensitive-view gate.

---

## 5. Explicit non-goals + operator-console boundary

**Out of scope (this charter):**
- **Item 5 — Vendor multi-tenant operator console (`/platform/*`)**: tenant provision/activate/
  suspend/archive + guarded force-erase, group CRUD + org assignment, bootstrap/group-account OTP,
  cross-tenant ops health, read-only view-as-tenant impersonation. This is a **distinct operator
  persona/surface**, not the tenant console. Decision (separate operator program vs operator-scoped
  module) is **undecided** and explicitly deferred. **The `/platform/*` legacy routes MUST outlive
  this charter** — they are not deleted at the AppShell endgame until the operator decision lands.
  (Note the seam: group-admin manage-context in S5 uses `/group-admin/*`, which is the **tenant-side**
  delegated context — distinct from the **operator-side** `/platform/*` tenant lifecycle. Do not merge.)
- **Cedar enforce-flip** (roles→principal-attributes enforcement, covert clearance / gap 26): separate
  promotion charter. This charter ships legacy-matrix-backed and UI-stable across the flip.
- **Item 4 — 4대보험 acquisition/loss + offboarding settlement + severance**: separate HR charter
  (extends UI-M8/M9).
- **No-code policy visual canvas** (UI-M11 follow-on): the role-assignment UI here is the receipt-gated
  matrix, not the canvas.
- **Multi-jurisdiction PII program**: S4 consent object ties in but the broader jurisdiction/consent
  program is its own charter.

**Milestone placement:** UI-M13, per LEGACY-PARITY-BACKLOG item 1. Prerequisites already met: M5 passkey
ceremony components (built), UI-M2b notification center (merged, #198), person view-audit (#202/#203).
New prerequisite built in-charter: S0 `/me/authz` + BE-OBJ identity-kind registration.

---

## 6. Open questions (resolve before/at execution)

1. **PersonCard ownership** (S2 ↔ UI-M9): confirm Identity Console builds the identity/credential zone
   of a shared `PersonCard` and UI-M9 builds the HR zones — vs one slice owning the whole card. Affects
   sequencing (does UI-M9 land first?). — *Why it matters:* prevents building the person card twice.
2. **`/me/authz` ownership** (S0 vs UI-M10): the audit path slots `/me/authz` "at UI-M10 latest".
   Identity Console is the natural first consumer — build it here (legacy-backed, non-authoritative), or
   consume a UI-M10 build? Recommend **build here**. — *Why:* the person card's gating needs the stable
   contract now.
3. **BE-OBJ slice-2 routing authority** (`url_path_for` vs `objectRegistry`): must be decided before the
   person-card route wires. — *Why:* they already diverge; shipping both is a defect.
4. **Group manage-context vs operator view-as**: confirm S5 (`/group-admin/*` tenant-side delegated
   MANAGE) is in-scope and the operator-side `/platform/*` impersonation stays out. — *Why:* the two
   look similar and must not be merged.
