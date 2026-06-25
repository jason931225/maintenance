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
  `cargo test --workspace` (170 suites / 302 tests / 0 failed), the four
  `mnt-gate-*` binaries (layer-boundary, audit-coverage, migration-safety,
  pii-no-logs), tri-client drift (ts/kotlin/swift), openapi-app, contract
  round-trip, i18n + parity, iOS build + behavior tests. See
  [CI-GATES.md](CI-GATES.md).
- [x] **Supply-chain CI shipped** — Eng. `image-release.yml` builds the
  `mnt-app` + `mnt-web` images multi-arch (incl. linux/arm64 for the A1 target),
  reproducibly (digest-pinned bases, `SOURCE_DATE_EPOCH`), with SBOM + SLSA
  provenance, a **blocking Trivy HIGH/CRITICAL scan before keyless cosign
  signing**, pushed to GHCR. `security.yml` (Trivy fs/IaC + cargo-audit + npm
  audit) runs on a schedule; `release-please.yml` enforces SemVer; Actions are
  SHA-pinned; Renovate keeps bases/deps current.
- [x] **Post-launch security remediation pass complete** — Eng. A repo-wide
  audit (security / quality / performance) was triaged and fixed: the cold-start
  OTP is now a deploy-time secret (no known value in git — see §7), the
  admin-OTP cross-branch IDOR is closed, the unauthenticated intake is bounded
  (field-length caps + 2 MiB body limit + 30 s timeout + trusted-proxy rate-limit
  IP), the web tier ships CSP + HSTS, and `list_tickets` is paginated. All
  re-verified (workspace tests + 4 gates + client-drift gate).
- [x] **Adversarial review → harden → fix complete.** The security and
  correctness/concurrency reviews are filed in
  [`.omc/review/`](../.omc/review/); all 7 confirmed findings are fixed and
  independently re-verified (passkey-ceremony atomicity, audit-gate path
  binding, /sync payload-binding, /sync crash recovery, WORM post-completion
  guard + DB trigger, P1 alert exactly-once lease, negative-residual flooring),
  each with a red-green regression test.
- [x] **Migrations append-only through 0023**; migration-safety gate enforces no
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
- [x] **Engineering consent controls wired** — Eng. Console initial login now
  blocks first passkey enrollment until the current required 개인정보 수집·이용
  notice and service terms are accepted as separate required items; acceptance is
  tenant-scoped audit evidence. Public storefront has a cookie/privacy notice and
  footer copyright/version. This does **not** replace the 경영/법무 sign-off item
  above.

## 3. Infrastructure & deployment — 운영

- [ ] **OCI Compute (Ampere A1) provisioned** and access provided — 운영. Two
  deploy paths are ready: the Compose stack (`ops/`) for a single VM, or the
  GitOps Kubernetes path in [`deploy/`](../deploy/README.md) (single-node Talos +
  Argo CD + Argo Rollouts blue/green + CloudNativePG PITR + cert-manager/Traefik),
  sized for the OCI **Always Free** tier (ap-chuncheon-1). Note the free-tier
  caveat: custom-image import needs a PAYG account (stays $0 within Always-Free
  shapes) — see [`deploy/talos/README.md`](../deploy/talos/README.md).
- [x] **Deploy automation built + validated** — Eng. `deploy/` is kustomize/
  kubeconform-clean (30/30, CRDs included), the Talos machine config is
  `talosctl validate --mode cloud`-valid, all upstream operator refs resolve, and
  the `mnt-web` image builds + serves. Blue/green Rollouts smoke-gate the preview
  before cutover (automatic rollback on failure); Argo CD self-heals.
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
- [ ] **Cold-start admin OTP set as a deploy-time secret** — 운영. Production must
  set `MNT_COLDSTART_OTP` to a CSPRNG value (the committed `coss0000` is
  dev-only and is revoked by migration 0023); it seeds the first SUPER_ADMIN
  sign-in at boot, short-TTL, and must be redeemed-or-revoked immediately. See
  [`deploy/SECRETS.md`](../deploy/SECRETS.md). **Do not expose the API publicly
  with `coss0000` reachable.**
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
