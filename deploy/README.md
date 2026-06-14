# Deploy — Talos + Argo CD on Oracle Cloud (Always Free)

GitOps deployment of the forklift FSM onto a single-node [Talos Linux](https://talos.dev)
Kubernetes cluster running on an Oracle Cloud **Ampere A1** instance, sized to
stay inside the **Always Free** tier (4 OCPU / 24 GB / 200 GB block / 20 GB
object storage / 1 flexible LB). Region: **ap-chuncheon-1**.

Everything below `deploy/` is declarative and reconciled by Argo CD with
self-heal — the only imperative steps are the one-time cluster bootstrap and
creating the secrets that must not live in git.

## What runs

| Component | Version | Role |
|---|---|---|
| Talos Linux | 1.13.4 | immutable, API-managed node OS (arm64) |
| Argo CD | 3.4.3 (chart 9.5.21) | GitOps engine, self-heal |
| Argo Rollouts | 1.9.0 (chart 2.41.0) | blue/green progressive delivery |
| CloudNativePG | 1.29.1 | managed Postgres + PITR |
| Barman Cloud Plugin | 0.13.0 | WAL/base backups → OCI Object Storage |
| cert-manager | 1.20.2 | Let's Encrypt TLS |
| Traefik | chart 40.3.0 | ingress (hostPort 80/443, no LB cost) |

Workloads (`deploy/apps/maintenance`): `mnt-app` (API, blue/green Rollout ×2),
`mnt-web` (SPA, blue/green Rollout ×2), `mnt-worker` (jobs, rolling Deployment),
`mnt-db` (CNPG Postgres 18, single instance).

## Release & rollback model

- **Zero-downtime version bumps:** images are built/signed by CI
  (`.github/workflows/image-release.yml`) and tagged by release-please. The prod
  overlay pins the tag; Argo CD syncs it. `mnt-app`/`mnt-web` deploy **blue/green**:
  the new ("preview") ReplicaSet comes up alongside the live one, the
  `smoke-http` AnalysisTemplate probes its health endpoint, and only on success
  is the active Service flipped. A failed smoke check → no flip → the old version
  keeps serving (**automatic rollback**).
- **Manual instant rollback:** `kubectl argo rollouts undo mnt-app -n maintenance`
  (the previous ReplicaSet is kept warm for `scaleDownDelaySeconds`). Or revert
  the image tag in git — Argo re-syncs.
- **Self-healing:** Argo CD `selfHeal: true` reverts drift; Talos restarts failed
  components; Kubernetes reschedules crashed pods.

## Bootstrap order (one time)

1. **Cluster:** provision the A1 node and bring up Talos — see
   [`talos/README.md`](talos/README.md). You finish with a working `kubeconfig`.
2. **Secrets:** create the non-git secrets — see [`SECRETS.md`](SECRETS.md).
3. **Argo CD:**
   ```sh
   kubectl create namespace argocd
   kubectl apply -n argocd -k \
     "https://github.com/argoproj/argo-cd/manifests/cluster-install?ref=v3.4.3"
   ```
4. **Hand the cluster to GitOps** (replace `OWNER` first — see below):
   ```sh
   kubectl apply -f deploy/argocd/project.yaml
   kubectl apply -f deploy/argocd/root.yaml
   ```
   The `root` app-of-apps pulls in cert-manager → operators → the issuer →
   the application, ordered by sync-waves.

### Placeholders to replace before applying

| Token | Where | Set to |
|---|---|---|
| `OWNER` | `deploy/argocd/**`, `deploy/apps/**/overlays/prod` | your GitHub org/user (repo + GHCR owner) |
| `fsm.example.com` | `overlays/prod/kustomization.yaml` | your real host (DNS A-record → node IP) |
| `NAMESPACE` | `overlays/prod`, `base/configmap.yaml` | OCI object-storage namespace (`oci os ns get`) |
| `admin@example.com` | `infra/cert-manager/cluster-issuer.yaml` | ops contact for Let's Encrypt |

## Pre-launch checklist

- [ ] DNS A-record for the host points at the node's public IP; OCI security
      list allows 80/443 (ingress), 6443 (k8s API), 50000 (Talos API).
- [ ] `mnt-secrets` + `oci-objectstore-creds` exist in the `maintenance` namespace.
- [ ] OCI buckets `mnt-db-backups` and `mnt-evidence` created in ap-chuncheon-1.
- [ ] Cold-start admin sign-in secured — **see the security note below**.
- [ ] Issue a staging cert first (`letsencrypt-staging`) to avoid the LE rate
      limit, then switch the Ingress annotation to `letsencrypt-prod`.
- [ ] Verify a backup completed: `kubectl cnpg backup mnt-db -n maintenance` then
      check the `mnt-db-backups` bucket; run a restore drill (see `ops/dr/`).
- [ ] Confirm blue/green: push a no-op image bump, watch
      `kubectl argo rollouts get rollout mnt-app -n maintenance --watch`.

## Security note — cold-start admin

The first-boot admin signs in with a bootstrap OTP. The committed dev value
`coss0000` (migration 0021) is **for local development only**. Before exposing
the API publicly, the cold-start credential must be a deploy-time secret, not a
known constant, and redeemed-or-revoked immediately on first boot. This is
tracked as the top security-remediation item; do not launch with `coss0000`
reachable from the internet.

## Honest free-tier constraints

- **Single node, no control-plane HA.** Pod self-healing and zero-downtime app
  bumps work; a node loss is a restore-from-backup event, not an automatic
  failover. A second A1 node (still Always Free) would add real HA.
- **Custom image import needs a Pay-As-You-Go account** (which stays $0 within
  Always-Free shapes) — the pure free tier can't import images directly; see the
  boot-volume workaround in `talos/README.md`.
- **20 GB object storage / 50k requests-month.** DB WAL archiving is tuned
  (`maxParallel: 1`, gzip) to stay under the request cap; photo/video **evidence**
  on the same 20 GB is the tight resource — budget it, or attach a paid bucket.
