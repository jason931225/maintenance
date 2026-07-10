# Deploy — Talos + Argo CD deployment contexts

GitOps deployment of the forklift FSM. The live deployment context today is a
single-node [Talos Linux](https://talos.dev) Kubernetes cluster running on an
Oracle Cloud **Ampere A1** instance, sized to stay inside the **Always Free** tier
(4 OCPU / 24 GB / 200 GB block / 20 GB object storage / 1 flexible LB). Region:
**ap-chuncheon-1**.

For the live OCI guest, use [`OPS-RUNBOOK.md`](OPS-RUNBOOK.md). For the additive
ADR-0022 bare-metal/on-prem HA path, use
[`OPS-RUNBOOK-baremetal.md`](OPS-RUNBOOK-baremetal.md). The on-prem path is
parallel to OCI and remains DARK until a founder/operator activation gate says
otherwise.

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
| mox | 0.0.15 (digest-pinned) | dark/internal corporate mail webapi + IMAP |

Workloads (`deploy/apps/maintenance`): `mnt-app` (API, blue/green Rollout ×2),
`mnt-web` (SPA, blue/green Rollout ×2), `mnt-worker` (jobs, rolling Deployment),
`mnt-mox` (PVC-backed StatefulSet, ClusterIP-only webapi/IMAP/metrics), `mnt-db`
(CNPG Postgres 18, single instance).

## Release & rollback model

- **Digest-pinned rollouts:** images are built/signed by CI
  (`.github/workflows/image-release.yml`) and emitted as immutable `sha256`
  digests. The prod overlay pins the `mnt-app` and `mnt-web` digests; Argo CD
  syncs that desired state. `mnt-app`/`mnt-web` deploy **blue/green**: the new
  ("preview") ReplicaSet comes up alongside the live one, the `smoke-http`
  AnalysisTemplate probes its health endpoint, and only on success is the active
  Service flipped. A failed smoke check → no flip → the old version keeps serving
  (**automatic rollback**).
- **Verified deployment claims:** only the default `scripts/deploy.sh <git-sha>`
  path, run to its final `done: ... deployed and verified` message, counts as a
  completed deployment. It verifies the Image Release run and digest artifacts,
  the Argo Application synced revision, `mnt-app`/`mnt-web` Rollout health,
  `mnt-worker` Deployment rollout, workload template image digests, running/ready
  pods whose `imageID` or image reference matches the built digests, and public
  endpoint HTTP 200s. Missing `kubectl`, missing target-cluster access, an
  unreachable Argo Application, rollout failure, or digest mismatch fails closed.
  `--digest-bump-only` / `--bump-only` updates desired prod digests only and must
  be recorded as an unverified desired-state bump, not as deployed.
- **Manual instant rollback:** `kubectl argo rollouts undo mnt-app -n maintenance`
  (the previous ReplicaSet is kept warm for `scaleDownDelaySeconds`). Or revert
  the image tag in git — Argo re-syncs.
- **Dark mox rollback:** `mnt-mox` is a single PVC-backed StatefulSet, not a
  public ingress. Roll back by reverting the manifest/config commit, removing
  `MNT_MAIL_MOX_BASE_URL` from `mnt-config` if app traffic must stop using mox,
  and scaling `statefulset/mnt-mox` to 0 only after a `/mox-data` backup/export.
  Do not delete the PVC unless a restore target has already been verified.
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

### Database migrations (automated, ordered, idempotent)

Schema migrations run **automatically** on every Argo CD sync — no manual
`sqlx migrate run` step. The `mnt-migrate` Job
(`apps/maintenance/base/migrate-job.yaml`) runs the **same signed `mnt-app`
image** in its `migrate` run-mode (`MNT_APP_ROLE=migrate`): it connects as the
table **OWNER** (`mnt_app`, via the `mnt-db-app` secret `uri`), applies the
embedded migrations, then exits.

- **Ordering:** the Job is an Argo CD **PreSync hook**
  (`argocd.argoproj.io/hook: PreSync`), so it runs to completion **before** the
  `mnt-app`/`mnt-worker` Deployments roll. The serving workloads only ever start
  against an already-migrated schema. A failed migration fails the sync and
  blocks the rollout.
- **Idempotent:** sqlx records applied versions + per-file checksums in
  `_sqlx_migrations`; a re-sync re-runs the Job but applies nothing new ("up to
  date"). `hook-delete-policy: BeforeHookCreation` recreates a fresh Job each
  sync and cleans up the prior one.
- **Owner vs. runtime split preserved:** the Job uses `mnt-db-app` (owner / DDL);
  the app/worker still connect as the de-owned `mnt_rt` role (`mnt-db-rt`), which
  cannot run DDL. **Create `mnt-db-rt` first** (the role/RLS de-own cutover) — see
  [`SECRETS.md`](SECRETS.md) ("owner vs. runtime split"). The owner `mnt-db-app`
  secret is auto-generated by CloudNativePG.

> Prod hand-off: prod was historically migrated via `sqlx migrate run`, so its
> `_sqlx_migrations` ledger already exists and matches the embedded `0001..NNNN`
> files byte-for-byte. The first automated PreSync run will therefore find every
> version already recorded and apply nothing. If any already-applied migration
> **file** was edited after being applied to prod, sqlx will reject the run on a
> checksum mismatch (by design) rather than silently re-run it — never edit an
> applied migration; add a new one.

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
- [ ] NetworkPolicy isolation is proven against the target cluster before it is
      claimed. The NetworkPolicy manifests in
      `apps/maintenance/base/networkpolicy.yaml` render through CI, but a clean
      manifest render alone is not enforcement evidence. Run these with
      `kubectl` pointed at the target:

      ```sh
      MNT_NETWORKPOLICY_PREFLIGHT=require npm run check:k8s:networkpolicy
      MNT_NETWORKPOLICY_EXPECTED_ENFORCER=cilium \
        MNT_NETWORKPOLICY_SMOKE_POSTGRES=auto \
        npm run smoke:k8s:networkpolicy-deny
      ```

      Plain Talos/flannel must fail until Cilium, Calico/Canal, or another
      policy-capable enforcer is installed and the `maintenance` NetworkPolicies
      are applied. The smoke creates temporary pods and passes only when an
      unlabeled control pod can reach the temporary `app=mnt-web` target on
      TCP/8080, an `app=mnt-app` client can use DNS, outbound HTTPS, and
      Postgres when the `mnt-db-rw` Service exists, and that same app-tier client
      is denied on a non-allowed TCP/8080 flow by the app-tier egress policy.
      Use the on-prem Cilium stage in `apps/cilium/README.md` (or document an
      explicit equivalent) and attach the smoke output before claiming isolation.
- [ ] If claiming a live deployment, run `scripts/deploy.sh <git-sha>` in default
      mode from an operator workstation that has `gh`, `git`, `curl`, `kubectl`,
      the argo-rollouts kubectl plugin, and a kubeconfig for the target cluster.
      The deployment is not complete until the script verifies Argo sync at the
      desired revision, Rollout/Deployment health, template and pod image digests,
      and public endpoint HTTP 200s. If the operator only has source/CI access,
      use `--digest-bump-only` only as an explicit desired-state bump and hand off
      to a cluster-access operator for fresh verification before any completion
      claim.
- [ ] mox dark-stack secrets are present in OCI Vault and projected to
      `mnt-secrets` before the first sync: `MNT_MAIL_MOX_WEBHOOK_SECRET` and the
      operator-held bootstrap/account credentials documented in `SECRETS.md`.
- [ ] OCI buckets `mnt-db-backups` and `mnt-evidence` created in ap-chuncheon-1.
- [ ] `mnt-mox` has a bound `mox-data-mnt-mox-0` PVC (default local-path unless
      the operator intentionally selects another storage class) and a recorded
      backup/restore plan for `/mox-data`; CNPG/Barman does not cover it.
- [ ] Cold-start admin sign-in secured — **see the security note below**.
- [ ] Issue a staging cert first (`letsencrypt-staging`) to avoid the LE rate
      limit, then switch the Ingress annotation to `letsencrypt-prod`.
- [ ] Verify a backup completed: `kubectl cnpg backup mnt-db -n maintenance` then
      check the `mnt-db-backups` bucket; run a restore drill (see `ops/dr/`).
- [ ] Confirm blue/green: push a no-op image bump, watch
      `kubectl argo rollouts get rollout mnt-app -n maintenance --watch`.
- [ ] Confirm dark mox without opening public mail ports: run
      `scripts/check-networkpolicy-enforcement.sh`, then port-forward
      `svc/mnt-mox` and `svc/mnt-app` and run `scripts/mox-e2e.mjs` with the
      OCI Vault secrets. Public MX/submission/IMAPS/webapi/admin exposure is a
      separate operator/founder gate.

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
  failover. Future on-prem anti-affinity expectations are documented in
  [`docs/decisions/ADR-0022-ha-workload-scheduling-expectations.md`](../docs/decisions/ADR-0022-ha-workload-scheduling-expectations.md),
  but they stay DARK until the cluster has dedicated workers and the live OCI
  guest remains single-node compatible.
- **Custom image import needs a Pay-As-You-Go account** (which stays $0 within
  Always-Free shapes) — the pure free tier can't import images directly; see the
  boot-volume workaround in `talos/README.md`.
- **20 GB object storage / 50k requests-month.** DB WAL archiving is tuned
  (`maxParallel: 1`, gzip) to stay under the request cap; photo/video **evidence**
  on the same 20 GB is the tight resource — budget it, or attach a paid bucket.
