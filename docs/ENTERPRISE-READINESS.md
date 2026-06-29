# Enterprise Production Readiness

Companion to [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md). The checklist gates the
*pilot* launch; this document assesses maturity against an *enterprise*
production bar (HA, observability, supply-chain enforcement, DR) and records the
honest split between what is solved in-repo and what is gated on infrastructure
spend.

Owners: **Eng** = engineering (this repo) · **운영** = operator/ops (production
infra + secrets) · **경영/법무** = business/legal.

## Verdict

The codebase is **production-grade and pilot-ready**. The single thing that
fundamentally caps *enterprise* maturity is not code — it is the **single
free-tier node**. With one Oracle A1 node in one availability domain, the 2×
API/web replicas, their PDBs, and blue/green all run on the same node, and the
database is a single CloudNativePG instance. A node loss is a restore-from-backup
event (RTO ≤ 1h), not an automatic failover. No code change moves past that; it
needs provisioned, paid infrastructure.

Everything that *can* be hardened in-repo without that spend has been, or is
tracked below.

## Scorecard

| Dimension | State | Notes |
|---|---|---|
| **CI / supply chain** | **Strong** | fmt + clippy `-D warnings` + workspace tests; `mnt-gate-*` (layer-boundary, audit-coverage, migration-safety, pii-no-logs); tri-client drift; cosign keyless signing; SLSA provenance + SPDX SBOM; blocking Trivy HIGH/CRITICAL; cargo-audit + npm-audit; Renovate digest pinning. |
| **Deploy / DR** | **Strong** | Argo CD GitOps (self-heal + prune); Argo Rollouts blue/green with smoke-gate auto-rollback; CNPG + Barman PITR to OCI (RPO ≤ 5m / RTO ≤ 1h) with **tested** restore + PITR drills; OpenTofu IaC. |
| **Security posture** | **Strong** | default-deny NetworkPolicies; PSS `restricted`; hardened securityContexts (non-root, drop ALL, seccomp, readOnlyRootFS on Rust pods); cert-manager + Let's Encrypt; HSTS + strict CSP; comprehensive tested RBAC (5 roles × 32 features, dual role+branch gate). |
| **Observability** | **Strong in-repo / ops-gated live** | Structured JSON logs; OTLP tracing in code; health/readiness/startup probes; OpenSLO objectives; Prometheus `/metrics` backing the SLOs; opt-in ServiceMonitor/PrometheusRule; Palantir/Foundry-derived operating benchmark captured in [`docs/benchmarks/palantir-foundry-ops-benchmark.md`](benchmarks/palantir-foundry-ops-benchmark.md). **Gap:** no monitoring stack deployed; no alert routing/test-fired runbooks. |
| **High availability** | **Capped by infra** | Single node ⇒ correlated replica failure; single CNPG instance; single worker (no leader election). PDBs/blue-green are present but structurally limited to voluntary disruptions. |

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
- **Digest-only GitOps deploy** — production overlay pins `mnt-app` and
  `mnt-web` by immutable `sha256` digest; `scripts/bump-prod-digests.sh` and the
  render gate reject mutable tag deploys.
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

### A. Infra-gated (needs 운영 provisioning / budget)

1. **Multi-node, multi-AD cluster (P0 for HA).** ≥3 nodes so replicas/PDBs/
   blue-green become real and `topologySpreadConstraints` can spread pods.
   Until then HA is documented-but-unimplemented.
2. **HA PostgreSQL (P0).** CNPG `instances: 3` with synchronous replication +
   automated failover (needs a 2nd/3rd A1). Today a node loss = restore, not
   failover.
3. **Off-region backup copy (P1).** Mirror the Barman bucket to a second region
   for true DR.
4. **Deploy a monitoring stack (P1).** kube-prometheus-stack (Prometheus +
   Alertmanager + Grafana) so the new `/metrics`, ServiceMonitor, and
   PrometheusRule actually flow, with paging wired (the GO-LIVE-CHECKLIST §4
   alerting blocker). Resource-tight on a single 24GB node — pairs with A.1.
   The Palantir/Foundry benchmark additionally requires each production action
   to prove audit/log/metric/trace/runbook diagnosis for one success and one
   denied/failure path before claiming enterprise-operable.

### B. In-repo / operator handoff (no new spend by default)

5. **Hard-fail admission enforcement (P1).** The audit-mode
   `ClusterImagePolicy` exists. Ops must install sigstore policy-controller,
   observe a clean warning burn-in, then switch from `warn` to enforcement. Keep
   this out of base/prod until the CRDs are present.
6. **Secrets GitOps controller adoption (P2).** `deploy/SECRETS.md` defines the
   OCI Vault source and the External Secrets / Sealed Secrets upgrade path.
   Choose one operator after resource sizing; until then `kubectl create secret`
   remains the documented out-of-band bootstrap path.

## Not blockers (accepted for pilot)

- arm64-only images (the cluster is arm64; extend `platforms` if amd64 is ever
  needed).
- Egress NetworkPolicies left open (Postgres→OCI, ACME, FCM, Solapi, DNS).
- Worker single replica (apalis is Postgres-backed and idempotent; horizontal
  scaling needs multi-node first — see A.1).
