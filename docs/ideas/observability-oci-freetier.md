# Observability on OCI Free-Tier — Refined Direction (A)

## Problem Statement
How might we run durable, searchable, compliance-grade three-pillar observability for a solo-operated multi-tenant platform on effectively-free OCI hardware, without it becoming a fragile system to babysit?

## Recommended Direction (locked: A — load-bearing Loki + managed-OCI pillars, all-OTel)
- **OTel Collector DaemonSet** (node tailer, filelog receiver, ~100–150 MB tuned) on all nodes incl. the A1 → forwards to the gateway. One tool — no separate Fluent Bit.
- **Micro 1:** OTel Collector **gateway** + **Grafana** (always-on single pane).
- **Micro 2:** **Loki** — primary hot+full log store on a **durable OCI block-volume PVC** (block storage is not metered like Logging ingest → full logs are effectively free). Load-bearing, hard-tuned.
- **OCI Logging** = durable retention of the **full, unfiltered** stream (comfortably under the 10 GB/mo free ceiling at this volume; an OCI Monitoring alarm at ~8 GB is the canary). Service Connector → Object Storage for the >180 d (→1 yr) tail.
- **OCI Monitoring** = metrics (500 M free ingestion pts).
- **OCI APM** = head-sampled traces via the app's existing OTLP exporter (free = 1000 events/hr).
- **Grafana** unifies Loki + OCI Logging + OCI Monitoring + OCI APM via Oracle datasources.

Rationale: full logs land in BOTH free tiers — self-hosted Loki (block storage) for fast LogQL, OCI Logging (managed) for durable retention — no filtering needed at this volume.

## Key Assumptions to Validate
- [ ] **A1 capacity** — halved to 2 OCPU/12 GB on 2026-06-15; confirm the live node is grandfathered at 4/24, design to survive a 2/12 rebuild. Test: OCI console shape.
- [ ] **Full log volume < 10 GB/mo to OCI Logging** (alarm at ~8 GB). Test: watch Logging usage a week.
- [ ] **Trace volume < 1000/hr to APM** after head-sampling.
- [ ] **Loki survives 1 GB** under worst-case LogQL (mem-limit + OCI alarm).
- [ ] **OTel agent fits the 1 GB micros** tuned (~100–150 MB); Fluent Bit is the fallback if it OOMs.
- [ ] **1-yr retention** via Logging (≤180 d) → Object Storage Service Connector.

## MVP Scope
Phase-1 = the log pillar end-to-end: OTel Collector DaemonSet → OTel gateway → Loki (hot/full, PVC) + OCI Logging (full). Grafana pane over both. Accept: kill a pod → its final lines are in Loki AND OCI Logging; a LogQL trace_id search lands the request; unauth UI refused. Metrics (OCI Monitoring) + head-sampled traces (APM) are Phase-2/3 fast-follows.

## Not Doing (and why)
- **No Fluent Bit** — all-OTel pipeline; FB is the fallback only if a micro OOMs.
- **No filtering to OCI Logging** — volume is comfortably under the 10 GB/mo free cap; an 8 GB alarm-canary guards against runaways.
- **No self-hosted Tempo/Prometheus** — OCI APM/Monitoring are the managed backends; no RAM on the micros.
- **No legal-compliance rigor bolted onto ops logs** — the tamper-evident audit chain is the legal record; ops logs are best-effort forensics.
- **No PAYG** (locked) — accept the 1 GB Loki reliability ceiling, mitigated by tuning + graceful degradation.

## Open Questions
- Real daily log volume (confirm the <10 GB/mo headroom)?
- App-metrics path: push to OCI Monitoring custom metrics vs a tiny scrape — no Prometheus deployed today?
- If the node is 2/12 (not 4/24): fold the gateway into the DaemonSet (drop the separate gateway pod) to reclaim RAM?
