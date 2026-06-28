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
| **Observability** | **Improving** | Structured JSON logs; OTLP tracing in code; health/readiness/startup probes; OpenSLO objectives; Palantir/Foundry-derived operating benchmark captured in [`docs/benchmarks/palantir-foundry-ops-benchmark.md`](benchmarks/palantir-foundry-ops-benchmark.md). **Now:** Prometheus `/metrics` backing the SLOs + opt-in ServiceMonitor/PrometheusRule. **Gap:** no monitoring stack deployed; no alert routing/test-fired runbooks. |
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
- **`cargo-deny` supply-chain gate** — `backend/deny.toml` (licenses, source
  restriction, advisories) wired into `security.yml`; verified passing, with
  documented accepted-advisory rationale (rsa ES256-only; paste build-time).
- **CI honesty** — `image-release.yml` header corrected (arm64-only; signature
  is not yet admission-enforced).

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

### B. In-repo (Eng, no new spend) — recommended next

5. **Deploy by digest, not mutable tag (P0 security).** Propagate the
   Trivy-scanned, cosign-signed digest from `image-release.yml` into the prod
   overlay (`images:` `digest:`), so a re-tag can't bypass the scan gate. The
   #1 cross-cutting finding from the security + deployment reviews.
6. **Admission-time signature verification (P1).** sigstore policy-controller (or
   Kyverno `verifyImages`) enforcing the cosign signature at pod creation. Pair
   with #5. Deploy in `warn`/audit mode first on the single node before
   hard-fail.
7. **Global cross-cutting layers (P1 correctness).** `RequestBodyLimitLayer`,
   `TimeoutLayer`, and `TraceLayer` are applied to the base routes *before* the
   domain routers are merged, so they do **not** currently wrap the domain API
   routes — the 2 MiB body cap / 30s timeout / trace spans don't cover
   `/api/v1/*`. The new metrics layer wraps everything (applied post-merge); the
   other three should move there too. Body-limit globalization is safe (evidence
   uploads are presigned straight to object storage — the app never receives the
   bytes); the timeout move needs a check that no legitimate sync endpoint
   (e.g. an Excel/report export) runs past 30s. Verify against the DB-backed
   integration suite in CI.
8. **Secrets GitOps (P2).** External Secrets Operator or Sealed Secrets so
   secret material can live in git (currently `kubectl create secret`,
   out-of-band — documented in `deploy/SECRETS.md`).

## Not blockers (accepted for pilot)

- arm64-only images (the cluster is arm64; extend `platforms` if amd64 is ever
  needed).
- Egress NetworkPolicies left open (Postgres→OCI, ACME, FCM, Solapi, DNS).
- Worker single replica (apalis is Postgres-backed and idempotent; horizontal
  scaling needs multi-node first — see A.1).
