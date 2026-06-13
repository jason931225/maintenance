# Go-Live Checklist (T6.5)

Final go/no-go gate for the 물류장비 정비/렌탈 업무 시스템 pilot launch (HQ team,
then branch waves 수도권→충청→영남→호남).

Each item is **Ready** (verified in-repo, reproducible), **Operator action**
(requires production access or a business/legal filing the build cannot perform),
or **Blocked** (depends on an Operator action not yet done). The launch is
**go** only when every Ready item is green *and* every Operator action is
signed off with evidence filed under `docs/evidence/` or `/ops`.

Owners: **Eng** = engineering (this repo) · **운영** = operator/ops (production
infra + secrets) · **경영/법무** = business/legal (filings, approvals).

---

## 1. Code & CI readiness — Eng

- [x] **All CI gates green on `main`.** fmt, `clippy --all-targets -D warnings`,
  `cargo test --workspace` (159 suites / 240 tests / 0 failed at the launch
  commit), the four `mnt-gate-*` binaries (layer-boundary, audit-coverage,
  migration-safety, pii-no-logs), tri-client drift (ts/kotlin/swift),
  openapi-app, contract round-trip, i18n + parity, iOS build + behavior tests.
  See [CI-GATES.md](CI-GATES.md).
- [x] **Adversarial review → harden → fix complete.** The security and
  correctness/concurrency reviews are filed in
  [`.omc/review/`](../.omc/review/); all 7 confirmed findings are fixed and
  independently re-verified (passkey-ceremony atomicity, audit-gate path
  binding, /sync payload-binding, /sync crash recovery, WORM post-completion
  guard + DB trigger, P1 alert exactly-once lease, negative-residual flooring),
  each with a red-green regression test.
- [x] **Migrations append-only through 0019**; migration-safety gate enforces no
  destructive change to `audit_events` or audited tables.
- [x] **No stubs/mocks in shipped paths.** Integration seams (oyatie
  `AiAssistantPort`, Bitween `IdentityProviderPort`) are port definitions only,
  with the local identity provider as the real implementation.

## 2. 위치정보법 / PIPA compliance

- [x] **Consent destruction proven** — Eng. Withdrawal from any client destroys
  `location_pings` + `location_collection_logs` in the same transaction
  (`compliance_api::withdrawal_route_destroys_location_pings_and_logs`); GPS
  coordinates are carved out of `audit_events` and never logged (pii-no-logs
  gate), per [ADR-0014](decisions/ADR-0014-locationping-destructible-store-carved-out-of.md).
- [x] **Always-visible, non-refusable GPS off switch + on-duty-only collection**
  on web/Android/iOS — Eng (T2.2).
- [ ] **KCC LBS 사업 신고 filed / legal sign-off** — 경영/법무 (T2.3,
  launch-blocking, multi-week lead). File the 신고 number + approval under
  `/ops` compliance folder before any GPS-based dispatch is enabled in
  production.
- [ ] **개인정보 처리방침 / 위치정보 이용약관** published and consent copy
  legally reviewed — 경영/법무.

## 3. Infrastructure & deployment — 운영

- [ ] **OCI Compute VM provisioned** and SSH/OCI access provided (the K8s-ready
  Compose stack: Traefik + Postgres + SeaweedFS + app + worker). See
  [`ops/README.md`](../ops/README.md), [`ops/compose.yml`](../ops/compose.yml).
- [x] **Compose prod stack boots clean** — Eng (verified in M0: 6 services
  healthy, HTTPS healthz/readyz 200, SeaweedFS with zero host ports).
- [ ] **Production TLS certificates** (Traefik) issued for the real hostname — 운영.
- [ ] **Secrets installed** per [`docs/release/SECRETS.md`](release/SECRETS.md):
  JWT signing keys, DB credentials, SeaweedFS keys, FCM/APNs, Kakao Alimtalk,
  object-storage replica — 운영. No secret is committed; all are injected via
  environment/secret store.
- [x] **Backup + PITR DR drilled** — Eng. `ops/backup/backup.sh`; full
  backup→scratch-restore cycle and a PITR-to-arbitrary-timestamp drill verified
  (RPO ≤ 5 min / RTO ≤ 1 h policy); VM-down rehearsal logged
  ([`docs/evidence/vm_down_*.log`](evidence/)). Re-run the restore drill against
  the real VM before go-live and file the evidence.
- [x] **WORM evidence interlock proven** on fresh SeaweedFS
  ([`docs/evidence/t1.4-seaweedfs-worm.md`](evidence/t1.4-seaweedfs-worm.md));
  configure the offsite WORM replica (AWS ap-northeast-2 / Naver Cloud) — 운영.

## 4. Observability — 운영 + Eng

- [x] **OTel traces + structured logs + OpenSLO** defined — Eng
  (`ops/otel-collector-config.yml`, `backend/app/slos/api-latency.openslo.yaml`,
  `api-availability.openslo.yaml`; asserted by `openslo_files` test).
- [ ] **Dashboards + alerting wired** to the production collector/back-end and a
  smoke alert fired end-to-end — 운영.
- [x] **Audit-access is itself audited and role-gated** (`/api/audit`) — Eng.

## 5. Mobile distribution — 운영

- [x] Apple Developer Program + Play Console accounts ready (operator-confirmed).
- [x] Release pipeline (fastlane/actionlint dry-runs) verified — Eng; uploads are
  honestly gated on operator signing secrets per
  [`docs/release/SECRETS.md`](release/SECRETS.md).
- [ ] **iOS signing keys/profiles + Android upload key** installed and a TestFlight
  / internal-track build distributed to the pilot devices — 운영.

## 6. Business actions — 경영/법무

- [ ] **Kakao Alimtalk templates pre-approved** (T2.6, multi-day Kakao lead). The
  escalation chain ships safely without them (it skips un-templated Alimtalk and
  flags 관리자 유선 manual-call — proven by
  `escalation_chain_skips_unconfigured_alimtalk_flags_manual_call...`), but P1
  Alimtalk delivery is disabled until approved template IDs are in config.
- [ ] **KCC 신고** (see §2) — gates GPS dispatch.

## 7. Data seeding & rollout — 운영 + Eng

- [x] **Equipment master imported** (445 units, idempotent importer with
  reconciliation + MID-formula self-check) — Eng.
- [ ] **Branch/region topology + user roster seeded** for the pilot scope; each
  branch wave gated on its seeded data — 운영 (provisioning is idempotent;
  cold-start passkey bootstrap is ready).
- [ ] **Pilot HQ team enrolled** (passkey registration via the bootstrap-credential
  one-time flow) — 운영.

---

## Go / No-Go

**GO** requires: §1 fully green (Eng — met at the launch commit); §2 KCC 신고 +
privacy policy done (경영/법무); §3 VM + TLS + secrets + a real-VM restore drill
(운영); §4 dashboards live (운영); §5 a signed pilot build on devices (운영); §6
templates submitted (경영/법무); §7 pilot roster + branch data seeded (운영).

**Current state:** the **build is launch-ready** — every Eng item is green and
reproducible at the launch commit. The remaining items are operator/business
actions (production access, secrets, legal filings) that the codebase cannot
perform on its own; each is owned and tracked above. Pilot go-live is **pending
those operator actions**, not pending further engineering.
