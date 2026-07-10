# Enterprise Production Readiness

Companion to [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md). The checklist gates the
*pilot* launch; this document assesses maturity against an *enterprise*
production bar (HA, observability, supply-chain enforcement, DR) and records the
honest split between what is solved in-repo, what is limited by the current
`oci-guest` substrate, and what ADR-0022 requires before an `on-prem` /
bare-metal deployment can claim HA.

Owners: **Eng** = engineering (this repo) · **운영** = operator/ops (production
infra + secrets) · **경영/법무** = business/legal.

## Verdict

The codebase is **production-grade and pilot-ready** for the existing deployment
posture, but enterprise HA is context-specific:

- **`oci-guest` (current OCI Always Free / single-node).** The single thing that
  fundamentally caps *enterprise* maturity is not code — it is the **single free-tier node**.
  With one Oracle A1 node in one availability domain, the 2×
  API/web replicas, their PDBs, and blue/green all run on the same node, and the
  database is a single CloudNativePG instance. A node loss is a
  restore-from-backup event (RTO ≤ 1h), not an automatic failover.
  No code change moves past that; it needs provisioned, paid infrastructure
  before `oci-guest` can claim automatic node or database failover.
- **`on-prem` / bare-metal HA (ADR-0022).** This is an additive first-class
  target, not a replacement for OCI. It can claim HA only after the
  operator-provisioned substrate exists: three Talos control-plane nodes with
  etcd quorum, dedicated worker/storage failure domains, VIP/ingress failover,
  replicated block storage, CNPG `instances: 3` with synchronous failover,
  portable secrets, context-appropriate object storage, and recorded failover /
  restore drills. DARK docs/manifests are readiness inputs, not live HA evidence.

Everything that *can* be hardened in-repo without the selected substrate spend or
operator activation has been, or is tracked below.

## Deployment-context hardening properties

| Property | `oci-guest` (current live) | `on-prem-ha` / ADR-0022 (DARK until activation) |
|---|---|---|
| Acceptable secret store | OCI Vault is the recovery source; operators manually project Kubernetes secrets such as `mnt-secrets`, `oci-objectstore-creds`, and `mnt-db-rt`. External Secrets / Sealed Secrets are documented upgrade paths, not live controllers. | OpenBao HA Raft plus External Secrets Operator. OpenBao must have initialization/unseal custody, audit logging, snapshots/backups, scoped policies, and ESO projection before production credentials move. |
| Object-store endpoint and retention | OCI Object Storage S3-compatible endpoint in Chuncheon for CNPG Barman (`s3://mnt-db-backups/`) and evidence storage. Barman retention is currently indefinite/no automatic pruning in `database.yaml`; the tradeoff is unbounded storage growth under the Always Free object-storage budget and a future lifecycle/offsite-copy task. | Self-hosted S3-compatible endpoint such as SeaweedFS, MinIO, or Ceph-RGW; the staged SeaweedFS service is `http://mnt-object-store-s3.maintenance-object-store.svc.cluster.local:8333`. CNPG Barman and evidence storage credentials must come from OpenBao/ESO, with retention, WORM/evidence policy, and replication to a second physical site or equivalent independent failure domain before HA/DR durability is claimed. |
| Database/topology HA | One A1 VM, one schedulable control-plane, local/default storage, CNPG `instances: 1`, no node/database automatic failover. Node loss means restore/rebuild from Vault + Barman artifacts. | Three control-plane/etcd members, dedicated worker/storage failure domains, replicated block storage (`mnt-pg-hot`), CNPG `instances: 3`, synchronous failover posture, hostname/failure-domain spread, VIP/ingress failover, and recorded node/pod kill plus restore drills. |
| Automatic failover claim | Not present for `oci-guest`; blue/green and PDBs only cover rollout/voluntary-disruption behavior on the same node. | Claimable only after the activated on-prem substrate proves etcd/API quorum, storage health, CNPG primary promotion, ingress VIP movement, and rollback evidence. DARK manifests alone are not production failover evidence. |

## Scorecard

| Dimension | State | Notes |
|---|---|---|
| **CI / supply chain** | **Strong** | fmt + clippy `-D warnings` + workspace tests; `mnt-gate-*` (layer-boundary, audit-coverage, migration-safety, pii-no-logs); tri-client drift; cosign keyless signing; SLSA provenance + SPDX SBOM; blocking Trivy HIGH/CRITICAL; cargo-audit + npm-audit; Renovate digest pinning. |
| **Deploy / DR** | **Context-aware / strong in-repo** | `oci-guest`: Argo CD GitOps (self-heal + prune), Argo Rollouts blue/green with smoke-gate auto-rollback, CNPG + Barman PITR to OCI (RPO ≤ 5m / RTO ≤ 1h) with **tested** restore + PITR drills, OpenTofu IaC. `on-prem`: ADR-0022 requires replicated storage, provider-neutral S3-compatible object storage, a second site / failure domain for evidence and DR copies, OpenBao/External Secrets, and multi-node drills before production HA/DR claims. |
| **Security posture** | **Strong** | default-deny NetworkPolicies; PSS `restricted`; hardened securityContexts (non-root, drop ALL, seccomp, readOnlyRootFS on Rust pods); cert-manager + Let's Encrypt; HSTS + strict CSP; comprehensive tested RBAC (5 roles × 32 features, dual role+branch gate). |
| **Observability** | **Strong in-repo / ops-gated live** | Structured JSON logs; OTLP tracing in code; health/readiness/startup probes; OpenSLO objectives; Prometheus `/metrics` backing the SLOs; opt-in ServiceMonitor/PrometheusRule; Palantir/Foundry-derived operating benchmark captured in [`docs/benchmarks/palantir-foundry-ops-benchmark.md`](benchmarks/palantir-foundry-ops-benchmark.md). **Gap:** no monitoring stack deployed; no alert routing/test-fired runbooks. |
| **High availability** | **Context-specific** | `oci-guest` is capped by one node ⇒ correlated replica failure, single CNPG instance, and single worker (no leader election); PDBs/blue-green are present but structurally limited to voluntary disruptions. `on-prem` HA is documented/staged via ADR-0022 and DARK artifacts, but becomes production evidence only after real multi-node/multi-failure-domain activation and failover drills. |

## Delivered this session (in-repo, verified)

- **Metrics keystone** — `/metrics` Prometheus endpoint + request-timing
  middleware recording `http_server_request_duration_seconds` (labels
  `service_name`, `http_response_status_code`) — the exact series the OpenSLO
  files query. Previously the SLOs referenced a metric that did not exist.
  (`backend/app/src/lib.rs`, test in `tests/health_readiness.rs`.)
- **Per-workload `service_name`** (`mnt-app-api` / `mnt-app-worker`) so metrics
  and traces match the SLO selector.
- **Graceful-shutdown wiring** — `terminationGracePeriodSeconds` on all pods +
  nginx `preStop` drain on web.
- **OTLP endpoint** documented as opt-in in the ConfigMap (no longer points
  every request at a non-existent collector).
- **Opt-in monitoring component** — `deploy/apps/maintenance/components/monitoring/`
  ServiceMonitor + PrometheusRule (availability-burn + p99-latency alerts mapped
  to the OpenSLO objectives). Requires a Prometheus Operator; intentionally not
  wired into base/prod.
- **Digest-pinned GitOps desired state** — production overlay pins `mnt-app` and
  `mnt-web` by immutable `sha256` digest; `scripts/bump-prod-digests.sh` and the
  render gate reject mutable tag deploys. A digest bump by itself is not live
  rollout proof; deployment completion still requires the default
  `scripts/deploy.sh` Argo/rollout/pod-digest/endpoint verification.
- **Admission audit-mode policy** —
  `deploy/apps/maintenance/components/admission-audit/` defines a sigstore
  policy-controller `ClusterImagePolicy` in `warn` mode for the keyless
  `image-release.yml` signatures. It is opt-in until ops installs the controller
  CRDs, then can burn in safely before hard-fail enforcement.
- **Global request envelope proved** — timeout, body limit, trace layer, and
  metrics wrap the fully merged API router (with realtime deliberately outside
  the 30s timeout); `router_layer_tests` guards the merge-order invariant.
- **`cargo-deny` supply-chain gate** — `backend/deny.toml` (licenses, source
  restriction, advisories) wired into `security.yml`; verified passing, with
  documented accepted-advisory rationale (rsa ES256-only; paste build-time).
- **CI honesty** — `image-release.yml` header corrected (arm64-only; hard-fail
  admission enforcement remains an operator-controlled rollout after audit mode).

## Backlog to "enterprise" — prioritized

### A. Context/substrate-gated (needs 운영 provisioning / budget)

1. **Multi-node, multi-failure-domain cluster (P0 for HA).** `oci-guest` needs
   paid multi-node / multi-AD capacity before replicas/PDBs/blue-green become
   node-failure HA. `on-prem` needs the ADR-0022 substrate: three Talos
   control-plane nodes with etcd quorum plus enough dedicated worker/storage
   nodes to spread critical workloads by hostname and, where claimed, rack/zone/
   site. Until an HA context is activated and drilled, HA is
   documented-but-unimplemented. The on-prem HA scheduling contract is captured in
   [`ADR-0022-ha-workload-scheduling-expectations.md`](decisions/ADR-0022-ha-workload-scheduling-expectations.md):
   control-plane nodes stop running general workloads, critical replicas spread
   across worker failure domains, and all constraints remain DARK until the
   dedicated-worker substrate exists.
2. **HA PostgreSQL (P0).** `oci-guest` intentionally remains CNPG
   `instances: 1` on the single-node base until paid capacity exists. `on-prem`
   must use replicated storage and CNPG `instances: 3` with synchronous
   replication, anti-affinity, and automated primary failover evidence before it
   can claim database HA. Today a node loss in `oci-guest` = restore, not
   failover.
3. **Context-appropriate offsite backup copy (P1).** `oci-guest` should mirror
   the Barman bucket to a second cloud region for true DR. `on-prem` must mirror
   database and evidence/WORM object data to a second physical site or equivalent
   independent failure domain.
4. **Deploy a monitoring stack (P1).** kube-prometheus-stack (Prometheus +
   Alertmanager + Grafana) so the new `/metrics`, ServiceMonitor, and
   PrometheusRule actually flow, with paging wired (the GO-LIVE-CHECKLIST §4
   alerting blocker). Resource-tight on the single 24GB `oci-guest` node; the
   ADR-0022 `on-prem` posture should run this as part of the self-hosted
   observability substrate.
   The Palantir/Foundry benchmark additionally requires each production action
   to prove audit/log/metric/trace/runbook diagnosis for one success and one
   denied/failure path before claiming enterprise-operable.

### B. In-repo / operator handoff (no new spend by default)

5. **Hard-fail admission enforcement (P1).** The audit-mode
   `ClusterImagePolicy` exists. Ops must install sigstore policy-controller,
   observe a clean warning burn-in, then switch from `warn` to enforcement. Keep
   this out of base/prod until the CRDs are present.
6. **Secrets GitOps controller adoption (P2).** `deploy/SECRETS.md` defines the
   current `oci-guest` OCI Vault source and the External Secrets / Sealed
   Secrets upgrade path. ADR-0022 `on-prem` should use OpenBao + External Secrets
   rather than OCI Vault. Choose one controller per deployment context after
   resource sizing; until then `kubectl create secret` remains the documented
   out-of-band bootstrap path.

## Not blockers (accepted for pilot)

- arm64-only images for the current `oci-guest` Ampere A1 cluster; extend
  `platforms` before an `on-prem` x86/amd64 node pool is used.
- Context-specific egress NetworkPolicies left open (Postgres→OCI object storage
  in `oci-guest`; ACME, FCM, Solapi, DNS, and the selected on-prem object-store /
  observability endpoints as applicable).
- Worker single replica (apalis is Postgres-backed and idempotent; horizontal
  scaling needs multi-node first — see A.1).
