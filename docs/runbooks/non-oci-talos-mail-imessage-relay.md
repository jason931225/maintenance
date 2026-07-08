# Non-OCI Talos mail and iMessage relay runbook

## Deployment split

The current OCI Talos cluster keeps the existing production app, web, API, worker,
database, object-storage integration, and transactional email path. OTP and admin
one-time email must continue to use OCI Email Delivery from the existing
`mnt-config` values:

- `MNT_EMAIL_SMTP_HOST=smtp.email.ap-chuncheon-1.oci.oraclecloud.com`
- `MNT_EMAIL_SMTP_PORT=587`
- `MNT_EMAIL_FROM=no-reply@knllogistic.com`

Do not reclassify this OCI SMTP relay as authoritative corporate mailbox or MX
hosting. It is only the outbound transactional path for current product flows.

The non-OCI Talos cluster is the intended home for new authoritative corporate
mail/MX workloads and the iMessage relay/proxy. This runbook is repo-local
deployment preparation only. It does not authorize live DNS, MX, port-25,
external-provider, production-cluster, or Argo sync changes.

## Public MX gate

Public MX remains blocked until `ADR-0019`
(`docs/decisions/ADR-0019-standalone-mailbox-server-build-vs-adopt.md`) and
`docs/specs/standalone-corporate-mailbox-server.md` production gates pass. Do
not expose port 25 or publish MX records until all of these are verified:

- DNS readiness: MX, SPF, DKIM, DMARC, MTA-STS, and TLS-RPT.
- TLS issuance and rotation.
- Durable queueing, retry, dead-letter, and bounce behavior.
- abuse controls: no-open-relay negative tests, rate limits, oversized message
  rejection, invalid recipient handling, quarantine or spam path, and audit.
- Observability: redacted logs, delivery metrics, queue depth, alerts, and trace
  correlation.
- Backup, restore, object retention, and rollback procedure.
- Argo rollout health and rollback validation for the non-OCI Talos target.

Until those gates pass, the only acceptable mail work here is internal-only
deployment preparation, disabled-by-default manifests, dry-run checks, and local
or cluster-private smoke tests.

The opt-in relay component also ships with a non-routable TEST-NET bridge egress
CIDR (`192.0.2.0/24`). A non-OCI overlay must patch it to the exact private
macOS bridge CIDR before the component can reach the bridge.

The relay component is stateless by default: it uses a static recipient allowlist
from `imessage-relay-secrets` and does not mount the app runtime database secret.
A future platform-recipient database source must introduce a dedicated
least-privilege relay database role and policies rather than reusing `mnt-db-rt`.
The non-OCI overlay must also patch the TEST-NET caller ingress CIDR, pin the
relay image to a signed immutable digest, and verify a policy-capable CNI before
relying on Kubernetes NetworkPolicy enforcement.

## iMessage relay model

iMessage does not run natively on Talos or Linux. The non-OCI Talos cluster may
host only the relay/proxy workload. A macOS host must run the Messages bridge and
must be reachable by the relay only through a private authenticated channel:

- mTLS, VPN, or another private endpoint.
- Bearer token or stronger application authentication.
- HTTPS-only bridge URL in dry-run and runtime configuration.
- No public bridge endpoint.
- No token, certificate, private key, account password, message body, or contact
  content printed in logs or committed to git.

Repository artifacts may reference only secret names and keys. The expected
runtime inputs are non-OCI Talos kubeconfig/talosconfig plus macOS bridge
endpoint and credential material supplied out of band.

## Dry-run blocker

If the non-OCI Talos kubeconfig/talosconfig or macOS bridge endpoint/certificate
or token inputs are absent, the dry-run guard must fail truthfully instead of
pretending the path is deployable:

```text
BLOCKED_PENDING_NON_OCI_TALOS_CREDENTIALS
blocked_missing_non_oci_talos_or_bridge_credentials
exit code 2
```

That blocker means the repo-local docs, tests, and manifests can still land, but
live deployment cannot proceed.

## Operator checks

Before any future non-OCI Talos apply, confirm these checks from a clean working
tree:

```sh
test -f docs/runbooks/non-oci-talos-mail-imessage-relay.md
grep -F BLOCKED_PENDING_NON_OCI_TALOS_CREDENTIALS docs/runbooks/non-oci-talos-mail-imessage-relay.md
grep -F MNT_EMAIL_SMTP_PORT=587 docs/runbooks/non-oci-talos-mail-imessage-relay.md
git diff -- deploy/apps/maintenance/base/configmap.yaml
git diff -- deploy/talos/README.md
```

Expected result for the final two commands in this lane: no diff. The OCI
production deployment remains the source of truth for app/web/API and
transactional OCI Email Delivery while non-OCI Talos credentials and bridge
inputs are missing.
