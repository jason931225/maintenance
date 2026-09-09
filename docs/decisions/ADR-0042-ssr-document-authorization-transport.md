---
id: ADR-0042
status: proposed
doc_status: review
date: 2026-09-08
owner: jasonlee
decision: ssr-document-authorization-transport
proposes_amendments_to: [ADR-0030]
related: [ADR-0004, ADR-0025, ADR-0030, ADR-0041]
---

# ADR-0042 — Authorization transport for SSR documents

## Status

**Proposed 2026-09-08.** This record decides nothing. It states a measured
defect, names the options, and asks for a decision. It declares no amendment
authority and clears no HOLD.

## Context

The Leptos SSR surface authorizes a **document navigation** with an **API
transport**. Those do not meet, so no browser can reach an authorized screen.

`bearer_token()` in `crates/platform/request-context` is the extractor behind
`resolve_principal`, which both `/` composers reach: the shipping-screen listing
floors and `visible_run_summaries` via `list_runs_page`. It reads
`Authorization: Bearer` and nothing else; there is no cookie fallback on these
routes. (`console-platform-realtime` does accept a token through
`Sec-WebSocket-Protocol` -- a genuinely browser-usable transport -- but that is a
WebSocket upgrade, not a document navigation, and it does not compose these
screens.) That is deliberate: the mint documents the access token as
*"ALWAYS in the body … a short-lived in-memory bearer token, never a cookie"*,
and the only cookie in the system, `console_refresh`, is HttpOnly, path-scoped
to the auth namespace, and read solely by refresh and logout.

For `POST /api/v1/...` from a fetch client this is a good design and is not in
question here. But `/`, `/organization`, `/hr` and `/payroll` are documents a
person navigates to. A browser cannot attach an `Authorization` header to a
top-level navigation, and no API exists to make it do so.

### Measured

Real `console-app`, real PostgreSQL with all 225 migrations, real ES256 issuer,
one seeded PayRun, one `SUPER_ADMIN` bound to the tenant. Same URL, same server,
same session:

| Client | Result |
|---|---|
| `curl -H "Authorization: Bearer …"` | 6,964 bytes — island, filter, run row |
| Browser navigation (Chromium) | 3,016 bytes — empty shell, body text `""` |
| Browser navigation holding a valid token in `localStorage` | empty shell |
| Browser `fetch('/')` with the header | island, run row |

Request headers Chromium actually sent on the navigation: `sec-ch-ua`,
`sec-ch-ua-mobile`, `sec-ch-ua-platform`, `upgrade-insecure-requests`,
`user-agent`. No `Authorization`, and no way to add one.

### Why every gate is green

The persona real-backend E2E (#978) and the deny-by-omission suites set the
header programmatically, as an HTTP client must. They prove the composition is
correct **given** a principal. Nothing in the suite asserts that the intended
client can supply one, so the gap is invisible from inside the test suite and
was invisible through #952, #959, #962, #964, #976, #978, #982 and #1010-#1012.

### What this costs today

Every human visitor gets a blank page. The screens are reachable only by clients
that set the header, and those clients do not execute WebAssembly — so the
island hydration built in #962/#964 cannot fire for any real user. Production
exposure is on HOLD, so this is not a live incident; it is a design gap that
must close before exposure is even meaningful.

## Options

1. **SSR session cookie.** A cookie accepted *only* by the UI document GETs,
   HttpOnly and `SameSite=Lax`, minted at login beside the existing pair. The
   API keeps bearer-only. Preserves server-rendered authorized HTML, which is
   ADR-0030's premise. `Lax` already withholds the cookie from cross-site
   requests and these routes are read-only and non-mutating, so CSRF surface is
   small — but it is a new credential at a new boundary and needs Red Team,
   Zero-trust, and blast-radius review, plus a decision on whether it shares the
   access token's TTL, rotation, and revocation.
2. **Client bootstrap.** Serve the shell to everyone; let JS re-request the page
   with the header and swap the result in. Works with zero auth change, and
   discards SSR: first paint is unauthenticated, auth moves into the client, and
   deny-by-omission stops being server composition — which ADR-0030 chose SSR to
   avoid.
3. **Edge injection.** A reverse proxy terminates the session and injects the
   header. Relocates the problem rather than deciding it, and puts tenant
   authorization in infrastructure the repository does not own.

## Recommendation

Option 1, as a separately reviewed design under the high-risk method in
`docs/current/DELIVERY.md`. It is the only option that keeps authorized HTML a
server decision. Option 2 is the honest fallback if a new browser credential is
judged unacceptable; it should then be recorded as retiring SSR's authorization
role rather than as an implementation detail.

## Consequences

- Until this is decided, the SSR screens are demonstrably unusable by their
  intended client. Roadmap item 7 should say so rather than read as shipped.
- No option here is authorized by this record. It authorizes no auth-transport
  change, no cookie, no exposure, and no HOLD clearance.
- Whichever option is taken needs a regression that fails on a **header-less
  navigation**, so the suite can no longer be green while the browser path is
  broken. The existing tripwire does not serve that purpose: it sends one
  credential shape and would stay green for both the recommended cookie option
  (a new cookie name) and the client-bootstrap option (which keeps serving this
  shell). Replace it with the positive test rather than relying on it to fail.
