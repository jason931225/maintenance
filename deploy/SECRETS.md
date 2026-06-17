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

## `mnt-db-app` — database connection (auto-generated)

Created by CloudNativePG for the `mnt-db` cluster's `mnt_app` user. The workloads
read `DATABASE_URL` from its `uri` key — **do not create this manually.**

## CI / release secrets (GitHub repo settings)

- `RELEASE_PLEASE_TOKEN` — fine-grained PAT (contents:write) so the release tag
  triggers `image-release.yml` + `release.yml` (see `release-please.yml`).
- Mobile signing + store credentials — see `docs/release/SECRETS.md`.
- GHCR push uses the built-in `GITHUB_TOKEN`; image signing is keyless (OIDC) —
  no secret needed.
