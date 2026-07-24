#!/usr/bin/env bash
# Run Buck2 tests that need PostgreSQL against a disposable local container.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
postgres_image="postgres:18.4@sha256:65f70a152846cf504dff86e807007e9aeac98c3aeb7b62541b2c55ab9d264e56"
container_name="mnt-buck-postgres-${USER:-user}-$$"
buck_bin="${MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK:-${repo_root}/tools/buck2}"
safe_user="${USER:-user}"
safe_user="${safe_user//[^[:alnum:]_.-]/_}"
repo_hash="$(printf '%s' "${repo_root}" | cksum | awk '{print $1}')"
isolation_name="${MNT_BUCK_NEEDS_POSTGRES_ISOLATION_DIR:-mnt-buck-postgres-${safe_user}-${repo_hash}}"
if [[ ! "${isolation_name}" =~ ^[[:alnum:]_.-]+$ ]]; then
  echo "buck-postgres: isolation name must contain only letters, digits, dot, underscore, or dash" >&2
  exit 1
fi
database="mnt_buck_test_$$"

cleanup() {
  local status=$?
  # PostgreSQL state is per invocation, while the Buck daemon is deliberately
  # stable per worktree so concurrent/repeated DB tests reuse compiled actions.
  docker rm -f "${container_name}" >/dev/null 2>&1 || true
  return "${status}"
}
trap cleanup EXIT HUP INT TERM

secret() {
  openssl rand -hex 32
}

admin_password="$(secret)"
app_password="$(secret)"
runtime_password="$(secret)"
leave_command_password="$(secret)"
ontology_command_password="$(secret)"
passwords=(
  "${admin_password}" "${app_password}" "${runtime_password}"
  "${leave_command_password}" "${ontology_command_password}"
)
for ((i = 0; i < ${#passwords[@]}; i++)); do
  for ((j = i + 1; j < ${#passwords[@]}; j++)); do
    if [[ "${passwords[i]}" == "${passwords[j]}" ]]; then
      echo "buck-postgres: generated passwords must be pairwise distinct" >&2
      exit 1
    fi
  done
done

docker run -d --rm --name "${container_name}" \
  -p 127.0.0.1::5432 \
  -e POSTGRES_DB="${database}" \
  -e POSTGRES_USER=mnt_buck_admin \
  -e POSTGRES_PASSWORD="${admin_password}" \
  "${postgres_image}" >/dev/null

docker cp \
  "${repo_root}/ops/postgres-reconcile-topology.sh" \
  "${container_name}:/topology.sh"

for attempt in {1..30}; do
  if docker exec "${container_name}" pg_isready -U mnt_buck_admin -d "${database}" >/dev/null 2>&1; then
    break
  fi
  if [[ "${attempt}" == 30 ]]; then
    echo "buck-postgres: disposable PostgreSQL did not become healthy" >&2
    exit 1
  fi
  sleep 1
done

docker exec \
  -e POSTGRES_HOST=127.0.0.1 \
  -e POSTGRES_PORT=5432 \
  -e POSTGRES_DB="${database}" \
  -e POSTGRES_ADMIN_USER=mnt_buck_admin \
  -e POSTGRES_ADMIN_PASSWORD="${admin_password}" \
  -e MNT_APP_POSTGRES_PASSWORD="${app_password}" \
  -e MNT_RT_POSTGRES_PASSWORD="${runtime_password}" \
  -e MNT_LEAVE_COMMAND_POSTGRES_PASSWORD="${leave_command_password}" \
  -e MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD="${ontology_command_password}" \
  "${container_name}" bash /topology.sh

port_mapping="$(docker port "${container_name}" 5432/tcp)"
port="${port_mapping##*:}"
if [[ ! "${port}" =~ ^[0-9]+$ ]]; then
  echo "buck-postgres: could not resolve disposable PostgreSQL loopback port" >&2
  exit 1
fi
database_url="postgres://mnt_buck_admin:${admin_password}@127.0.0.1:${port}/${database}"

BUCK_ISOLATION_DIR="${isolation_name}" "${buck_bin}" test --local-only "$@" \
  -- --env "DATABASE_URL=${database_url}" --env RUST_TEST_THREADS=1
