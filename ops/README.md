# Operations

This directory contains the Docker Compose production stack for the MNT FSM backend.

## Local Verification

Boot the production stack:

```sh
docker compose -f ops/compose.yml up -d
```

Check the public Traefik HTTPS route:

```sh
curl -k https://mnt.localhost/healthz
curl -k https://mnt.localhost/readyz
```

For direct service access during development, add the override:

```sh
docker compose -f ops/compose.yml -f ops/compose.dev.yml up -d
curl http://127.0.0.1:8080/healthz
```

Shut the stack down:

```sh
docker compose -f ops/compose.yml down
```

## Image Pins

- Postgres is pinned to `postgres:18.4@sha256:65f70a152846cf504dff86e807007e9aeac98c3aeb7b62541b2c55ab9d264e56`.
- Traefik v3 was live-verified as `traefik:v3.7.5`.
- SeaweedFS is pinned to `chrislusf/seaweedfs:4.32`, one release behind the live `4.33` line per ADR-0005.
- OpenTelemetry Collector contrib is pinned to `0.154.0`.

Refresh a digest before an architecture change:

```sh
docker manifest inspect postgres:18.4
```

## OCI Deployment Steps

1. Provision an OCI Compute VM with Docker Engine and the Compose plugin installed.
2. Create DNS records for the production host and point them at the VM public IP.
3. Set production environment variables in the VM shell or a root-readable env file:

```sh
export MNT_APP_HOST=api.example.com
export MNT_POSTGRES_DB=mnt_prod
export MNT_POSTGRES_USER=mnt_app
export MNT_POSTGRES_PASSWORD='<stored in the production secret manager>'
```

4. Copy the repository checkout to the VM, then build and boot:

```sh
docker compose -f ops/compose.yml up -d --build
docker compose -f ops/compose.yml ps
curl -k "https://${MNT_APP_HOST}/readyz"
```

5. Configure OCI firewall/security-list ingress for `80/tcp` and `443/tcp` only. Do not expose Postgres, SeaweedFS master/filer/admin ports, or the app container directly.
6. Configure backups and PITR under the T0.9/T0.13 runbooks before production data enters the system.

Actual OCI provisioning is an operator action; this repository only declares the deployable stack.
