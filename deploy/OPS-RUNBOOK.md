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
- **KNOWN fresh-deploy DB gotchas** (apply in order on a clean cluster; each has a
  proper fix to land so the next rebuild is hands-off):
  1. **DB-before-migrate deadlock.** migrate (PreSync) needs `mnt-db-app`, but the
     `mnt-db` Cluster is a regular Sync resource → created *after* the hook. Bootstrap
     the DB first: `kubectl apply --server-side -f` the Cluster + ObjectStore from the
     prod render. *Proper fix:* a pre-migrate sync-wave / separate bootstrap app.
  2. **Migration role needs BYPASSRLS.** `organizations`/`users` have FORCE RLS (0030),
     so 0034's FK validation — run as `mnt_app` (subject to RLS, no `app.current_org`) —
     sees zero orgs and the FK looks violated. `ALTER ROLE mnt_app BYPASSRLS;` (only the
     migration role; runtime `mnt_rt` STAYS NOBYPASSRLS = the real tenant boundary).
     *Proper fix:* CNPG `managed.roles` set `mnt_app` bypassrls.
  3. **0033 backfill order.** It backfills `auth_bootstrap_credentials.org_id` from its
     user, but before the user's own org backfill → the cold-start cred stays NULL →
     0034 NOT-NULL fails:
     `UPDATE auth_bootstrap_credentials c SET org_id=u.org_id FROM users u WHERE u.id=c.user_id AND c.org_id IS NULL;`
     *Proper fix:* reorder 0033 (users first) or give the cred a default-org backfill.
  4. **mnt-db-rt password must be URL-encoded** in the `uri`. `openssl rand -base64`
     yields `+`/`/`, which break `host:port` parsing → backend crashes
     `Database(Configuration(InvalidPort))`. Percent-encode the password in the uri.
     *Proper fix:* SECRETS.md uses `rand -hex` or percent-encodes.
  5. **apalis job queue needs runtime DDL grants.** The worker's apalis queue self-creates
     its tables at startup as `mnt_rt` (no apalis migration exists), needing
     `GRANT CREATE ON DATABASE maintenance TO mnt_rt; GRANT CREATE,USAGE ON SCHEMA public TO mnt_rt;`
     — else `permission denied for database/schema public`. This does NOT weaken tenant
     isolation (mnt_rt stays NOBYPASSRLS; the job queue is infra, not org data).
     *Proper fix:* create the apalis schema in a migration (as `mnt_app`) + grant mnt_rt DML.
- **Restoring from a dev/local dump:** purge dev-auth role-switch personas before pointing
  a release build at it — `DELETE FROM users WHERE phone LIKE 'dev-auth:%';`. The
  composition root refuses to boot (api/worker) if any remain (`mnt-app`'s
  `assert_no_dev_auth_personas`, compiled out only under `--features dev-auth`).

## 4.5. Dark mox mail stack (ns `maintenance`)

- Workload: `statefulset/mnt-mox` (single replica) with PVC
  `mox-data-mnt-mox-0` mounted at `/mox-data`. The image is
  `r.xmox.nl/mox@sha256:47497222e83679f95049329f12c5d8c4bfd3b809e62d4ffcfd508907e66b06a5`.
  mox must start as root and then drops to UID/GID 10001 from `mox.conf`; the
  container keeps `allowPrivilegeEscalation=false`, grants only the ownership and
  setuid/setgid capabilities needed for that drop, and
  exposes only ClusterIP ports 1080 (webapi), 1143 (plain IMAP, internal-only),
  and 8010 (Prometheus metrics). There is no Ingress, hostPort, NodePort,
  LoadBalancer, SMTP/25, submission, IMAPS, webmail, or admin interface in the
  dark deployment.
- App wiring: `mnt-config` sets
  `MNT_MAIL_MOX_BASE_URL=http://mnt-mox.maintenance.svc:1080`; the app/worker
  read `MNT_MAIL_MOX_WEBHOOK_SECRET` from `mnt-secrets`. HTTP is intentionally
  service-local and protected by NetworkPolicy; do not switch it to HTTPS unless
  the backend reqwest rustls feature/test path is updated in the same PR.
- Initial mox config: on first boot the pod copies `mnt-mox-bootstrap` into the
  PVC and renders `domains.conf` with the webhook Authorization value. On later
  pod starts it refreshes only that `Authorization: Bearer ...` line from
  `mnt-secrets`, so secret rotation propagates without overwriting other mox
  config/admin changes on the PVC; validate edits with:

  ```sh
  kubectl exec -n maintenance statefulset/mnt-mox -- /bin/mox -config /mox-data/config/mox.conf config test
  ```

- Bootstrap account password: retrieve the operator-held postmaster/account
  password from OCI Vault (see `SECRETS.md`) and set it over the in-pod control
  socket after the pod is Ready:

  ```sh
  oci secrets secret-bundle get --secret-id <mnt-mox-postmaster-password-ocid> \
    --query 'data."secret-bundle-content".content' --raw-output | base64 -d | \
  kubectl exec -i -n maintenance statefulset/mnt-mox -- \
    /bin/mox -config /mox-data/config/mox.conf setaccountpassword postmaster
  ```

  `setaccountpassword` reads stdin and stores derived verifier material in
  `/mox-data`; never paste, echo, or log the secret in shell history.
- NetworkPolicy: `default-deny-ingress` already covers the namespace.
  `allow-app-egress-mox` permits only app/worker → mox webapi/IMAP;
  `allow-mox-ingress-internal` permits only app/worker (webapi/IMAP) and the
  `monitoring` namespace (metrics); `default-deny-egress-mox` plus DNS and
  `allow-mox-egress-app-webhook` keep mox egress to DNS and the internal app
  webhook. Plain flannel does not enforce this — record a live CNI smoke before
  claiming runtime enforcement.
- Static render/policy proof:

  ```sh
  scripts/check-networkpolicy-enforcement.sh
  kustomize build deploy/apps/maintenance/overlays/prod >/tmp/mnt-prod.yaml
  ```

- Dark smoke without public MX:

  ```sh
  kubectl -n maintenance port-forward svc/mnt-mox 1080:1080
  kubectl -n maintenance port-forward svc/mnt-app 8090:8080
  MNT_MOX_WEBAPI_URL=http://127.0.0.1:1080 \
  MNT_DEV_BACKEND_URL=http://127.0.0.1:8090 \
  MNT_MOX_USER=postmaster@knllogistic.com \
  MNT_MOX_PASS=<read from OCI Vault; do not log> \
  MNT_MAIL_MOX_WEBHOOK_SECRET=<read from mnt-secrets; do not log> \
  node scripts/mox-e2e.mjs
  ```

- Backup/restore: CNPG/Barman covers Postgres only; it does **not** back up
  `/mox-data`. Before rollout, destructive changes, or PVC deletion, run mox's
  file-level backup into a scratch directory and upload the tarball to an OCI
  Object Storage bucket with explicit retention/quota approval:

  ```sh
  kubectl exec -n maintenance statefulset/mnt-mox -- /bin/mox -config /mox-data/config/mox.conf backup /tmp/mox-backup
  kubectl cp maintenance/mnt-mox-0:/tmp/mox-backup ./mox-backup
  tar -C ./mox-backup -czf mox-backup-$(date -u +%Y%m%dT%H%M%SZ).tgz .
  # upload with the operator's OCI/S3 client credentials; never store secrets in git
  ```

  Restore drill: prove this on a fresh PVC/workload when possible; for an
  in-place restore, scale mox down first and do **not** delete the old PVC or
  backup tarball until every validation below passes.

  ```sh
  BACKUP=./mox-backup-YYYYMMDDTHHMMSSZ.tgz
  kubectl -n maintenance scale statefulset/mnt-mox --replicas=0
  kubectl -n maintenance wait --for=delete pod/mnt-mox-0 --timeout=180s
  ```

  Mount the restore target PVC with a one-shot root pod. For a fresh-PVC drill,
  create the PVC first and replace `claimName: mox-data-mnt-mox-0` below with
  that claim instead of the production claim.

  ```sh
  cat >/tmp/mnt-mox-restore-pod.yaml <<'YAML'
  apiVersion: v1
  kind: Pod
  metadata:
    name: mnt-mox-restore
    namespace: maintenance
  spec:
    restartPolicy: Never
    securityContext: { runAsUser: 0, fsGroup: 10001 }
    containers:
      - name: restore
        image: r.xmox.nl/mox@sha256:47497222e83679f95049329f12c5d8c4bfd3b809e62d4ffcfd508907e66b06a5
        command: ["/bin/sh", "-ceu", "sleep 3600"]
        volumeMounts:
          - { name: mox-data, mountPath: /mox-data }
    volumes:
      - name: mox-data
        persistentVolumeClaim: { claimName: mox-data-mnt-mox-0 }
  YAML
  kubectl apply -f /tmp/mnt-mox-restore-pod.yaml
  kubectl -n maintenance wait --for=condition=Ready pod/mnt-mox-restore --timeout=120s
  kubectl -n maintenance cp "$BACKUP" mnt-mox-restore:/tmp/mox-restore.tgz
  kubectl -n maintenance exec mnt-mox-restore -- /bin/sh -ceu '
    rm -rf /mox-data/* /mox-data/.[!.]* /mox-data/..?*
    tar -C /mox-data -xzf /tmp/mox-restore.tgz
    chown -R 10001:10001 /mox-data
    chmod 700 /mox-data /mox-data/config /mox-data/data
    test -s /mox-data/config/mox.conf
    test -s /mox-data/config/domains.conf
    /bin/mox -config /mox-data/config/mox.conf config test
  '
  kubectl -n maintenance delete pod/mnt-mox-restore
  ```

  Start mox only after the restored files/config validate, then prove the live
  webapi and dark smoke before removing the old PVC/export copy.

  ```sh
  kubectl -n maintenance scale statefulset/mnt-mox --replicas=1
  kubectl -n maintenance rollout status statefulset/mnt-mox --timeout=300s
  kubectl -n maintenance exec statefulset/mnt-mox -- \
    /bin/mox -config /mox-data/config/mox.conf config test
  kubectl -n maintenance port-forward svc/mnt-mox 1080:1080
  curl -fsS http://127.0.0.1:1080/webapi/v0/ >/dev/null
  # In a second terminal, port-forward svc/mnt-app 8090:8080 and run the dark smoke:
  # node scripts/mox-e2e.mjs with MNT_MOX_* and MNT_MAIL_MOX_WEBHOOK_SECRET from Vault/mnt-secrets.
  ```

- Observability: enable `deploy/apps/maintenance/components/monitoring` only when
  Prometheus Operator CRDs exist. Scrape `svc/mnt-mox:8010/metrics` and alert on
  `MntMoxDown`, `MntMoxWebhookFailures`, `MntMoxQueueBacklog`, and
  `MntMoxPvcSaturation`. Keep mox `LogLevel: info`; never enable `traceauth` or
  `tracedata` in production because those can expose credentials or full message
  bodies.
- Rollback: revert the Git commit/config, Argo sync, and remove
  `MNT_MAIL_MOX_BASE_URL` from app config if app webmail traffic must stop using
  mox. Scale `mnt-mox` to 0 only after a successful backup/export; do not delete
  the PVC unless the restore path above has been proven.
- Public MX/operator gate: public SMTP/MX, submission, IMAPS, webapi, or admin UI
  must remain disabled until DNS MX/SPF/DKIM/DMARC/MTA-STS/TLS-RPT, TLS/cert
  rotation, queue/dead-letter behavior, abuse/rate-limit/open-relay negatives,
  monitoring/alerts, backup/restore, rollback, OCI firewall/security-list
  posture, and real client-IP visibility for junk filtering and rate-limiting are
  all proven and explicitly approved. Acceptable client-IP preservation paths
  include host networking, `externalTrafficPolicy: Local`, proxy protocol, or a
  different ingress path that mox can verify before public port 25/submission is
  enabled.

## 5. The GitOps server (Argo CD, ns `argocd`)
- Argo watches branch **main**, app-of-apps
  `root` → cert-manager, traefik, cnpg-operator, barman-plugin, local-path,
  argo-rollouts, cluster-issuer, **maintenance** (the app + DB + ingress).
- Install (if rebuilding): `kubectl apply --server-side --force-conflicts -n argocd -k
  https://github.com/argoproj/argo-cd/manifests/cluster-install?ref=v3.4.3` (server-side
  REQUIRED — the applicationsets CRD exceeds the 256 KB client-side annotation limit).
- Non-git secrets to create first: see `deploy/SECRETS.md` (`mnt-secrets`,
  `oci-objectstore-creds`, `mnt-db-rt` in `maintenance`; `cloudflare-api-token` in
  `cert-manager`). Material is in Vault `mnt-app-secrets-bundle`.
- App images: main build (`gh workflow run image-release.yml --ref main`),
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
