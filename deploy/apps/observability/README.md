# Self-hosted observability activation runbook (DARK)

This directory stages ADR-0022 lane #8 and GitHub issue #374, "Self-hosted
observability — OTel + LGTM on Talos", without enabling it for the current live
`oci-guest` deployment. The ADR-0022 target for an operator-approved Talos/on-prem
activation is:

- OpenTelemetry Collector receives OTLP from Maintenance workloads and mirrors
  the existing `mnt-app` `/metrics` scrape target.
- VictoriaMetrics stores Prometheus-compatible metrics. ADR-0022 also allows a
  future Mimir swap, but the manifests in this directory intentionally choose
  single-node VictoriaMetrics for the first DARK rehearsal.
- Loki stores OTLP log records.
- Tempo stores OTLP traces.
- Grafana provisions VictoriaMetrics, Loki, and Tempo datasources plus the
  starter Maintenance overview dashboard.

References:

- ADR-0022 — Cloud-Agnostic Multi-Substrate Portability + High Availability
  (`docs/decisions/ADR-0022-bare-metal-portability-and-ha.md` on the mainline
  decision history).
- GitHub issue #374: <https://github.com/jason931225/maintenance/issues/374>.
- Historical `docs/specs/log-persistence.md` Direction A. That spec remains
  useful for collection rationale, operational-log/audit-chain boundaries, and
  retention tradeoffs, but ADR-0022/#374 supersede its OCI-managed observability
  direction for Talos/on-prem activation. Do not delete the historical context;
  keep or restore the supersession banner when the spec is present on a branch.

## What is DARK, and what Argo CD should do

The stack is deliberately reviewable before it can affect production traffic:

- Files live under `deploy/apps/observability/`, not `deploy/argocd/apps/`, so
  the live `root` app-of-apps does not discover them by default.
- `kustomize build deploy/apps/observability` renders only an isolated Argo CD
  `AppProject` and a manual-sync `Application` named
  `maintenance-observability-dark`.
- `application.yaml` has no `syncPolicy.automated`, so even after an operator
  applies the dark Application, Argo will not self-sync, prune, or self-heal this
  stack unless the operator manually syncs it.
- The workload stack under `manifests/` is created only after an approved manual
  sync of `maintenance-observability-dark` or an explicit non-production
  `kubectl apply -k deploy/apps/observability/manifests`.
- The existing live Maintenance Argo Application still points at
  `deploy/apps/maintenance/overlays/prod` unless an operator intentionally
  changes a rehearsal/on-prem cluster to the activation overlay described below.

Expected GitOps behavior after applying only this directory:

1. `root` and the current `maintenance` Application remain unchanged.
2. Argo CD may show `maintenance-observability-dark` as `OutOfSync` until an
   operator manually syncs it.
3. No app pod should get `OTEL_EXPORTER_OTLP_ENDPOINT` until the Maintenance
   workload is deployed from `deploy/apps/maintenance/overlays/on-prem-observability`.

## Files

- `project.yaml` — isolated Argo CD AppProject for the dark stack.
- `application.yaml` — manual-sync Argo CD Application pointing at
  `deploy/apps/observability/manifests`.
- `manifests/namespace.yaml` — `maintenance-observability` namespace with
  restricted Pod Security labels.
- `manifests/telemetry-ingest.yaml` — OTel Collector receiver and fan-out
  pipelines.
- `manifests/victoriametrics.yaml` — single-node metrics store and Service.
- `manifests/logs-store.yaml` — single-binary Loki log store and Service.
- `manifests/tempo.yaml` — single-binary Tempo trace store and Service.
- `manifests/grafana-stack.yaml` — Grafana PVC, datasource provisioning,
  starter dashboard, Deployment, and Service.

## Data flow

### App OTLP traffic

The activation overlay
`deploy/apps/maintenance/overlays/on-prem-observability` patches the Maintenance
ConfigMap with:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.maintenance-observability.svc.cluster.local:4317
```

That flips on the app's existing OTLP exporter by configuration only; do not
rewrite `init_tracing` for activation. The overlay also adds a NetworkPolicy that
allows only `mnt-app` and `mnt-worker` in namespace `maintenance` to egress to the
collector on TCP `4317`.

The OTel Collector listens on:

- OTLP gRPC: `otel-collector.maintenance-observability.svc.cluster.local:4317`
- OTLP HTTP: `otel-collector.maintenance-observability.svc.cluster.local:4318`

### Metrics

Metrics reach VictoriaMetrics in two ways:

1. OTLP metrics sent to the collector are exported with
   `prometheusremotewrite` to
   `http://victoriametrics.maintenance-observability.svc.cluster.local:8428/api/v1/write`.
2. The collector's Prometheus receiver mirrors the existing
   `mnt-app.maintenance.svc.cluster.local:8080/metrics` scrape every 30 seconds
   and remote-writes those samples to VictoriaMetrics.

Do not replace `deploy/apps/maintenance/components/monitoring/`. That component
remains the source of truth for the Prometheus Operator contract:

- `ServiceMonitor/mnt-app` scrapes `mnt-app.maintenance.svc` on port `http`
  (`8080`) at `/metrics` every 30 seconds.
- `PrometheusRule/mnt-app-slo` defines the availability and latency alerts over
  `http_server_request_duration_seconds_*`.

Grafana uses the provisioned `VictoriaMetrics` Prometheus datasource to query the
metrics store.

### Logs

The staged collector accepts OTLP log records and exports them to Loki at:

```text
http://loki.maintenance-observability.svc.cluster.local:3100/otlp
```

This is not a node-level stdout log shipper. If a future lane needs pod stdout
tailing from `/var/log/pods/*`, add that as a separate, reviewed collector-agent
change. For this activation, validate Loki with an OTLP log-producing source or a
synthetic OTLP log smoke test before claiming log ingestion is live.

Grafana uses the provisioned `Loki` datasource for Explore/log queries.

### Traces

OTLP traces sent to the collector are exported to Tempo at:

```text
tempo.maintenance-observability.svc.cluster.local:4317
```

Grafana uses the provisioned `Tempo` datasource. The Tempo datasource is linked
to Loki for trace-to-log navigation and to VictoriaMetrics for service-map
metrics.

## Activation prerequisites

Do not activate against production traffic until all prerequisites are true and
recorded in the change ticket/runbook:

1. Founder/operator approval for a Talos on-prem or non-production rehearsal
   cluster that is allowed to run the ADR-0022 DARK stack.
2. `kubectl` and Argo CD access for the target cluster and namespace `argocd`.
3. A storage class that can satisfy the RWO PVCs:
   - `victoriametrics-data`: 20 GiB
   - `loki-data`: 20 GiB
   - `tempo-data`: 20 GiB
   - `grafana-data`: 5 GiB
4. Capacity for the first rehearsal footprint: one replica each for OTel
   Collector, VictoriaMetrics, Loki, Tempo, and Grafana. These manifests are not
   HA; ADR-0022 HA evidence requires later replica/storage/failure-domain work.
5. NetworkPolicy enforcement that honors the overlay rules between `maintenance`
   and `maintenance-observability`.
6. Prometheus Operator CRDs if the activation overlay includes
   `deploy/apps/maintenance/components/monitoring`:
   `servicemonitors.monitoring.coreos.com` and
   `prometheusrules.monitoring.coreos.com`.
7. A Grafana admin password supplied out-of-band. No Grafana password, datasource
   credential, Talos secret, or production endpoint is committed here.
8. Route-label/cardinality-safe app code from issue #374 is present before using
   this stack for real traffic. Request metrics and traces must use bounded
   `http_route` route templates, not raw paths or query strings.

## Review before enabling

From the repo root, render the manifests and inspect the activation boundary:

```sh
kubectl kustomize deploy/apps/observability >/tmp/mnt-observability-argocd.yaml
kubectl kustomize deploy/apps/observability/manifests >/tmp/mnt-observability-stack.yaml
kubectl kustomize deploy/apps/maintenance/overlays/on-prem-observability >/tmp/mnt-on-prem-observability.yaml

kubeconform -strict -ignore-missing-schemas -summary /tmp/mnt-observability-argocd.yaml
kubeconform -strict -ignore-missing-schemas -summary /tmp/mnt-observability-stack.yaml
kubeconform -strict -ignore-missing-schemas -summary /tmp/mnt-on-prem-observability.yaml
```

Then verify the dark boundary manually:

```sh
# No automated sync on the dark observability Application.
yq '.spec.syncPolicy.automated' deploy/apps/observability/application.yaml

# The live app-of-apps should not reference deploy/apps/observability.
grep -R "deploy/apps/observability" deploy/argocd || true

# The current live Maintenance app should stay prod unless this is a deliberate
# rehearsal/on-prem activation change.
yq '.spec.source.path' deploy/argocd/apps/maintenance.yaml
```

Expected results before activation:

- top-level observability render contains only `AppProject` and `Application`;
- stack render contains namespace-scoped workloads, Services, ConfigMaps, and
  PVCs for the observability namespace;
- no live Argo app-of-apps path points at the DARK directory;
- the plain `on-prem` and `prod` overlays do not set `OTEL_EXPORTER_OTLP_ENDPOINT`.

## Enable on a rehearsal/on-prem Talos cluster

1. Create the Grafana admin secret before syncing the stack:

   ```sh
   kubectl create namespace maintenance-observability --dry-run=client -o yaml | kubectl apply -f -
   kubectl -n maintenance-observability create secret generic maintenance-grafana-admin \
     --from-literal=password='<operator-provided-password>'
   ```

2. Register the dark Argo project/application:

   ```sh
   kubectl apply -k deploy/apps/observability
   kubectl -n argocd get appproject maintenance-observability-dark
   kubectl -n argocd get application maintenance-observability-dark
   ```

3. Review the diff in Argo CD, then manually sync the dark app:

   ```sh
   argocd app diff maintenance-observability-dark
   argocd app sync maintenance-observability-dark --prune
   ```

   If the rehearsal cluster does not use the Argo CD CLI, perform the same manual
   sync through the Argo UI. Do not add `syncPolicy.automated` during the first
   activation.

4. Activate the Maintenance workload only for the approved on-prem context:

   - GitOps path: point the rehearsal/on-prem Maintenance Application at
     `deploy/apps/maintenance/overlays/on-prem-observability`, review the diff,
     then sync it.
   - Non-GitOps scratch cluster: apply the rendered overlay directly only for a
     disposable validation run.

   Do not point the current `oci-guest`/prod Application at this overlay. Use
   `deploy/apps/maintenance/overlays/on-prem` or `deploy/apps/maintenance/overlays/prod`
   when the collector, Prometheus Operator CRDs, or storage prerequisites are not
   installed.

5. Wait for rollouts:

   ```sh
   kubectl -n maintenance-observability rollout status deploy/otel-collector
   kubectl -n maintenance-observability rollout status deploy/victoriametrics
   kubectl -n maintenance-observability rollout status deploy/loki
   kubectl -n maintenance-observability rollout status deploy/tempo
   kubectl -n maintenance-observability rollout status deploy/grafana

   kubectl -n maintenance rollout status rollout/mnt-app
   kubectl -n maintenance rollout status deploy/mnt-worker
   ```

## Validate after activation

Capture command output or screenshots for each subsection before routing real
production traffic through the stack.

### 1. Kubernetes resources and DARK/GitOps state

```sh
kubectl -n argocd get application maintenance-observability-dark -o wide
kubectl -n argocd get application maintenance-observability-dark -o jsonpath='{.spec.syncPolicy.automated}{"\n"}'
kubectl -n maintenance-observability get deploy,svc,pvc,configmap
kubectl -n maintenance get networkpolicy allow-app-egress-otel-collector allow-mnt-app-metrics-from-otel-collector
kubectl -n maintenance get configmap mnt-config -o jsonpath='{.data.OTEL_EXPORTER_OTLP_ENDPOINT}{"\n"}'
```

Expected:

- the dark Application exists and has no automated sync policy;
- all five observability Deployments are available;
- the collector Service exposes `otlp-grpc`/`4317` and `otlp-http`/`4318`;
- `mnt-config` contains the collector endpoint only in the activation overlay;
- network policies allow only the scoped app/worker OTLP egress and collector
  metrics scrape mirror.

### 2. Grafana access and datasource health

```sh
kubectl -n maintenance-observability port-forward svc/grafana 3000:3000
```

In another shell:

```sh
export GRAFANA_PASSWORD='<operator-provided-password>'
curl -sf http://127.0.0.1:3000/api/health
curl -sf -u "admin:${GRAFANA_PASSWORD}" http://127.0.0.1:3000/api/datasources
```

Expected:

- Grafana health returns `ok`;
- datasources include `VictoriaMetrics`, `Loki`, and `Tempo` with UIDs
  `victoriametrics`, `loki`, and `tempo`;
- the `Maintenance Observability Overview` dashboard is present under the
  `Maintenance` folder.

### 3. Metrics continuity in VictoriaMetrics

Port-forward VictoriaMetrics:

```sh
kubectl -n maintenance-observability port-forward svc/victoriametrics 8428:8428
```

Generate a few app requests, then query:

```sh
curl -G http://127.0.0.1:8428/api/v1/query \
  --data-urlencode 'query=up{job="mnt-app-servicemonitor-mirror"}'

curl -G http://127.0.0.1:8428/api/v1/query \
  --data-urlencode 'query=sum(rate(http_server_request_duration_seconds_count{service_name="mnt-app-api"}[5m]))'
```

Expected:

- the `up{job="mnt-app-servicemonitor-mirror"}` series is present and `1`;
- request counters continue increasing after activation;
- the same request-rate/p99 panels render in Grafana through the
  `VictoriaMetrics` datasource.

### 4. Log ingestion in Loki

If an OTLP-log-capable app source is available, use it. Otherwise send a bounded
synthetic OTLP log smoke record to the collector and then query Loki.

```sh
kubectl -n maintenance-observability port-forward svc/otel-collector 4318:4318
```

In another shell:

```sh
now_ns="$(python3 - <<'PY'
import time
print(time.time_ns())
PY
)"

curl -sf -H 'Content-Type: application/json' \
  http://127.0.0.1:4318/v1/logs \
  -d "{\"resourceLogs\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"activation-smoke\"}}]},\"scopeLogs\":[{\"logRecords\":[{\"timeUnixNano\":\"${now_ns}\",\"severityText\":\"INFO\",\"body\":{\"stringValue\":\"maintenance observability activation smoke\"}}]}]}]}]}"
```

Port-forward Loki and query:

```sh
kubectl -n maintenance-observability port-forward svc/loki 3100:3100

curl -G http://127.0.0.1:3100/loki/api/v1/query \
  --data-urlencode 'query={service_name="activation-smoke"}'
```

Expected: Loki returns the synthetic log record. If this fails, do not claim log
ingestion is live; inspect the OTel Collector and Loki logs first:

```sh
kubectl -n maintenance-observability logs deploy/otel-collector
kubectl -n maintenance-observability logs deploy/loki
```

### 5. Trace ingestion in Tempo

Exercise the app through a real HTTP request after the activation overlay has
rolled. Then use Grafana Explore with the `Tempo` datasource to search for
`service.name=mnt-app-api`.

For a synthetic smoke test, run telemetrygen inside the cluster:

```sh
kubectl -n maintenance-observability run telemetrygen-traces \
  --rm -i --restart=Never \
  --image=ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:0.119.0 \
  -- traces \
  --otlp-endpoint otel-collector.maintenance-observability.svc.cluster.local:4317 \
  --otlp-insecure \
  --service activation-smoke \
  --traces 3
```

Port-forward Tempo and search if the Tempo search API is enabled in the target
image/config:

```sh
kubectl -n maintenance-observability port-forward svc/tempo 3200:3200
curl -G http://127.0.0.1:3200/api/search \
  --data-urlencode 'tags=service.name=activation-smoke' \
  --data-urlencode 'limit=20'
```

Expected: the smoke service or real `mnt-app-api` traces are visible in Grafana
Tempo Explore. If direct Tempo search is unavailable, Grafana Explore evidence is
the acceptance artifact.

### 6. Route-label/cardinality checks for issue #374

After generating requests with path parameters and query strings, query the route
label set:

```sh
curl -G http://127.0.0.1:8428/api/v1/label/http_route/values

curl -G http://127.0.0.1:8428/api/v1/series \
  --data-urlencode 'match[]=http_server_request_duration_seconds_count{service_name="mnt-app-api"}'
```

Expected:

- `http_route` values are bounded route templates, plus the bounded
  `/_unmatched` sentinel when appropriate;
- raw UUIDs, numeric IDs, user input, and query strings do not appear as route
  label values;
- request metric series do not carry high-cardinality raw `path`, `uri`, or
  query labels.

If any raw request path appears in metrics, traces, or Grafana labels, roll back
traffic to the non-observability overlay and fix the issue #374 middleware before
reactivating.

## Rollback

Rollback order matters: stop app export first, then decide whether to keep or
remove the observability stack for forensics.

1. Point the Maintenance workload back to an overlay that does not set
   `OTEL_EXPORTER_OTLP_ENDPOINT`:

   - `deploy/apps/maintenance/overlays/on-prem` for on-prem without the DARK
     collector;
   - `deploy/apps/maintenance/overlays/prod` for the current `oci-guest` prod
     shape.

2. Sync/roll the Maintenance Application and verify the endpoint is absent:

   ```sh
   kubectl -n maintenance rollout status rollout/mnt-app
   kubectl -n maintenance rollout status deploy/mnt-worker
   kubectl -n maintenance get configmap mnt-config -o jsonpath='{.data.OTEL_EXPORTER_OTLP_ENDPOINT}{"\n"}'
   ```

   Expected: the JSONPath prints nothing for non-observability overlays.

3. Leave `maintenance-observability-dark` unsynced or delete it, depending on
   whether evidence must be preserved:

   - Preserve data for investigation: stop syncing new changes and keep the PVCs.
   - Remove the rehearsal stack and its data: delete through Argo CD with cascade
     after explicitly accepting PVC/data loss.

   ```sh
   argocd app terminate-op maintenance-observability-dark || true
   argocd app delete maintenance-observability-dark --cascade
   kubectl delete -k deploy/apps/observability
   ```

4. Re-run the resource checks:

   ```sh
   kubectl -n maintenance-observability get deploy,svc,pvc
   kubectl -n argocd get application maintenance-observability-dark
   ```

5. Record the rollback reason, whether PVCs were retained, and the last good
   Grafana/VictoriaMetrics/Loki/Tempo evidence in the incident/change ticket.

## Activation evidence checklist

Attach these artifacts to the activation ticket before declaring the stack live:

- local render/kubeconform output for the Argo app, workload stack, and
  Maintenance activation overlay;
- Argo screenshot or CLI output showing `maintenance-observability-dark` was
  manually synced and is healthy;
- Kubernetes rollout/resource output for the five observability Deployments;
- proof that `OTEL_EXPORTER_OTLP_ENDPOINT` is present only in the activation
  overlay;
- Grafana health plus datasource evidence;
- VictoriaMetrics query output showing fresh app metrics;
- Loki query output for real or synthetic OTLP logs;
- Tempo/Grafana Explore evidence for app or synthetic traces;
- route-label/cardinality evidence showing bounded `http_route` values and no
  raw paths/query strings;
- rollback decision and exact command path.