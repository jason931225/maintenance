# Auth + Shell Surface Review

**Scope:** Recently-changed auth and web shell surface since commit `69553eb` — `web/src/pages/{LoginPage,OnboardingPage,AdminSettingsPage}.tsx`, `web/src/components/shell/{Topbar,PageHeader}.tsx`.

**Verdict:** APPROVE with minor follow-ups. No correctness, security, or data-integrity defects were found on this surface. Every confirmed finding is cosmetic polish or a single accessibility gap. All findings were adversarially verified against source; refuted/overstated claims were dropped or downgraded.

**Counts:** 0 Critical · 0 High · 1 Medium · 6 Low · 1 needs-human (design judgment)

---

## Medium

### M1 — Clipboard copy success has no accessible announcement (WCAG 4.1.3)
**File:** `web/src/pages/AdminSettingsPage.tsx:129-139` (toggle at :138)
The copy Button toggles its visible label between `ko.admin.copy` and `ko.admin.copied`, but neither the button nor any ancestor in the `issued` block (:120-145) is a live region (`aria-live` / `role="status"`). A screen reader does not re-announce the accessible name of an already-focused button when its text content mutates, so AT users get no confirmation the copy succeeded. This breaks an existing codebase convention — `role="status"` / `aria-live="polite"` is used 12+ times elsewhere (e.g. `WallBoard.tsx:90`, `LocationConsentPanel.tsx`, `IntakeForm.tsx`).
**Fix:** Add an adjacent visually-hidden `<span role="status">` that announces the result. Prefer this over making the button's own label a live region (mutating the accessible name has inconsistent SR behavior).
**Note:** Admin-only surface; copy still works and the OTP is visibly rendered in `<code>`. Graceful degradation, so non-blocking — but it is a real AA gap confirmable from code alone (no device test needed).

---

## Low

### L1 — Issued OTP expiry rendered as raw ISO-8601 UTC string
**File:** `web/src/pages/AdminSettingsPage.tsx:142` (value assigned at :44 from `result.expires_at`)
`{ko.admin.expiresAt}: {issued.expiresAt}` prints the raw API timestamp (e.g. `2026-06-14T00:00:00Z`). The app already formats timestamps with `ko-KR` locale elsewhere (`LocationConsentPanel.tsx:303`, `MessengerPanel.tsx:459`), so the raw UTC render breaks the project's own convention and is awkward for an admin who must relay the expiry to field staff.
**Fix:** `new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(new Date(issued.expiresAt))`. Use `ko-KR` (not `undefined`) to match the rest of the app. Presentational only — the displayed value is still accurate.

### L2 — OnboardingPage active method card keeps stale description during enrollment
**File:** `web/src/pages/OnboardingPage.tsx:115-122`
When a method is pending (`active === true`, :99), the title swaps to `ko.onboarding.enrolling` (:117) but the description (:119-121) keeps rendering the original method affordance text — producing a mixed-state card (in-progress heading + now-irrelevant description) during the async WebAuthn ceremony.
**Fix:** When `active`, hide the description (`{!active && <span>...</span>}`) or swap it for a progress hint (`ko.onboarding.enrollingHint`).

### L3 — UserMenu uses bare `<details>`/`<summary>`; no outside-click / Escape close, no menu semantics
**File:** `web/src/components/shell/Topbar.tsx:62-103`
The dropdown is a native `<details>` disclosure (:62) with no document `pointerdown` listener and no `keydown` Escape handler, so it does not close on outside click or Escape — both standard dropdown expectations. The contained items also lack `role="menu"` / `role="menuitem"` semantics.
**Fix:** Either migrate to Radix `DropdownMenu` (Radix is already in the tree via `@radix-ui/react-slot`) or add a `useEffect` attaching `document` `pointerdown` + `keydown`(Escape) listeners to close imperatively.

### L4 — Location Settings menu item missing its icon
**File:** `web/src/components/shell/Topbar.tsx:85-91`
The three UserMenu buttons share `flex w-full items-center gap-2`. Refresh Token (:82) renders `<RefreshCw>` and Logout (:98) renders `<LogOut>`, but Location Settings (:90) renders only the label — leaving an empty icon column and a misaligned row. No pseudo-element or shared wrapper injects an icon; the import line pulls only `LogOut, Menu, RefreshCw, User`.
**Fix:** Import e.g. `MapPin` or `Settings` from `lucide-react` and add `<Icon size={16} aria-hidden="true" />` before the label.

### L5 — OnboardingPage Card overrides padding to `p-6` (sole outlier)
**File:** `web/src/pages/OnboardingPage.tsx:88`
`<Card className="grid gap-5 p-6">` is the only one of 10 app-wide `<Card>` usages that overrides the base `p-4` (`card.tsx:11`). The override is effective (not dead): `cn` uses `twMerge` (`utils.ts:5`), so `p-6` wins. LoginPage and AdminSettingsPage inherit `p-4`, making the onboarding card visually heavier.
**Fix:** Drop `p-6` for consistency, or promote `p-6` to the Card default after auditing the other 9 usages. Direction is a design-intent call.

### L6 — OnboardingPage h1 is `text-xl` while PageHeader/LoginPage use `text-2xl`
**File:** `web/src/pages/OnboardingPage.tsx:90`
The onboarding `<h1>` is `text-xl font-semibold`; the canonical shell `PageHeader` h1 (`PageHeader.tsx:24`) and the LoginPage brand h1 (`LoginPage.tsx:78`) are `text-2xl`. Semantics are fine (it is a real `<h1>`); this is a typographic-scale inconsistency only.
**Note:** The finding's "smaller than the page it came from" framing is partly weak — LoginPage's `text-2xl` h1 sits *outside* the Card as a brand title, while OnboardingPage's h1 sits *inside* the Card in the same slot as LoginPage's in-Card `text-lg` h2, against which `text-xl` is actually larger. Fix (`text-2xl font-semibold`) is optional polish.

---

## Needs Human (design judgment — not resolvable from code)

### H1 — LoginPage OTP panel has no section-level label for the fallback flow
**File:** `web/src/pages/LoginPage.tsx:99-129`
When `otpOpen`, the OTP panel is a `<div>` separated only by `border-t ... pt-4` (:100) containing just a field-level `<label>` (:101-106), Input, and submit Button — no section heading marking it as a distinct auth path, unlike OnboardingPage's titled sections.
**Why needs-human / why not a defect:** The panel is the expansion of an explicitly labeled ghost trigger — `ko.auth.otpReveal` = "처음이신가요? 일회용 코드로 로그인" (:140) — and the page subtitle (`ko.auth.subtitle`) already frames the two-path model. The secondary/fallback semantics *are* communicated, just not repeated as a panel heading. Accessibility is fine (field has a proper `<label htmlFor>`). Whether a third label clarifies or clutters a 3-element panel is a designer call.

---

## Confirmed-but-INFO (logged, not actionable blockers)

- **LoginPage h1 uses `font-bold`** (`LoginPage.tsx:78`) while PageHeader/Onboarding/AdminSettings headings use `font-semibold`. Real, but the login splash is a deliberately distinct unauthenticated surface; the original "only surface with font-bold" claim is overstated (`WallBoard.tsx:67`, `LocationConsentPanel.tsx:137` also use font-bold). Optional one-line change to `font-semibold`.
- **Card internal gap varies** — LoginPage/Onboarding use `gap-5`, AdminSettings/Equipment use `gap-4`. Not random drift: `gap-5` tracks full-screen standalone auth cards, `gap-4` tracks in-shell content cards — a plausible undocumented convention. Standardize or document if desired.
- **Auth-page centering scaffold duplicated** — `LoginPage.tsx:75` and `OnboardingPage.tsx:86` inline the identical `flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12`. Extracting an `AuthLayout` wrapper would DRY this and ease future shared branding, but two-site duplication is low-cost today.

---

## Verification Story
- **Tests reviewed:** Not the focus of this pass; no test defects surfaced among findings. OTP/expiry fixtures referenced (`LoginPage.test.tsx:202`) corroborate the raw-timestamp shape behind L1.
- **Source verified:** Yes. Every cited file:line spot-checked against working tree (`AdminSettingsPage.tsx:120-145`, `Topbar.tsx:62-103`, `OnboardingPage.tsx:86-123`, `LoginPage.tsx:74-142`). All confirmed.
- **Security checked:** Yes — no security defects on this surface. Per design context (out of scope as findings): client-side JWT decode is UI-gating only with backend re-authorization; OTP single-use/expiry, DB-backed multi-tier rate limiting, gitignored dev keys. Nothing in the changed code contradicts these.
- **Correctness/data risk:** None found. All confirmed findings are cosmetic or a single non-blocking a11y gap.
