#!/usr/bin/env bash
# Shell behavior locks for test_needs_postgres.sh; no Docker daemon required.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
harness="${repo_root}/tools/buck/test_needs_postgres.sh"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/mnt-buck-postgres-test.XXXXXX")"
fake_bin="${scratch}/bin"
log="${scratch}/calls.log"
mkdir -p "${fake_bin}"
trap 'rm -rf "${scratch}"' EXIT

cat >"${fake_bin}/docker" <<'DOCKER'
#!/usr/bin/env bash
printf 'docker' >>"${HARNESS_LOG}"
printf ' %q' "$@" >>"${HARNESS_LOG}"
printf '\n' >>"${HARNESS_LOG}"
case "$1" in
  run) echo fake-container ;;
  exec) exit 0 ;;
  port) echo '127.0.0.1:49123' ;;
  rm) exit 0 ;;
  *) echo "unexpected docker command: $1" >&2; exit 1 ;;
esac
DOCKER
cat >"${fake_bin}/openssl" <<'OPENSSL'
#!/usr/bin/env bash
count_file="${HARNESS_LOG}.secrets"
count=0
[[ -f "${count_file}" ]] && count="$(cat "${count_file}")"
count=$((count + 1))
printf '%s' "${count}" >"${count_file}"
printf 'secret-%s\n' "${count}"
OPENSSL
cat >"${scratch}/buck" <<'BUCK'
#!/usr/bin/env bash
printf 'buck BUCK_ISOLATION_DIR=%q' "${BUCK_ISOLATION_DIR}" >>"${HARNESS_LOG}"
printf ' %q' "$@" >>"${HARNESS_LOG}"
printf '\n' >>"${HARNESS_LOG}"
exit "${FAKE_BUCK_STATUS:-0}"
BUCK
chmod +x "${fake_bin}/docker" "${fake_bin}/openssl" "${scratch}/buck"

PATH="${fake_bin}:${PATH}" HARNESS_LOG="${log}" \
  MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" \
  "${harness}" //backend/crates/platform/db:db-itest-runtime --test-filter smoke

calls="$(cat "${log}")"
grep -Fq -- '-p 127.0.0.1::5432' <<<"${calls}"
! grep -Fq -- '127.0.0.1:5432:5432' <<<"${calls}"
grep -Fq -- 'postgres:18.4@sha256:65f70a152846cf504dff86e807007e9aeac98c3aeb7b62541b2c55ab9d264e56' <<<"${calls}"
grep -Fq -- 'bash /topology.sh' <<<"${calls}"
grep -Eq 'buck BUCK_ISOLATION_DIR=mnt-buck-postgres-[^/ ]+' <<<"${calls}"
! grep -Eq 'buck BUCK_ISOLATION_DIR=[^ ]*/' <<<"${calls}"
! grep -Eq 'buck BUCK_ISOLATION_DIR=[^ ]+ kill$' <<<"${calls}"
grep -Fq -- 'test --local-only //backend/crates/platform/db:db-itest-runtime --test-filter smoke -- --env DATABASE_URL=postgres://mnt_buck_admin:' <<<"${calls}"
grep -Fq -- '--env RUST_TEST_THREADS=1' <<<"${calls}"
! grep -Fq -- 'DATABASE_URL=postgres://mnt_app:' <<<"${calls}"
grep -Fq -- '@127.0.0.1:49123/mnt_buck_test_' <<<"${calls}"
grep -Fq -- 'docker rm -f mnt-buck-postgres-' <<<"${calls}"

if PATH="${fake_bin}:${PATH}" HARNESS_LOG="${log}" \
  MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" FAKE_BUCK_STATUS=17 \
  "${harness}" //backend/crates/platform/db:db-itest-runtime; then
  echo "expected a failing Buck invocation" >&2
  exit 1
fi
test "$(grep -Fc 'docker rm -f mnt-buck-postgres-' "${log}")" = 2
test "$(
  sed -n 's/^buck BUCK_ISOLATION_DIR=\([^ ]*\).*/\1/p' "${log}" |
    sort -u |
    wc -l |
    tr -d ' '
)" = 1

echo "test_needs_postgres: PASS"
