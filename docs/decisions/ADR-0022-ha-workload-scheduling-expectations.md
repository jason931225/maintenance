# ADR-0022 design note: HA workload scheduling expectations

## Status

DARK guidance for the future `on-prem` HA topology. This note documents the
scheduling contract that becomes valid after issue #376 delivers a three-member
Talos control plane plus dedicated worker nodes. It does not wire any new
manifests into the live OCI guest app-of-apps root.

## Sources reviewed

- ADR-0022 from `origin/main:docs/decisions/ADR-0022-bare-metal-portability-and-ha.md`.
- GitHub issue #376, `[HA] 3-node Talos HA control plane (etcd quorum)`.
- GitHub issue #379, `[HA] Replicated storage (Longhorn/Rook-Ceph) + CNPG instances:3`.
- GitHub issue #10, verified unrelated (`Landing Page`); the #376 mention of
  "#10 CNPG anti-affinity" is stale. CNPG anti-affinity ownership belongs to #379.
- Current DARK on-prem artifacts under `deploy/apps/storage/`,
  `deploy/apps/maintenance/overlays/on-prem/`, and `deploy/apps/traefik-onprem/`.
- Current live OCI base manifests under `deploy/apps/maintenance/base/`.

## Scheduling contract

1. `oci-guest` remains single-node compatible. Do not add required anti-affinity,
   worker-only node affinity, or topology spread constraints to live base/prod
   manifests that would make the current single-node cluster unschedulable.
2. The future `on-prem` context assumes:
   - three Talos control-plane nodes for etcd quorum;
   - N dedicated worker/storage nodes for general workloads;
   - control-plane nodes do not run general workloads;
   - workers expose at least `kubernetes.io/hostname`, and real deployments add
     `topology.kubernetes.io/zone` or an equivalent site/rack failure-domain label
     before claiming cross-domain HA.
3. HA workload manifests added for `on-prem` must be staged DARK under
   `deploy/apps/**` or a non-live overlay/component until a founder/operator
   cutover explicitly wires them into Argo CD.
4. The minimum anti-collapse rule is hostname spread: replicas for a critical
   workload must not all schedule on the same worker when enough eligible workers
   exist. If the site has rack/zone labels, prefer a second spread dimension across
   that failure domain.
5. Required anti-affinity is appropriate only when the activation prerequisites
   guarantee enough eligible nodes. Before that, DARK examples may use preferred
   anti-affinity plus topology spread to render safely, but activation evidence
   must prove the pods actually landed on separate failure domains.

## Workload classes

| Class | Expectation | Repository owner |
|---|---|---|
| Talos/Kubernetes control plane | No general app, ingress, database, or storage workload should depend on control-plane scheduling in `on-prem`. Node-loss acceptance is one control-plane node lost while etcd/API remain healthy. | #376 and the Talos/on-prem substrate lane |
| Ingress/VIP data plane | Multi-replica ingress must spread across distinct worker nodes and keep a PDB. The staged Traefik on-prem variant already uses required pod anti-affinity and topology spread by `kubernetes.io/hostname`; VIP failover evidence belongs with the VIP/Traefik lane. | `deploy/apps/traefik-onprem/`, issue #378 |
| Stateful Postgres | CNPG instances, synchronous replication, storage class, and CNPG pod anti-affinity are owned by #379. This note only requires that the CNPG lane keep replicas from collapsing onto one node/failure domain and prove primary failover on the HA substrate. | #379 and `deploy/apps/maintenance/overlays/on-prem/` |
| Replicated block storage | Storage replicas must be placed on independent worker/storage nodes. Longhorn/Rook-specific replica placement, disk labels, and rebuild gates belong to the storage lane. | #379 and `deploy/apps/storage/` |
| Maintenance API/web Rollouts | When an `on-prem` app overlay/component is introduced, `mnt-app` and `mnt-web` replicas should spread across workers by hostname, keep `minAvailable: 1`, and avoid control-plane nodes. Do not put these constraints in base/prod while the OCI guest is single-node. | future on-prem maintenance app overlay |
| Background workers | `mnt-worker` is currently single-replica and should not be counted as HA. If scaled above one, it needs idempotent/leased work ownership plus worker-node spread; ADR-0022's `mail_sync` HA defect must be resolved before API/worker horizontal scaling is claimed. | app HA remediation lane |
| GitOps/platform operators | Argo CD, Argo Rollouts, cert-manager, Cilium operator, MetalLB controller, External Secrets/OpenBao, and similar platform controllers should use their chart-native HA/anti-affinity knobs when staged for `on-prem`. DaemonSets such as speakers/agents rely on node coverage instead of pod anti-affinity. | each dark app lane |

## Configuration guidance for future on-prem overlays

Use an overlay/component per workload rather than changing live base manifests.
For a two-replica stateless workload, the expected shape is:

```yaml
spec:
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: <workload-label>
              topologyKey: kubernetes.io/hostname
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: <workload-label>
```

If the target site has fewer eligible workers during a rehearsal, keep the change
DARK and record the missing node/failure-domain prerequisite instead of weakening
the production expectation. If a chart exposes equivalent values (for example the
Traefik on-prem values file), use the chart-native knobs and render the output as
evidence.

## Activation and verification gates

Before any on-prem HA scheduling constraints are considered production-ready,
record:

1. Node inventory showing three control-plane nodes and enough worker/storage
   nodes for the workload's replica and storage-replica counts.
2. Worker labels for `kubernetes.io/hostname` plus the chosen rack/zone/site label
   when cross-domain spread is claimed.
3. Render evidence for the relevant DARK overlay/component and proof that the OCI
   guest base/prod path still renders without the new required constraints.
4. Live or scratch-cluster evidence that pods are on distinct workers/failure
   domains (`kubectl get pod -o wide` plus labels is sufficient for scheduling
   proof; workload-specific failover drills still apply).
5. CNPG-specific proof from #379: three instances, replicated storage,
   synchronous failover, and primary pod/node kill evidence. Do not duplicate that
   scope in generic scheduling cards.

## Consequences

- Anti-affinity expectations are explicit before the HA substrate exists, but no
  active manifest is made stricter for the single-node OCI guest.
- CNPG remains aligned with #379 instead of a stale #10 cross-reference.
- Future on-prem overlays have a common scheduling bar: worker-only placement,
  hostname/failure-domain spread, DARK staging, render evidence, and live node
  placement proof before activation.
