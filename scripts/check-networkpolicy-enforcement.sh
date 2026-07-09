#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RENDER="$(mktemp)"
trap 'rm -f "$RENDER"' EXIT
failures=0

kustomize build "$ROOT/deploy/apps/maintenance/overlays/prod" > "$RENDER"

require() {
  local needle="$1"
  local label="$2"
  if grep -Fq "$needle" "$RENDER"; then
    printf 'PASS  %s\n' "$label"
  else
    printf 'FAIL  %s (missing %q)\n' "$label" "$needle" >&2
    failures=$((failures + 1))
  fi
}

reject() {
  local needle="$1"
  local label="$2"
  if grep -Fq "$needle" "$RENDER"; then
    printf 'FAIL  %s (found forbidden %q)\n' "$label" "$needle" >&2
    failures=$((failures + 1))
  else
    printf 'PASS  %s\n' "$label"
  fi
}

require 'kind: StatefulSet' 'render includes workload objects'
require 'name: mnt-mox' 'render includes mnt-mox resources'
require 'name: allow-app-egress-mox' 'app/worker egress to mox is explicitly allowed'
require 'name: allow-mox-ingress-internal' 'mox ingress is restricted to app/worker and monitoring'
require 'name: default-deny-egress-mox' 'mox egress is default-denied'
require 'name: allow-mox-egress-app-webhook' 'mox can reach the internal app webhook only'
require 'MNT_MAIL_MOX_BASE_URL: http://mnt-mox.maintenance.svc:1080' 'app config points at the in-cluster mox webapi'
require 'port: 1080' 'webapi port is present for internal service traffic'
require 'port: 1143' 'IMAP port is present for internal service traffic'
require 'port: 8010' 'metrics port is present for observability'
reject 'type: NodePort' 'no NodePort services are rendered'
reject 'type: LoadBalancer' 'no LoadBalancer services are rendered'
reject 'containerPort: 25' 'public SMTP/MX port 25 is not enabled'
reject 'containerPort: 587' 'public submission port 587 is not enabled'
reject 'containerPort: 993' 'public IMAPS port 993 is not enabled'
reject 'hostPort:' 'mox does not bind host ports'

if (( failures > 0 )); then
  printf '\nStatic NetworkPolicy proof failed (%d checks). See FAIL lines above.\n' "$failures" >&2
  exit 1
fi

cat <<'MSG'

Static NetworkPolicy proof passed. To prove runtime enforcement on a cluster,
first confirm the CNI enforces NetworkPolicy (plain flannel does not), then run
operator-owned smoke pods with these labels:
  allowed:   app=mnt-app    -> http://mnt-mox.maintenance.svc:1080/webapi/v0/
  denied:    app=mnt-deny   -> same URL must time out/fail
  webhook:   app=mnt-mox    -> http://mnt-app.maintenance.svc:8080/readyz allowed
Keep public MX disabled until that live CNI smoke is recorded in the runbook.
MSG
