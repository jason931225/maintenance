# OPS Runbook — live OCI/Talos cluster (knllogistic.com)

How ANY operator (or a fresh AI session) takes control of the running stack:
the Talos cluster, the Kubernetes/GitOps server, the database, and routine tasks.
Everything needed to recover from zero is in **OCI Vault** + this doc.

## 0. The one rule that bit us
**Never keep the only copy of a cluster credential in `/tmp` or a single laptop.**
All cluster secrets live in **OCI Vault** (`bitween-default-vault`, compartment
`cloud`, region `ap-chuncheon-1`, key `oyatie-cloud-master-key`). Retrieve any with:
```sh
oci vault secret list --compartment-id <cloud-compartment-ocid> --region ap-chuncheon-1
oci secrets secret-bundle get --secret-id <id> --query 'data."secret-bundle-content".content' --raw-output | base64 -d
```
Vault secrets: `mnt-talos-secrets` (Talos PKI / secrets.yaml — regenerates a
matching talosconfig), `mnt-talos-kubeconfig` (tar of talosconfig + kubeconfig),
`mnt-app-secrets-bundle` (tar of JWT ES256 keypair, mnt_rt DB password, coldstart
OTP, OCI S3 customer-secret-key).

## 1. Facts (region ap-chuncheon-1, prod compartment)
- Node: **mnt-fsm-node**, VM.Standard.A1.Flex 4 OCPU/24 GB (the ENTIRE free-tier
  A1 allotment — never run a second A1).
- **Reserved public IP `140.245.68.253`** (stable; DNS points here). Private `10.0.0.227`.
- k8s `v1.36.1`, Talos `v1.13.4`, single control-plane node (schedules workloads).
- Cloudflare zone `knllogistic.com` (id `42acb0af77c89c6db60b6878c1eea7e0`), all
  3 A-records (apex/www/fsm) PROXIED → `140.245.68.253`. cert-manager uses **DNS-01**
  (the proxy breaks HTTP-01); needs the `cloudflare-api-token` secret in `cert-manager`.

## 2. kubectl (works over the public IP)
```sh
export KUBECONFIG=/Users/jasonlee/.config/talos-mnt/_talos/kubeconfig   # or restore from Vault mnt-talos-kubeconfig
kubectl get nodes        # server: https://140.245.68.253:6443
```
Large responses work **only because eth0 is pinned to MTU 1500** (OCI VNICs default
to 9000; the public path drops oversized frames — ICMP frag-needed is filtered, so
PMTUD blackholes). This is baked into `deploy/talos/controlplane.patch.yaml`.

## 3. talosctl
```sh
export TALOSCONFIG=/Users/jasonlee/.config/talos-mnt/_talos/talosconfig
talosctl -e 140.245.68.253 -n 140.245.68.253 <cmd>
```
If apid (`:50000`) is flaky over the public IP, tunnel via the **OCI Bastion service**
(bastion `ocid1.bastion.oc1.ap-chuncheon-1.amaaaaaax62ibfya5kxkkxtbrrd5xnxx4yn4mlj4ir3rwicy6y4im7sqyhua`):
```sh
oci bastion session create-port-forwarding --bastion-id <bastion> --ssh-public-key-file key.pub \
  --target-private-ip 10.0.0.227 --target-port 50000 --session-ttl 10800 --wait-for-state SUCCEEDED
# then: ssh -i key -N -L 50000:10.0.0.227:50000 -p 22 <session-ocid>@host.bastion.ap-chuncheon-1.oci.oraclecloud.com
talosctl config endpoint 127.0.0.1 && talosctl config node 10.0.0.227 && talosctl <cmd>
```

## 4. Database (CloudNativePG, ns `maintenance`)
- Cluster `mnt-db`, pod `mnt-db-1` (2/2). Owner role `mnt_app` (secret `mnt-db-app`,
  auto-generated), runtime `mnt_rt` (secret `mnt-db-rt`, you create; RLS-bound).
```sh
kubectl exec -n maintenance mnt-db-1 -c postgres -- psql -U postgres -d maintenance -c '\dt'
```
- Migrations run as an Argo **PreSync hook** `mnt-migrate` (mnt-app image, MNT_APP_ROLE=migrate).
- **KNOWN fresh-deploy bug:** migrate (PreSync) needs `mnt-db-app`, but the `mnt-db`
  Cluster is a regular Sync resource → created after the hook → deadlock. Bootstrap
  the DB first (apply the Cluster/ObjectStore from the prod render). Also migration
  0033 backfills `auth_bootstrap_credentials.org_id` from its user BEFORE the user
  itself is backfilled → the cold-start cred stays NULL → 0034 fails. Fix:
  `UPDATE auth_bootstrap_credentials c SET org_id=u.org_id FROM users u WHERE u.id=c.user_id AND c.org_id IS NULL;`
  (proper fix: reorder 0033 / give the cred a default-org backfill).

## 5. The GitOps server (Argo CD, ns `argocd`)
- Argo watches branch **feat/multi-tenant-phase1** (the cutover branch), app-of-apps
  `root` → cert-manager, traefik, cnpg-operator, barman-plugin, local-path,
  argo-rollouts, cluster-issuer, **maintenance** (the app + DB + ingress).
- Install (if rebuilding): `kubectl apply --server-side --force-conflicts -n argocd -k
  https://github.com/argoproj/argo-cd/manifests/cluster-install?ref=v3.4.3` (server-side
  REQUIRED — the applicationsets CRD exceeds the 256 KB client-side annotation limit).
- Non-git secrets to create first: see `deploy/SECRETS.md` (`mnt-secrets`,
  `oci-objectstore-creds`, `mnt-db-rt` in `maintenance`; `cloudflare-api-token` in
  `cert-manager`). Material is in Vault `mnt-app-secrets-bundle`.
- App images: branch build (`gh workflow run image-release.yml --ref feat/multi-tenant-phase1`),
  digests pinned in `deploy/apps/maintenance/overlays/prod/kustomization.yaml`.

## 6. Full rebuild from zero
Talos was `dd`'d onto the boot volume (free tier blocks image import) and reads its
config from gzip'd user_data; bootstrap apid via the bastion tunnel. The complete,
tested sequence + every gotcha is in the AI memory `cluster-rebuild-runbook` and the
scripts under `/Users/jasonlee/.config/talos-mnt/` (talos-up.sh, reserve-relaunch.sh,
deploy.sh). DB + DNS data is recoverable: DB has CNPG/Barman backups (bucket
`mnt-db-backups`), evidence in `mnt-evidence`.

## 7. Free-tier guardrails
1 A1 node (4 OCPU) · ≤200 GB block · ≤20 GB object · 1 reserved IP (assigned).
Check: `oci compute instance list`, `oci bv boot-volume list`, `oci os object list`.
Delete failed custom images + console-history captures; never leave a 2nd A1 running.
