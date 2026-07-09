# Durable Log Persistence — Design + GO/NO-GO

Status: **DESIGN (deliverable now) · Phase-1 deploy = GO, founder-gated on prereqs (§9)**
Scope: operational log aggregation, retention, and search for the live OCI/Talos cluster (`knllogistic.com`).
Author: platform. Last grounded against repo: branch `perf/hr-read-path-indexes-*`, deploy tree under `deploy/`.

> This document is for **operational logs** (observability / incident response). It is **not** the
> tamper-evident business **audit chain** (`backend/crates/platform/audit-chain/`, Postgres
> `audit_events`, sealed + verifiable). See §1 for the boundary. Operational logs may *reference*
> `trace_id` / audit ids for correlation, but they are a separate, lower-assurance durability concern
> and must never be treated as the legal record.

---

## 1. Context & problem

**Today, pod logs are ephemeral.** The backend emits well-structured logs but nothing captures them
off-node:

- `backend/app/src/lib.rs:1966` `init_tracing` builds `tracing_subscriber::fmt::layer().json()` +
  `EnvFilter` (default `info`) → **structured JSON to stdout**. That is the entire log sink.
- Every HTTP request span records a `trace_id` (`record_otel_ids`, `backend/app/src/lib.rs:1865`;
  span built in the `TraceLayer` at `:1232`), so **every log line is already correlatable by
  `trace_id`** and the query string is deliberately dropped to avoid PII (`:1236-1241`).
- An **OTLP exporter path exists but is OPT-IN and currently OFF**: `init_tracing:1970` wires
  `opentelemetry_otlp` **only** when `config.otlp_endpoint` is set (`OTEL_EXPORTER_OTLP_ENDPOINT`,
  `lib.rs:346`). The prod ConfigMap keeps it commented out and notes "the OTel collector MUST be
  deployed first" (`deploy/apps/maintenance/base/configmap.yaml:61-65`). Note this exporter ships
  **traces (spans), not logs** — logs stay stdout-only.
- **No log shipper exists.** Grep of `deploy/` for `loki|vector|fluent|promtail|openobserve|opensearch|
  fluentbit|filebeat|logstash|elasticsearch` returns nothing. Confirmed: pod stdout is written to the
  node by the container runtime and rotated/discarded. A pod restart, eviction, or node loss
  (single-node cluster, see `deploy/README.md`) **permanently loses its logs.**

**The gap:** no durable retention, no cross-pod search, no post-mortem forensics beyond `kubectl logs`
on a still-running pod. For a multi-tenant operations platform this is both an **incident-response**
hole (can't reconstruct what happened after a crash) and a **compliance** hole (no retained access
record — see §2).

**Boundary with the audit chain (explicit):** the audit chain records *business* facts ("admin X
suspended tenant Y") as sealed, hash-chained `audit_events` in Postgres for legal/tamper-evidence.
Operational logs record *system* facts ("request Z returned 500 in 4.1s on pod P") for debugging and
ops. They overlap only via `trace_id`: an operational log line can point you at the audit event for the
same request, and vice-versa. They have different retention, different assurance, different stores.
**Do not route audit events through the log pipeline, and do not treat logs as audit evidence.**

---

## 2. Requirements

| # | Requirement | Driver |
|---|---|---|
| R1 | **Durable retention** off-node; survives pod/node loss | incident response; single-node cluster |
| R2 | **Retention tiers** (see below) | cost + compliance |
| R3 | **Search / query** across pods and time by `trace_id`, org, level, message | forensics |
| R4 | **Low ops burden** — installs/upgrades via GitOps, near-zero day-2 toil | 1–2 person team |
| R5 | **Cost-conscious** — must live inside the OCI budget (§8), not cannibalize evidence storage | Always-Free / small PAYG |
| R6 | **Tenant awareness** — logs carry `org_id`; operator can filter per-tenant during an incident | multi-tenant platform |
| R7 | **PII / secret redaction at source** | Korean PIPA; existing discipline |
| R8 | **Encryption at rest** | PIPA safety measures; OCI default |
| R9 | **Access-controlled + audited** log access (who queried what) | least privilege |
| R10 | **GitOps-deployable** (ArgoCD app) + **IaC** (OpenTofu) | matches existing deploy model |
| R11 | **log ↔ trace ↔ audit correlation by `trace_id`** | cross-store forensics |

**Retention tiers (proposed, justify against PIPA):**

- **Hot / searchable: 30 days default (90-day ceiling, configurable).** Covers the practical
  incident-response + SLO-forensics window (a quarter for slow-burn issues). Kept in the query store.
- **Cold archival: 365 days** as compressed objects in OCI Object Storage (query-on-demand, not indexed).
- **> 365 days: deleted** by lifecycle policy, unless a specific legal hold applies. Logs are **not** the
  long-term legal record — that is the audit chain, which has its own (indefinite) retention.

*PIPA rationale (design input — confirm with counsel, not legal advice):* Korea's 개인정보 보호법 and the
개인정보의 안전성 확보조치 기준 (Personal Data Safety Measures) require **access records to personal-information
systems be retained ≥ 1 year** (≥ 2 years for large-scale / sensitive-info processors). Our operational
logs are PII-minimized (§6) so most lines are not "access records," but request/access lines that touch
personal-data processing plausibly fall in scope → the **365-day cold floor** is set to satisfy the
1-year access-log minimum without over-retaining. General debug logs don't need a year; hence the short
hot tier + cheap cold archive split.

---

## 3. Options (tradeoffs for THIS stack)

Fixed constraints that dominate every option: **one Talos node** (4 OCPU / 24 GB, already running
app+web+worker+CNPG+Argo+Traefik+cert-manager — tiny compute headroom); **OCI S3-compatible object
storage** is the only proven durable store (CNPG backups already use it, §5); **single-founder ops**;
**Always-Free budget** (20 GB object / 50k req-month) contended by evidence + DB backups (§8).

| Option | Ops burden | Cost | Query UX | Retention/tiering | OCI fit | GitOps fit | HA/scale | Lock-in |
|---|---|---|---|---|---|---|---|---|
| **(a) Loki + OCI object store + Grafana** | Med — **2** components (Loki + Grafana); compactor config; no Grafana today | Low | LogQL, mature | compactor + `retention_period`, per-tenant | S3 backend OK (checksum caveat §5) | Helm chart → Argo | scales to microservices; overkill here | none (Apache-2, open) |
| **(b) OpenObserve (single binary, S3-backed, built-in UI)** ✅ | **Low — 1** component, built-in UI, built-in retention | **Lowest** (Parquet+zstd, ~10–100× vs raw) | Built-in web UI, SQL + full-text | per-stream retention built in | S3-native (same checksum caveat) | Helm chart → Argo | single-node OSS fine; HA is Enterprise | Med (own store; OSS = AGPL-3) |
| **(c) Vector/Fluent Bit → OCI Object Storage raw/Parquet archival** | **Lowest** (a DaemonSet, no server) | Lowest | **None** (grep after `oci os object get`, or DuckDB over Parquet) | bucket lifecycle only | S3-native (checksum caveat) | Argo (just the DaemonSet) | trivially scales; no query tier | none |
| **(d) OCI Logging (managed)** | Near-zero (managed) | Per-GB ingest+store (not free-tier generous) | OCI console search (basic) | 30–180d configurable | native, but k8s-stdout ingest is awkward (needs Unified Agent / custom push) | not GitOps-native | managed | **High** (OCI-proprietary, no export) |
| **(e) ELK / OpenSearch** | ❌ **REJECTED** | ❌ | rich | ILM | S3 snapshots | Helm | needs 3 nodes + JVM heap | med |

**Reject (e) ELK/OpenSearch:** JVM, ≥ 2 GB heap per node minimum, wants ≥ 3 master-eligible nodes for
real HA, Logstash is a memory hog, and index lifecycle management is a day-2 job. On a single 24 GB node
already full, it would starve the app. Ops + cost are disqualifying for a 1-person team. Named and out.

**Note on (d):** kept as the escape hatch if self-hosting ever proves too heavy, but the lock-in
(proprietary query language, no portable export) plus per-GB pricing plus the awkward k8s-stdout ingestion
path make it worse than an object-storage-backed self-host **for this use case**. Not recommended.

**Versions (indicative — VERIFY LIVE + pin the image digest at implementation; do not trust these numbers):**
OpenObserve **v0.91.x** (v0.91.0 was 2026-06; v0.91.0 added a Super-Org multi-tenancy model + org-level
storage config, relevant to R6). Grafana Loki **v3.7.x** (fallback). Vector **latest** (its `aws_s3` sink
now supports **Parquet + zstd** natively — relevant to (c)). Fluent Bit 3.x/4.x (alt collector). Every
one must be renovate-pinned exactly as the repo already pins CNPG/Barman/Argo (`deploy/README.md` table).

---

## 4. Recommendation

**Store + query: OpenObserve (option b), single-node, OSS edition, S3-backed on OCI Object Storage.**
**Collection: a Vector DaemonSet** tailing container stdout, dual-sinking to OpenObserve (hot) and a raw
Parquet archive bucket (cold).

**Why OpenObserve over Loki (the honest call for THIS team):**
1. **Fewest moving parts.** One stateful component with a built-in UI vs Loki **+ Grafana** (two — and
   there is **no Grafana deployed today**; the monitoring component is opt-in and unused, see
   `deploy/apps/maintenance/components/monitoring/README.md`). For a single founder, 1 < 2 is decisive (R4).
2. **Cheapest footprint** against the tight budget: columnar Parquet + zstd + Tantivy index compresses
   far better than Loki's gzip'd chunks (R5, §8).
3. **Built-in query UI + SQL/full-text** → satisfies R3 without standing up and securing Grafana.
4. **S3-native** → reuses the *exact* proven OCI object-storage pattern (§5), no new mechanism (R10).
5. **Native ingest for Vector/OTLP/Loki/Elastic APIs** → clean pairing with the collector below.

**Why Vector for collection (not the app itself, not Fluent Bit):**
- **Not the app**: the app's OTLP path exports *traces*, and app-side push would miss non-app pods
  (Traefik, Argo, CNPG, the DB) and can't capture a crash-looping pod's dying breath. A **node-level
  DaemonSet tailing `/var/log/containers/*.log` captures everything** and is the standard decoupled
  approach.
- **App already emits JSON with `trace_id`** → Vector parses it to structured fields with a two-line VRL
  (`parse_json` + attach k8s pod/namespace metadata). No Grok, no regex. Trivial.
- **Vector over Fluent Bit** here because its `aws_s3` sink writes **Parquet+zstd** natively (the cold
  tier is columnar and later queryable by DuckDB/OpenObserve) and it dual-sinks cleanly. On a 1-node
  cluster the memory delta vs Fluent Bit (~100 MB vs ~20 MB) is irrelevant.
  <!-- ponytail: Fluent Bit is the even-lazier collector if node memory ever bites; swap-in is a DaemonSet change only. -->

**Named fallback:** if OpenObserve **OSS** turns out to lack adequate auth/RBAC for our needs (its RBAC
has historically been Enterprise-gated — **verify at implementation**), fall back to **Loki + Grafana**
(both fully OSS). The collector (Vector) and the object-storage/Vault/Argo/Tofu plumbing are identical
either way, so this fallback is a store swap, not a redesign.

---

## 5. Architecture

```
                 Talos single node (ns: observability)                         OCI Object Storage
                                                                               (ap-chuncheon-1, S3 API
  ┌──────────────────────────────────────────────────────────┐               endpoint axdotp9iv3ua…)
  │  Vector DaemonSet (1 pod)                                  │
  │  source:  kubernetes_logs  (tails /var/log/containers/*)  │   hot: HTTP    ┌───────────────────────┐
  │  transform: VRL parse_json + k8s metadata + drop rules    │  ────────────► │ OpenObserve store      │
  │  sink 1 → OpenObserve HTTP ingest (hot, 30–90d)           │                │  bucket mnt-logs/oo/   │
  │  sink 2 → aws_s3 (Parquet+zstd, batched large objects)    │   cold: PUT    │  (Parquet+zstd+index)  │
  └──────────────────────────────────────────────────────────┘  ────────────►├───────────────────────┤
             ▲ container stdout (already JSON w/ trace_id)                     │ cold archive           │
             │                                                                 │  mnt-logs/archive/     │
  app / web / worker / traefik / argo / cnpg pods                              │  dt=YYYY-MM-DD/hour=HH │
                                                                               └───────────────────────┘
  ┌──────────────────────────────┐        query (browser, auth' + audited)          ▲   ▲
  │ OpenObserve server (1 pod)   │ ◄──────────────────────────────────────────────┘   │
  │  built-in web UI + SQL       │        reads hot store; can query cold on demand ───┘
  │  ingress: logs.knllogistic…  │
  └──────────────────────────────┘
```

**Components & placement (all on the one node, new `observability` namespace):**
- **Vector DaemonSet** — 1 pod (1 node). Reads the node's container log dir (hostPath, read-only).
  Limits ~0.1 vCPU / 128 MB.
- **OpenObserve** — single-node StatefulSet, local-path PVC for its metadata + hot index cache; **object
  storage is the source of truth**. Limits ~0.25 vCPU / 512 MB. Behind Traefik ingress
  `logs.knllogistic.com` with cert-manager TLS + auth (§6).

**OCI bucket layout — one dedicated bucket `mnt-logs`, two prefixes:**
- `s3://mnt-logs/oo/` — OpenObserve-managed layout (hot + its own compaction/retention).
- `s3://mnt-logs/archive/dt=YYYY-MM-DD/hour=HH/<node>-<ts>.parquet.zst` — Vector cold sink.
- **Dedicated bucket, not `mnt-evidence`/`mnt-db-backups`**: different retention, different lifecycle,
  different blast radius, and it keeps the 20 GB Always-Free evidence budget clean (R5). Likely a **PAYG
  bucket** (see §8).

**Retention/tiering mechanism:**
- Hot: OpenObserve **per-stream `retention` = 30d** (raise to 90d per stream if needed). It deletes its
  own expired data from `oo/`.
- Cold: OCI **object lifecycle policy** on `archive/` deletes objects > 365d (declared in OpenTofu).
- No `versioning` on `mnt-logs` (logs are immutable append-only objects; versioning would just double
  storage). Contrast the DB-backup bucket which *is* versioned in `storage.tf` — deliberate difference.

**Vault-sourced credentials (reuse the existing discipline, do not invent):**
- A **dedicated OCI Customer Secret Key** (S3 access/secret) scoped to `mnt-logs`, stored in **OCI Vault**
  as `mnt-logs-objectstore-creds` — same class of secret as the existing `mnt-app-secrets-bundle` /
  `oci-objectstore-creds`.
- Projected into the cluster as k8s secret `oci-logs-creds` in `observability`, created **out-of-band via
  `kubectl create secret`** — exactly the pattern `deploy/SECRETS.md` blesses for a 1–2 person team ("the
  pragmatic, honest baseline"; External/Sealed Secrets is the noted future upgrade, **not adopted here**).
- OpenObserve's admin bootstrap password / root user: likewise a k8s secret from Vault.

**ArgoCD app + OpenTofu resources needed:**
- **ArgoCD:** new `deploy/argocd/apps/observability.yaml` Application (project `maintenance`, sync-wave
  after operators), sourcing `deploy/apps/observability/` (kustomize wrapping the Vector + OpenObserve
  Helm charts, pinned — consistent with how barman/traefik/rollouts are pulled). App-of-apps `root`
  (`deploy/argocd/root.yaml`) picks it up automatically (recurse over `deploy/argocd/apps`). selfHeal +
  prune, like every other child.
- **OpenTofu (`deploy/opentofu/storage.tf`):** add `oci_objectstorage_bucket "logs"` (name `mnt-logs`,
  `NoPublicAccess`, no versioning) + an `oci_objectstorage_object_lifecycle_policy` (delete `archive/` >
  365d) + optionally a dedicated `oci_identity_user`/customer-secret-key for least-privilege scoping.
  Add outputs for the bucket name. Mirrors the existing `db_backups`/`evidence` resources exactly.
- **NetworkPolicy:** if (and only if) the Calico/Canal policy add-on is actually enforcing (the repo notes
  Talos default flannel does **not** enforce — `deploy/apps/maintenance/base/networkpolicy.yaml` header),
  add an egress-allow for the `observability` tier to 443 (OCI) + DNS, mirroring `allow-app-egress-https`.

---

## 6. Security & privacy

**Redaction at SOURCE (primary defense — already largely in place):**
- **Never-log-secrets discipline** is enforced by the CI gate `backend/ci/gates/pii-no-logs/` (literal
  scanner over logging macros) — keep it green; it is the first line.
- **Runtime redaction newtypes** (`backend/crates/kernel/core/src/redact.rs`, `RedactedPhone` etc.) mask
  PII that reaches a log via binding/interpolation (which the literal scanner can't follow). Extend the
  allowlist/newtypes for any tenant PII field that must appear in logs; default is to **not** log it.
- Query strings are already dropped at the span (`lib.rs:1236`). Keep that.
- **Secondary net in the pipeline:** a Vector VRL `remove`/redaction transform (field allowlist + regex
  drop for anything resembling a token/JWT/phone) as defense-in-depth before anything is persisted. The
  source redaction is authoritative; this is belt-and-suspenders, not a license to log PII.

**Encryption at rest:** OCI Object Storage encrypts all objects at rest by default (AES-256, OCI-managed
keys); the same tenancy master key (`oyatie-cloud-master-key`) can be bound for customer-managed keys if
required. OpenObserve's local PVC sits on the node's block volume (also OCI-encrypted). **No plaintext log
store anywhere.** In transit: Vector→OpenObserve is intra-node; OpenObserve→OCI is HTTPS; browser→UI is
cert-manager TLS.

**Access control + AUDIT of who queries logs (R9):**
- OpenObserve UI is **not public** — Traefik ingress with auth (OpenObserve login; add SSO/oauth2-proxy
  if OSS auth is thin). For a 1–2 person team, a single strong operator login behind TLS is the honest
  baseline; per-user RBAC over logs is a Phase-3 concern, not a launch blocker.
- **Query access is itself logged**: OpenObserve's own access logs are shipped by the same Vector
  DaemonSet → "who searched the logs" is captured in the log store (and, if we want it tamper-evident,
  a future hook can emit an `audit_event` on privileged log-query — but that couples logs to the audit
  chain, so **deferred, not built** unless a compliance driver demands it).
  <!-- ponytail: audit-chain integration for log queries is speculative; add only if an auditor asks. -->

**Tenant scoping of log access (R6) — reframed honestly:** operational logs are for the **operator**, not
tenants. Tenants get their "who did what" from the product's **audit chain**, never raw ops logs. So
"tenant scoping" here means: **logs carry an `org_id` field** so an operator can *filter* per-tenant during
an incident — it does **not** mean per-tenant RBAC exposing the log store to tenants (that store is never
tenant-facing). This dissolves the need for heavy multi-tenant RBAC in the log layer. (OpenObserve's
org/stream model is available if we ever expose tenant-scoped views, but that's not a requirement now.)

**Retention / right-to-erasure:** PIPA erasure requests target **personal data**, which lives in Postgres
and evidence storage, not in PII-minimized ops logs. If a residual identifier lands in logs, the bounded
retention (30–90d hot / 365d cold, then lifecycle-delete) is the erasure mechanism — logs age out
automatically. A targeted purge of a specific object is possible but should be rare given source
redaction. Document this in the DR/retention runbook alongside `ops/dr/DR-POLICY.md`.

---

## 7. Phased rollout

**Phase 1 — Durable collection + archival (closes the ephemeral-logs gap).**
- Deliverable: Vector DaemonSet deployed via Argo; every pod's stdout batched + compressed (Parquet+zstd)
  to `s3://mnt-logs/archive/…`; OCI lifecycle policy set; credentials from Vault; **checksum/chunked-encoding
  gotcha verified fixed** (§5, the same class of failure that broke CNPG backups — see below).
- Acceptance: (1) kill a pod, confirm its final log lines appear in an archive object within one flush
  window; (2) object PUT rate measured well under the request budget (batching working); (3) a
  test object round-trips (no `AWS chunked encoding not supported` error).

**Phase 2 — Query / search UI + access control.**
- Deliverable: OpenObserve deployed via Argo, ingest wired from Vector (hot sink), ingress + TLS + auth;
  search by `trace_id`, `org_id`, level, time.
- Acceptance: (1) search a known `trace_id` and land the exact request's lines; correlate that `trace_id`
  to its `audit_events` row in Postgres → **end-to-end log↔trace↔audit** proven (R11); (2) unauthenticated
  access to the UI is refused; (3) an operator search appears in the shipped access logs.

**Phase 3 — Retention automation + alerting.**
- Deliverable: per-stream hot retention enforced by OpenObserve; cold lifecycle by OCI (from Phase 1);
  log-based alerts (error-rate spike, specific fatal patterns) → existing notification path (SLO alerts
  already exist as Prometheus rules under `backend/app/slos/` — reuse the notification channel).
- Acceptance: (1) objects/streams past retention are provably gone; (2) a synthetic error burst fires an
  alert to the operator.

---

## 8. Cost estimate

**The critical, non-obvious constraint:** this cluster is on OCI **Always Free** with a **20 GB
object-storage / 50k-requests-month** cap, **already contended** by evidence photos/video and CNPG WAL
backups (`deploy/README.md` "Honest free-tier constraints"; WAL archiving is *already tuned* —
`maxParallel:1`, gzip — to stay under 50k req/mo). Naively "shipping every log line" would blow both caps.
The design counters this with: **(a)** a **dedicated (PAYG) `mnt-logs` bucket** so logs never eat the free
evidence/backup budget; **(b)** aggressive **batching → few large objects** (request-cheap); **(c)**
Parquet+zstd (storage-cheap); **(d)** bounded retention (not indefinite like the DB backups).

Rough monthly (single-node platform, `info` level, ~1 GB/day raw ≈ 30 GB/mo):

| Item | Estimate |
|---|---|
| Storage — hot (compressed ~10–20×) + 365d cold archive | ~2–4 GB hot + ~15–30 GB cold ≈ **~$1/mo** (OCI standard ~$0.0255/GB-mo) |
| Requests (batched, hundreds/day) | negligible (~$0.003/10k PUT) — well under any cap |
| Compute (Vector ~0.1 vCPU/128 MB + OpenObserve ~0.25 vCPU/512 MB) | **$0 marginal** — fits existing A1 headroom, **no new node** |
| **Total** | **~$1–3/mo**, storage-dominated |

If volume grows 10× → ~$10–20/mo. Genuinely cheap; the *real* budget pressure is the shared 20 GB
free allotment, hence the dedicated bucket. **Do not add a second A1** for this (free-tier guardrail,
OPS-RUNBOOK §7) — it runs in existing headroom.

---

## 9. Prerequisites & GO/NO-GO

**The DESIGN is deliverable now (this document). The DEPLOY is founder-gated ops** (OCI Vault creds +
cluster access + a maintenance window) — the same gate as every other cluster change.

**Recommendation: GO for Phase 1** with the named stack (Vector → OCI `mnt-logs`; OpenObserve deferred to
Phase 2). Phase 1 is low-risk, ~$0, and closes the incident-response gap with only a DaemonSet.

**Exact prereqs the founder must provide:**
1. **OCI bucket** `mnt-logs` in `ap-chuncheon-1` — `tofu apply` the new `storage.tf` resource, or create
   out-of-band. Decide free-vs-PAYG (recommend PAYG so it doesn't cannibalize the 20 GB free evidence
   budget).
2. **OCI Customer Secret Key** (S3 access/secret) scoped to `mnt-logs`, stored in **OCI Vault**
   (`mnt-logs-objectstore-creds`). Never `/tmp`, never git (OPS-RUNBOOK §0).
3. **Cluster access + a maintenance window** to: create the `oci-logs-creds` secret in the `observability`
   ns, apply the new ArgoCD app, and (only if Calico policy enforcement is on) add the egress allow.
4. **Confirm the boto3/aws-sdk checksum gotcha is neutralized** against OCI before trusting the archive —
   this is the single highest-risk item (below).

**Risks (ranked):**
- **R-1 (high, known): S3 checksum / chunked-encoding incompatibility.** OCI rejects AWS flexible
  checksums sent via chunked/trailer encoding — this is the *exact* failure that silently broke CNPG
  backups, fixed there with `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` /
  `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required` (`deploy/apps/maintenance/base/database.yaml:15-26`).
  **Any S3 writer here (Vector's aws-sdk-rust, OpenObserve's aws-sdk-rust) will likely hit the same wall.**
  Mitigation: set the equivalent (`when_required` env / sink config to disable request checksums) and make
  a successful round-trip a **Phase-1 acceptance gate**. Do not assume it works — the CNPG failure was silent.
- **R-2 (med): single-node compute pressure.** OpenObserve adds a stateful component to a full 24 GB node.
  Mitigation: single-node OSS + hard resource limits; and Phase 1 alone (Vector→S3, no server) delivers
  durability at ~zero compute if the server proves too heavy.
- **R-3 (med): OpenObserve OSS auth/RBAC may be thin** (historically Enterprise-gated). Mitigation:
  operator-only access behind TLS + oauth2-proxy; **Loki+Grafana is the drop-in fallback store** (same
  collector + plumbing).
- **R-4 (med): free-tier budget contention.** Mitigation: dedicated PAYG bucket + batching + bounded
  retention (all in the design).
- **R-5 (low): no log HA.** A node loss can drop in-flight buffered logs before the next flush. Accepted —
  the *entire* cluster is single-node by design (`deploy/README.md`); the cold archive in object storage is
  the durability guarantee, and shortening the flush window trades requests for a smaller loss window.
- **R-6 (low): NetworkPolicy enforcement.** Egress allow only matters if Calico/Canal is actually rolled
  out (flannel default doesn't enforce). No-op otherwise; harmless to declare.

**NO-GO conditions:** if the founder cannot provide a Vault-stored OCI key + a maintenance window, or if
the checksum round-trip (R-1) cannot be made to pass against OCI, hold Phase 1 — an archive that silently
fails to write is worse than a known gap.

---

## Appendix — deliberate simplifications (ponytail)

- **Fluent Bit not chosen** — Vector's Parquet+zstd S3 sink + VRL win on a 1-node cluster; Fluent Bit is
  the swap-in if memory ever bites.
- **No External/Sealed Secrets** — out-of-band `kubectl create secret` from Vault, per `SECRETS.md`'s own
  blessed baseline for a 1–2 person team.
- **No per-tenant RBAC in the log store** — logs are operator-only; tenants get the audit chain.
- **No audit-chain integration for log queries** — deferred; add only under a compliance driver.
- **Cold archive is Parquet objects, not a second index** — query-on-demand via DuckDB/OpenObserve; a
  full cold index is unwarranted for rare > 90-day lookups.
```
