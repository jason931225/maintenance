# Secrets

These never live in git. Create them once in the `maintenance` namespace before
(or just after) the `maintenance` Argo app first syncs. Argo CD does not manage
or prune them.

> Upgrade path: for fully-GitOps secrets, adopt [Sealed Secrets] or [External
> Secrets] so encrypted material can live in the repo. For a 1–2 person team the
> out-of-band `kubectl create secret` below is the pragmatic, honest baseline.

## `mnt-secrets` — application secrets

Consumed by `mnt-app` / `mnt-worker` via `envFrom`. Required keys:

| Key | What |
|---|---|
| `MNT_JWT_PRIVATE_KEY_PEM` | ES256 private key (signs access/refresh JWTs) |
| `MNT_JWT_PUBLIC_KEY_PEM` | ES256 public key (verifies JWTs) |
| `MNT_S3_ACCESS_KEY_ID` | OCI Customer Secret Key — access key (evidence bucket) |
| `MNT_S3_SECRET_ACCESS_KEY` | OCI Customer Secret Key — secret |
| `MNT_MAIL_MASTER_KEY` | Base64-encoded 32-byte webmail credential KEK from OCI Vault |

Optional (enable when the integrations go live — operator-blocked on KCC 신고 /
Kakao / FCM credentials): `MNT_FCM_*`, `MNT_SOLAPI_*`.

| Key | What |
|---|---|
| `MNT_EMAIL_SMTP_USERNAME` | OCI Email Delivery SMTP credential — username (open-signup OTP relay) |
| `MNT_EMAIL_SMTP_PASSWORD` | OCI Email Delivery SMTP credential — password |

Optional, same as above: the outbound OTP email relay. The non-secret
host/port/sender are on the `mnt-config` ConfigMap (`MNT_EMAIL_SMTP_HOST`,
`MNT_EMAIL_SMTP_PORT`, `MNT_EMAIL_FROM`, `MNT_EMAIL_FROM_NAME`); only these two
credentials are secret. They come from **OCI Vault → `mnt-secrets`** (the
operator creates them once the approved sender is provisioned). Until they are
set the app logs the OTP via a stub sender instead of relaying it, so the app
boots without them. Setting any `MNT_EMAIL_*` member requires the full group.

`MNT_MAIL_MASTER_KEY` is the webmail envelope-encryption key (KEK) used to seal
tenant mail-server credentials. Generate exactly 32 random bytes, base64-encode
them, store the value in **OCI Vault**, then project it into `mnt-secrets`. Never
commit, log, paste into tickets, or reuse this key across environments. With
`MNT_MAIL_ENABLED=true` but this key absent, the app still boots and mail APIs
return 503; once it is present, the IMAP sync worker can run when object storage
is also configured.

```sh
# Generate a fresh ES256 keypair (do NOT reuse ops/.dev-secrets — those are dev-only).
# The private key MUST be PKCS#8 PEM: jsonwebtoken's
# from_ec_pem rejects the legacy SEC1 EC-private-key PEM format that
# `openssl ecparam -genkey` emits (the app fails to boot with jwt InvalidKeyFormat).
# `openssl genpkey` produces PKCS#8 directly.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out jwt-private.pem
openssl pkey -in jwt-private.pem -pubout -out jwt-public.pem

kubectl create secret generic mnt-secrets -n maintenance \
  --from-file=MNT_JWT_PRIVATE_KEY_PEM=jwt-private.pem \
  --from-file=MNT_JWT_PUBLIC_KEY_PEM=jwt-public.pem \
  --from-literal=MNT_S3_ACCESS_KEY_ID=<oci-access-key> \
  --from-literal=MNT_S3_SECRET_ACCESS_KEY=<oci-secret-key> \
  --from-literal=MNT_MAIL_MASTER_KEY=<base64-32-byte-key-from-oci-vault>
rm -f jwt-private.pem jwt-public.pem

# Example local generator for the value that must be stored in OCI Vault first:
python3 - <<'PY'
import base64, os
print(base64.b64encode(os.urandom(32)).decode())
PY
```

## `oci-objectstore-creds` — CNPG backup credentials

Consumed by the Barman `ObjectStore` for DB backups. The keys are an **OCI
Customer Secret Key** (Identity → your user → Customer Secret Keys), which is an
S3-compatible access/secret pair. Can be the same pair as the evidence keys.

```sh
kubectl create secret generic oci-objectstore-creds -n maintenance \
  --from-literal=ACCESS_KEY_ID=<oci-access-key> \
  --from-literal=ACCESS_SECRET_KEY=<oci-secret-key>
```

## Database connections — owner vs. runtime split

The cluster has **two** roles, with two secrets, deliberately separated:

| Role | Secret | Used by | Privileges |
|---|---|---|---|
| `mnt_app` (owner) | `mnt-db-app` | **migrations only**, via the `mnt-migrate` PreSync Job | owns every table; runs DDL |
| `mnt_rt` (runtime) | `mnt-db-rt` | `mnt-app` / `mnt-worker` `DATABASE_URL` | least-privilege DML, **subject to RLS** |

The running application **never** connects as the owner. Connecting as the owner
would let a compromised app `DROP POLICY` / `DISABLE ROW LEVEL SECURITY` and turn
the entire tenant-isolation boundary off, and (without `FORCE RLS`) bypass RLS
outright. `mnt_rt` is `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, owns
nothing, and only receives the GRANTs from migration `0031`.

### `mnt-db-app` — owner / migration connection (auto-generated)

Created by CloudNativePG for the `mnt-db` cluster's `mnt_app` owner user. **Do
not create this manually.** It is consumed **only** by the `mnt-migrate` Job,
which runs schema migrations automatically as an Argo CD **PreSync hook** (the
`mnt-app` image in `MNT_APP_ROLE=migrate` mode reads its `uri` key) — never by a
serving workload. The PreSync Job completes before the `mnt-app`/`mnt-worker`
Deployments roll, so the runtime `mnt_rt` role never needs DDL. See the
"Database migrations" section in [`README.md`](README.md). Migrations are
idempotent (sqlx `_sqlx_migrations` ledger), so the Job is safe to re-run on
every sync.

> Cutover ordering: create the **`mnt-db-rt`** runtime secret (below) **before**
> the first sync. The de-owned `mnt_rt` role (NOSUPERUSER, NOBYPASSRLS, owns
> nothing — migration 0031) is what makes the owner/runtime split meaningful;
> without that secret CNPG cannot bind the role and the app cannot start.

### `mnt-db-rt` — runtime connection (you create this)

The password for the managed `mnt_rt` role. CNPG reads it from this secret
(`database.yaml` `managed.roles[].passwordSecret: mnt-db-rt`) and attaches it to
the role with LOGIN. The app/worker read `DATABASE_URL` from its `uri` key.
Create it **before** the `maintenance` app first syncs so CNPG can bind the role:

```sh
# Pick a strong password; it must match what CNPG attaches to mnt_rt.
RT_PASSWORD="$(openssl rand -base64 24)"
# host = the CNPG read/write service for the cluster; db = maintenance.
RT_URI="postgresql://mnt_rt:${RT_PASSWORD}@mnt-db-rw.maintenance.svc:5432/maintenance"

kubectl create secret generic mnt-db-rt -n maintenance \
  --from-literal=username=mnt_rt \
  --from-literal=password="${RT_PASSWORD}" \
  --from-literal=uri="${RT_URI}"
unset RT_PASSWORD RT_URI
```

## Platform-admin cold start + tenant onboarding

The SaaS-vendor **PLATFORM** tier sits ABOVE every tenant. It is bootstrapped
once, out-of-band, then drives tenant onboarding.

- `MNT_COLDSTART_OTP` (optional, on `mnt-secrets`) — a one-time secret supplied
  at boot. It seeds a single bootstrap credential for the **PLATFORM admin** (the
  `Cold Start Admin` SUPER_ADMIN, re-homed to the platform sentinel org
  `00000000-0000-0000-0000-00000000face` by migration 0036), NOT a tenant admin.
  Redeeming it signs the platform admin in for first passkey enrollment; once a
  passkey exists the OTP is dead. Leave it UNSET once the platform admin has a
  passkey (the normal steady state). `MNT_COLDSTART_OTP_TTL_SECS` (default 3600)
  bounds the redeem window; the value is never logged or written to audit.
  - The platform admin's login mints a **platform token** (`platform = true` in
    the JWT), the only token accepted on `/platform/*`. A tenant token is
    rejected there (403), and a platform token is rejected on tenant `/api/*`.

- **Tenant #1 (KNL) and every later tenant** get their own admin via the
  platform onboarding flow, NOT via `MNT_COLDSTART_OTP`:
  - `POST /platform/orgs {slug,name}` (platform token) creates the
    `organizations` row, seeds that tenant's first SUPER_ADMIN, and returns a
    fresh **per-org** one-time OTP to deliver to the tenant out-of-band. This is
    the ONLY path that inserts org rows (the app's `mnt_rt` role is SELECT-only on
    `organizations` under RLS; creation runs via the audited SECURITY DEFINER
    `platform_create_organization`). The fixed `coss0000` seed removed in
    migration 0023 is never reintroduced — every onboarding OTP is generated
    fresh per org.
  - `GET /platform/orgs` lists tenants (audited cross-tenant read); the platform
    sentinel org is never listed.
  - `PATCH /platform/orgs/{id} {status}` suspends/reactivates a tenant (audited
    to the target org).

  > KNL was historically backfilled by migration 0028 and remains tenant #1; its
  > admin should be (re)issued through `POST /platform/orgs` semantics rather than
  > the global cold-start OTP, which now belongs to the platform tier.

## Native app-link association + session TTLs (non-secret config)

These are non-secret runtime config and live on the `mnt-config` ConfigMap (NOT
`mnt-secrets`). They are listed here so the operator knows where they come from
during native-app rollout.

- **Native passkeys** are inert until the platform serves the Apple App Site
  Association + Android Digital Asset Links documents at the fixed `/.well-known/*`
  paths over the RP origin. These are served public + unauthenticated; the values
  come from the ConfigMap (comma-separated lists, empty until provisioned — the
  endpoints then serve a valid empty document):
  - `MNT_IOS_APP_IDS` — iOS app identifiers `<TeamID>.<bundle-id>` (the Team ID
    from the Apple Developer account + the app's bundle id), e.g.
    `ABCDE12345.com.knl.fsm`. Multiple builds (prod/dev) are comma-separated.
  - `MNT_ANDROID_PACKAGE` — the Android `applicationId`, e.g. `com.knl.fsm`.
  - `MNT_ANDROID_CERT_SHA256` — the SHA-256 fingerprint(s) of the app's signing
    cert(s), colon-separated hex (from `keytool -list -v` / Play App Signing).
    Comma-separate multiple signing keys (e.g. upload + Play-managed).
- **Refresh-family absolute TTL** (`MNT_REFRESH_FAMILY_ABSOLUTE_TTL_SECS`, default
  `86400` = 24h) — the NIST 800-63B AAL2 absolute session-lifetime cap. A refresh
  family rotates freely within this window of its creation; past it the next
  rotation is rejected and the family revoked, forcing a fresh primary sign-in.

## CI / release secrets (GitHub repo settings)

- `RELEASE_PLEASE_TOKEN` — fine-grained PAT (contents:write) so the release tag
  triggers `image-release.yml` + `release.yml` (see `release-please.yml`).
- Mobile signing + store credentials — see `docs/release/SECRETS.md`.
- GHCR push uses the built-in `GITHUB_TOKEN`; image signing is keyless (OIDC) —
  no secret needed.
