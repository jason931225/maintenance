# ADR-0022 — Cloud-Agnostic Multi-Substrate Portability + High Availability

Status: **Proposed** · **The OCI Talos cluster running today stays a first-class supported target** — this ADR *adds* bare-metal/on-prem portability + HA, it does **not** migrate off or remove OCI · Amends ADR-0005 (SeaweedFS/WORM), ADR-0015 (DR), and the observability direction in `docs/specs/log-persistence.md` · Adopts patterns from the sibling **oyatie** project (same owner; full-license reuse).

## Context

The platform must be **fully portable** — able to run on the owner's **own bare-metal, multi-cluster, HA Talos** on-prem **as well as the OCI Talos cluster running today**. Hard requirements: **never *lock* into OCI** (OCI becomes one swappable substrate among several, and keeps working), **portable across the entire repo**, **HA (no single point of failure)**, **multicluster**. This is an **additive** portability + HA effort — not an OCI migration or removal.

A four-part audit established the exact shape of the problem:

- **The app / runtime layer is already portable.** The backend has **no OCI SDK, no `oracle` crate, no OCI Vault SDK, no instance-principal auth, no hardcoded region/tenancy** (`backend/Cargo.lock` clean). Object storage is a hand-rolled **S3-compatible client built for SeaweedFS** (`backend/crates/platform/storage/src/lib.rs`, path-style, own SigV4) — endpoint is pure env config (`MNT_S3_ENDPOINT_URL`). Secrets are 12-factor env vars. The only OCI strings are doc comments + test fixtures.
- **The CI/CD pipeline is already portable.** Images build → **GHCR** (not OCIR), digest-pinned + cosign; deploy is **GitOps-pull via ArgoCD**; no `oci` CLI, tenancy, or instance-principal in any workflow or script. cert-manager uses **DNS-01** (works anywhere).
- **The lock is entirely in the *substrate*.** `deploy/opentofu/**` is ~20 `oci_*` resources on the `oracle/oci` provider (compute/VCN/reserved-IP/LB/bastion/object-storage); secrets are OCI Vault; backup + evidence endpoints are OCI Object Storage.
- **HA is absent by design.** Single Talos node, single control plane (no etcd quorum), `instances: 1` Postgres on unreplicated node-local `local-path`, reserved single-IP `hostPort` ingress. Plus one app-level HA defect (below).

**oyatie already solved exactly this.** The owner's sibling platform runs a provider-neutral Talos + Cluster API + Cilium + ArgoCD substrate with a deployment-context IaC doctrine, OpenBao + External-Secrets, self-hosted SeaweedFS/observability, multi-cluster ApplicationSet federation, and CI gates that *enforce* portability. We **adopt** that blueprint rather than reinvent it.

## Decision

**Cloud is a swappable substrate, never a dependency.** Concretely:

1. **Deployment-context IaC layout** (adopt oyatie ADR-0339). OpenTofu modules live under `<context>/<primitive>` where `context ∈ {oci-guest, on-prem, colo, …}`; each service ships a thin (≤80 LOC, `module`-blocks-only) wrapper that selects primitives. **`oci-guest` and `on-prem` are BOTH first-class and coexist** — today's OCI stack is refactored *into* the `oci-guest` context (kept working, not deleted) and bare-metal is added as the `on-prem` context. Deploying a substrate = choosing its wrappers. There is intentionally no single "cluster" abstraction — primitives are context-scoped and real.
2. **Vendor-lock-in discipline** (adopt oyatie ADR-0173). OSS-first / own-the-stack. Managed cloud services are forbidden with a named OSS replacement (Secrets Manager/Vault → **OpenBao**; CloudWatch/OCI Logging → **OTel + VictoriaMetrics/LGTM + Grafana**; managed object store → **SeaweedFS/MinIO/Ceph-RGW**). **S3 is used only as an open protocol over self-hosted implementations**, never as a managed cloud service. Runtime vendor seams get a kernel port trait + ≥2 adapters.
3. **Mechanically enforced.** Lift oyatie's pure-Rust `oya-check-iac-tier-discipline` into a `mnt-gate-iac-tier` CI binary (Tier A = ArgoCD / Tier B = OpenTofu / Tier C = Cluster API; flags any `aws_*`/`google_*`/`azurerm_*`/`oci_*` primitive leaking into app manifests), plus a small vendor phase-out registry gate. This is how portability is prevented from rotting back.

## Target architecture — HA multicluster bare-metal Talos (added alongside OCI)

> The "Today" column is the current **`oci-guest`** context, which **remains a supported target**. The right column is the **`on-prem`** context being *added*. HA is the universal goal — on OCI it is reached by growing past the free-tier single node, on bare-metal by the multi-node design below. The two substrates **coexist** via the deployment-context layout; nothing here removes the ability to deploy to OCI.

| Concern | Today (OCI `oci-guest`, single-node) | Added target (bare-metal `on-prem`, HA, multicluster) |
|---|---|---|
| Cluster lifecycle | 1 `oci_core_instance` + `dd` flasher hack | **Talos install-media + Cluster API** (+ `cluster-api-provider-metal3`) + per-cell ArgoCD; **3 control-plane nodes** (etcd quorum) + N workers |
| Provisioning | `oracle/oci` provider, `~/.oci/config` | `on-prem` OpenTofu wrappers + Talos machineconfig against a node inventory; no cloud IaaS provider |
| CNI / policy | flannel (NetworkPolicies inert) | **Cilium** (enforced NetworkPolicy + eBPF LB, optional BGP) |
| Ingress | reserved single IP `140.245.68.253` + `hostPort` DaemonSet | **MetalLB (L2/BGP) or kube-vip VIP** fronting Traefik across ≥2 workers; re-enable the Service; VIP fails over |
| Block storage | node-local `local-path` (1 copy) | **Longhorn or Rook-Ceph** replicated PVCs |
| Postgres | CNPG `instances: 1` | **CNPG `instances: 3`** synchronous replication + auto-failover + pod anti-affinity |
| Object storage | OCI Object Storage endpoints | **self-hosted SeaweedFS / MinIO / Ceph-RGW** (endpoint swap only — app already S3-compat); evidence WORM replica → **a second physical site** |
| Secrets | OCI Vault + out-of-band `kubectl create secret` | **OpenBao (HA Raft) + External Secrets Operator**, declaratively reconciled by Argo (lift oyatie `infra/external-secrets` + `infra/kms/openbao.k8s.yaml`) |
| Multi-cluster | single destination | **ArgoCD ApplicationSet** cluster-generator; primary + warm-standby DR per site |
| Observability | heading to OCI Logging/Monitoring/APM | **OTel Collector → VictoriaMetrics/Mimir + Loki + Tempo → Grafana**, self-hosted (supersedes `log-persistence.md` Direction A); wide-event middleware for cardinality-safe OTel |
| Images | single-arch `linux/arm64` (Ampere) | **multi-arch `linux/amd64,linux/arm64`** |
| Time / MTU | OCI link-local NTP `169.254.169.254`; MTU 9000→1500 VNIC workaround | on-prem NTP (chrony/GPS); MTU = real fabric value |
| Registry | GHCR (already portable) | GHCR; optionally mirror to self-hosted **Harbor** for air-gap |

## App-level remediation (the one real code fix)

**`backend/app/src/mail_sync.rs` — HA defect.** The inbound IMAP sync scheduler is an unlocked `tokio` ticker (`comms_due_email_accounts` is a plain `SELECT … LIMIT`, no `FOR UPDATE SKIP LOCKED`, no lease) **spawned in every replica including the horizontally-scaled `AppRole::Api`**. N API pods would sync the same mailbox concurrently. **Fix before scaling replicas:** add a `SKIP LOCKED` claim + `claimed_until` lease (mirror the evidence-transcode pattern at `storage/src/lib.rs:2366`), or route inbound sync through the existing `apalis-postgres` job queue. Everything else (realtime via `LISTEN/NOTIFY`, WORM/transcode claiming, the job queue, stateless RLS-armed pools) is already HA-safe.

## Remediation roadmap (ranked, disjoint lanes)

1. **Portable secrets** — OpenBao + External Secrets Operator; lift oyatie `infra/external-secrets/*` (incl. the `disable_local_ca_jwt` + `system:auth-delegator` invariant). Highest value / lowest effort; ends the out-of-band-secret rebuild dependency.
2. **Self-hosted S3 endpoint swap** — point CNPG barman + evidence `MNT_S3_ENDPOINT_URL`/`endpointURL` at SeaweedFS/MinIO; **re-test and likely drop** the `AWS_*_CHECKSUM_*=when_required` OCI workaround (silent-corruption risk if copied blindly).
3. **Multi-arch image builds** — extend `image-release.yml` `platforms:` to `linux/amd64,linux/arm64`.
4. **CI hardening-gate rewrite** — `scripts/check-production-hardening.mjs` hardcodes OCI shape strings + `instances: 1`; de-OCI it and require `instances >= 3` (must land in the same PR as the cutover or it blocks the migration).
5. **Bare-metal Talos provisioning** — **add** `on-prem` deployment-context OpenTofu wrappers + Cluster API + metal3 **alongside** the existing OCI stack (refactor `deploy/opentofu/**` into an `oci-guest` context, keep it working — do not delete). The big substrate *addition*.
6. **HA** — 3-node control plane, Longhorn/Ceph replicated storage, CNPG `instances: 3`, MetalLB/kube-vip VIP, Cilium, multi-cluster ApplicationSet.
7. **`mail_sync` HA fix** (above).
8. **Self-hosted observability** — OTel + VictoriaMetrics/LGTM + Grafana; supersede `log-persistence.md` Direction A; adopt the wide-event/matched-template-label discipline.
9. **Anti-regression gates** — lift `oya-check-iac-tier-discipline` as `mnt-gate-iac-tier`; add a vendor phase-out registry gate.
10. **Doc/ADR portability alignment** — supersede ADR-0005 (WORM replica → separate site), ADR-0015 (DR → multi-node/multi-site), and single-substrate assumptions in OPS-RUNBOOK.md / ENTERPRISE-READINESS.md / GO-LIVE-CHECKLIST.md; write a bare-metal operator runbook while keeping OCI documented as a supported substrate.

## Adopted from oyatie (full-license reuse; repo-relative symbols)

Lift-and-reuse from the sibling oyatie repository: `infra/external-secrets/*` + `infra/kms/openbao.k8s.yaml` (secrets); `libs/oya-check-iac-tier-discipline/src/lib.rs` (CI gate, pure std); `infra/observability/observability.k8s.yaml` (OTel→VictoriaMetrics→Grafana); `infra/seaweedfs/seaweedfs.k8s.yaml`; `infra/gitops/{root-app.yaml,values.yaml}` (app-of-apps + sync-waves). Pattern-to-replicate: the 5-context OpenTofu layout (ADR-0339); Talos-media + CAPI + per-cell ArgoCD (ADR-0375); ApplicationSet multi-cell federation (ADR-0171); OpenBao/HSM per cell (ADR-0043); autosharding (ADR-0348); wide-event observability middleware (`oya-http-wide-event-middleware-infrastructure`, ADR-0536); vendor phase-out registry + gate (ADR-0173). Value objects worth porting: `oya-secrets-domain` `SecretReference`/lease/`ZeroizingSecret`. **Do not** adopt `cloud/cloud-kernel` (an unrelated OS microkernel).

## Consequences

- **Full data sovereignty** (on-prem option), **no cloud *lock-in*** — OCI stays a supported substrate but becomes swappable — **HA across every tier**, no per-GB cloud fees on the on-prem substrate.
- Effort is **concentrated in the substrate**; application code changes are limited to the single `mail_sync` fix + config/endpoint swaps.
- Adopting oyatie's battle-tested blueprint **reduces risk and time** versus a from-scratch design.
- New standing discipline: the `mnt-gate-iac-tier` + vendor-lockin gates make OCI (or any single-cloud) coupling a CI failure going forward — portability becomes enforced, not aspirational.

## Non-goals / open questions

- Exact bare-metal node inventory (count, arch, per-site layout) and the storage backend choice (Longhorn vs Rook-Ceph) are sizing decisions for the substrate lane.
- Whether to reuse oyatie's crates as a shared workspace dependency vs copy-in is decided per lane (some carry oyatie-specific kernel deps).
- Sharding/residency (ADR-0348-style) is deferred until multicluster is live.
