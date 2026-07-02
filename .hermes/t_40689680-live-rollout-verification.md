# t_40689680 live rollout verification attempt

Timestamp: 2026-07-01T21:55:24Z
Target: https://console.knllogistic.com/financial

## What was verified

- Live host responded over HTTPS.
  - `curl -I -L https://console.knllogistic.com/` returned HTTP/2 200.
  - `last-modified: Wed, 01 Jul 2026 09:05:04 GMT`.
- Live web bundle contains the purchase-request rollout strings expected from the compact UX work:
  - `/assets/utils-DgGHV4rN.js`
  - `구매요청 작업공간 설정`
  - `작성 → 결재 상신 → 관리자 승인 → 지출결의 → 집행`
  - `호기 연결 구매`
  - `견적서 업데이트 후 상신`
  - `구매요청서 작성`
- Direct browser navigation to `/financial` did not expose the authenticated workflow. It redirected to `/login?next=%2Ffinancial`.
- Browser state had no authenticated cookies (`document.cookie` empty) and only `maintenance_console_device_id` in localStorage.
- Protected API without a bearer token returned the expected auth gate:
  - `GET https://console.knllogistic.com/api/v1/financial/purchase-requests/preferences`
  - status `401`
  - body `missing or malformed bearer token`
- Browser console on the live login page had no JS errors or console messages.

## What remains blocked

The required authenticated production browser story could not be executed because this environment has no real production authenticated session or approved live-test credential path. The untested live steps are:

- requester creates purchase request from the compact first screen
- line items, VAT, totals
- quote upload/access
- anomaly/quote-update gate
- approval/review and final-approval path
- requester visibility
- non-equipment purchase path
- spacing/margins during the full workflow
- DB-backed preferences persistence

## Next safe action

Provide an approved production live-test credential/session path, or a delegated human-in-browser session, then rerun the full `/financial` user story on the live host. Do not use local E2E OTP fixtures against production unless explicitly approved for a disposable production test tenant.
