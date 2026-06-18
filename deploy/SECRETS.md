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

Optional (enable when the integrations go live — operator-blocked on KCC 신고 /
Kakao / FCM credentials): `MNT_FCM_*`, `MNT_SOLAPI_*`.

```sh
# Generate a fresh ES256 keypair (do NOT reuse ops/.dev-secrets — those are dev-only).
# The private key MUST be PKCS#8 (-----BEGIN PRIVATE KEY-----): jsonwebtoken's
# from_ec_pem rejects the legacy SEC1 (-----BEGIN EC PRIVATE KEY-----) that
# `openssl ecparam -genkey` emits (the app fails to boot with jwt InvalidKeyFormat).
# `openssl genpkey` produces PKCS#8 directly.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out jwt-private.pem
openssl pkey -in jwt-private.pem -pubout -out jwt-public.pem

kubectl create secret generic mnt-secrets -n maintenance \
  --from-file=MNT_JWT_PRIVATE_KEY_PEM=jwt-private.pem \
  --from-file=MNT_JWT_PUBLIC_KEY_PEM=jwt-public.pem \
  --from-literal=MNT_S3_ACCESS_KEY_ID=<oci-access-key> \
  --from-literal=MNT_S3_SECRET_ACCESS_KEY=<oci-secret-key>
rm -f jwt-private.pem jwt-public.pem
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
| `mnt_app` (owner) | `mnt-db-app` | **migrations only**, applied out of band | owns every table; runs DDL |
| `mnt_rt` (runtime) | `mnt-db-rt` | `mnt-app` / `mnt-worker` `DATABASE_URL` | least-privilege DML, **subject to RLS** |

The running application **never** connects as the owner. Connecting as the owner
would let a compromised app `DROP POLICY` / `DISABLE ROW LEVEL SECURITY` and turn
the entire tenant-isolation boundary off, and (without `FORCE RLS`) bypass RLS
outright. `mnt_rt` is `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, owns
nothing, and only receives the GRANTs from migration `0031`.

### `mnt-db-app` — owner / migration connection (auto-generated)

Created by CloudNativePG for the `mnt-db` cluster's `mnt_app` owner user. **Do
not create this manually.** Use it **only** to apply schema migrations (the
out-of-band `sqlx migrate run` / migration Job), never for a serving workload.

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

## CI / release secrets (GitHub repo settings)

- `RELEASE_PLEASE_TOKEN` — fine-grained PAT (contents:write) so the release tag
  triggers `image-release.yml` + `release.yml` (see `release-please.yml`).
- Mobile signing + store credentials — see `docs/release/SECRETS.md`.
- GHCR push uses the built-in `GITHUB_TOKEN`; image signing is keyless (OIDC) —
  no secret needed.
