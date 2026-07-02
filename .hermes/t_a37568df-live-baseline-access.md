# Live baseline access check — t_a37568df

Checked: 2026-07-02T01:17:54Z
Live URL: https://console.knllogistic.com/financial?tab=purchase
Browser/device: Headless Chromium 149.0.7827.55 on macOS user agent (`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36`), viewport 1280x720.

## What was verified

- `https://console.knllogistic.com/` returned HTTP 200.
- `https://console.knllogistic.com/healthz` returned HTTP 200 with body `ok`.
- HTML headers observed from the live console root:
  - `content-type: text/html`
  - `last-modified: Thu, 02 Jul 2026 00:33:04 GMT`
  - `server: cloudflare`
  - `cf-cache-status: DYNAMIC`
- Legacy `https://fsm.knllogistic.com/` reached the console root at `https://console.knllogistic.com/` with HTTP 200.
- The production root referenced live bundles:
  - `/assets/building-2-FrZc6oAW.js`
  - `/assets/index-Xwrr34wg.js`
  - `/assets/utils-DgGHV4rN.js`
- `/assets/utils-DgGHV4rN.js` is served from production and still contains purchase-request rollout strings expected from the compact purchase request work:
  - `구매요청 작업공간 설정`
  - `작성 → 결재 상신 → 관리자 승인 → 지출결의 → 집행`
  - `호기 연결 구매`
  - `견적서 업데이트 후 상신`
  - `구매요청서 작성`
- Browser direct visit to `/financial?tab=purchase` returned 200 for the SPA shell and redirected client-side to `/login?next=%2Ffinancial`.
- Login page rendered with Korean login UI:
  - `콘솔`
  - `로그인`
  - `패스키로 로그인`
  - `휴대폰으로 PC 로그인`
  - `처음이신가요? 일회용 코드로 로그인`
  - `계정이 없으신가요? 이메일로 가입`
- Browser page errors / JS exceptions: none.
- Console messages during the unauthenticated Playwright run: one expected unauthenticated network error, `Failed to load resource: the server responded with a status of 401 ()`; no JS exception accompanied it and the login UI rendered.
- Browser state had no authenticated cookies and only `maintenance_console_device_id` in localStorage.
- Protected API `GET /api/v1/financial/purchase-requests/preferences` without bearer returned HTTP 401 with body `missing or malformed bearer token`, confirming no authenticated session was available to this worker.

## Not verified / blocker

The card acceptance criteria require requester/approver authentication and visual confirmation that the compact first purchase request screen is visible on the live server. That still cannot be completed from this worker because no real production authenticated session, passkey, requester credential, approver credential, or approved live-test credential path is available in the browser environment.

I did not create an email-signup user or other production account because that would be a live production side effect and would not prove requester/approver authorization without an approved role-grant path.

The deployed bundle evidence confirms the rollout assets are live, and the login route is reachable, but the actual authenticated purchase request screen could not be opened.

## Required human/input to continue

Provide one of:

1. an approved production live-test credential/session path for requester and approver roles;
2. a real authenticated browser/session/passkey handoff that this worker can use safely; or
3. explicit authorization for a production operator to create temporary live-test accounts and grant the required roles.

Until then, deeper child cards for requester creation, quote upload/access, anomaly/approval, non-equipment flow, and preferences persistence should remain gated behind this baseline access card.

## Raw check artifacts

- Script used for the browser run: `/Users/jasonlee/Developer/maintenance-gjc-discord/.hermes/t_a37568df-playwright-live-check.mjs`
- HTTP/bundle check command output was captured in the task run transcript at 2026-07-02T01:11:50Z.
