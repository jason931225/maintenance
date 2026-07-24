#!/usr/bin/env bash
# Behavior and documentation locks for the cheap Buck2 preflight.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
harness="${repo_root}/tools/buck/preflight.sh"
playbook="${repo_root}/docs/program/console-buck2-scale-playbook.md"
roadmap="${repo_root}/docs/program/console-enterprise-roadmap.md"
ledger="${repo_root}/docs/program/console-program-ledger.md"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/mnt-buck-preflight-test.XXXXXX")"
trap 'rm -rf "${scratch}"' EXIT
mkdir -p "${scratch}/bin" "${scratch}/archive"
log="${scratch}/calls.log"
snapshot="${scratch}/archive"

cat >"${scratch}/buck" <<'BUCK'
#!/usr/bin/env bash
printf 'BUCK_ISOLATION_DIR=%s %s\n' "${BUCK_ISOLATION_DIR:-}" "$*" >>"${HARNESS_LOG}"
case "$1" in
  --version) echo 'buck2 fake' ;;
  audit)
    test "$2" = cell
    echo 'root: /fake/root'
    ;;
  uquery) echo 'root//backend/crates/example:example-unit' ;;
  *) echo "unexpected Buck command: $*" >&2; exit 2 ;;
esac
BUCK
cat >"${scratch}/bin/python3" <<'PYTHON'
#!/usr/bin/env bash
# The manifest validator runs in the caller worktree; preserve the real
# interpreter there. Only the archive-local generator is substituted.
if [[ "$1" == "-" ]]; then
  exec "${REAL_PYTHON3}" "$@"
fi
if [[ "$1" == */validate_generated_faces.py ]]; then
  printf 'VALIDATE_GENERATED_FACES=%s\n' "$*" >>"${HARNESS_LOG}"
  echo 'generated-face-registry: PASS'
  exit 0
fi
if [[ "$1" == */snapshot_root.py ]]; then
  if [[ "$*" == *"--cleanup"* ]]; then exit 0; fi
  printf '%s\n' "${FAKE_SNAPSHOT_ROOT}"
  exit 0
fi
if [[ "$1" == */provision_snapshot_node_modules.py ]]; then
  printf 'SNAPSHOT_NODE_DEPS=%s\n' "$*" >>"${HARNESS_LOG}"
  if [[ "${FAKE_SNAPSHOT_NODE_DEPS_FAIL:-0}" == 1 ]]; then
    exit 19
  fi
  exit 0
fi
if [[ "$1" == */run_generated_face_gates.py ]]; then
  printf 'GENERATED_FACE_GATES=%s\n' "$*" >>"${HARNESS_LOG}"
  if [[ "${FAKE_GENERATED_FACE_GATE_FAIL:-0}" == 1 ]]; then
    exit 17
  fi
  exit 0
fi
if [[ "${FAKE_GENERATOR_DRIFT:-0}" == 1 ]]; then
  printf '# drift\n' >> backend/app/BUCK
fi
PYTHON
chmod +x "${scratch}/buck" "${scratch}/bin/python3"

real_python="$(command -v python3)"
before="$(git -C "${repo_root}" status --porcelain)"
PATH="${scratch}/bin:${PATH}" REAL_PYTHON3="${real_python}" HARNESS_LOG="${log}" FAKE_SNAPSHOT_ROOT="${scratch}/archive" \
  MNT_BUCK_PREFLIGHT_BUCK="${scratch}/buck" \
  MNT_BUCK_PREFLIGHT_ISOLATION_DIR="preflight-lock" "${harness}"
after="$(git -C "${repo_root}" status --porcelain)"
test "${before}" = "${after}"
grep -Fq 'BUCK_ISOLATION_DIR=preflight-lock --version' "${log}"
grep -Fq 'BUCK_ISOLATION_DIR=preflight-lock audit cell' "${log}"
grep -Fq 'BUCK_ISOLATION_DIR=preflight-lock uquery ' "${log}"
grep -Fq 'SNAPSHOT_NODE_DEPS=' "${log}"
grep -Fq 'GENERATED_FACE_GATES=' "${log}"
grep -Fq -- '--tier cheap' "${log}"
grep -Fq "VALIDATE_GENERATED_FACES=${snapshot}/tools/buck/validate_generated_faces.py ${snapshot}/tools/buck/generated_face_registry.json" "${log}"
grep -Fq -- "--registry ${snapshot}/tools/buck/generated_face_registry.json" "${log}"

# The runner is the sole writer dispatcher. Preflight must never invoke a
# generator after snapshot verification, which would mutate the caller tree.
if grep -Eq '^tools/buck/generated-face-[a-z-]+\.sh$' "${harness}"; then
  echo "preflight must not invoke generated-face writers outside the snapshot gate" >&2
  exit 1
fi

# Full candidate closure is separately callable and never treats the expensive
# registry faces as an implicit omission.
PATH="${scratch}/bin:${PATH}" REAL_PYTHON3="${real_python}" HARNESS_LOG="${log}" FAKE_SNAPSHOT_ROOT="${scratch}/archive" \
  MNT_BUCK_PREFLIGHT_BUCK="${scratch}/buck" \
  MNT_BUCK_PREFLIGHT_ISOLATION_DIR="preflight-lock" "${harness}" --full-generated-faces
grep -Fq -- '--tier all' "${log}"

if PATH="${scratch}/bin:${PATH}" REAL_PYTHON3="${real_python}" HARNESS_LOG="${log}" FAKE_SNAPSHOT_ROOT="${scratch}/archive" \
  MNT_BUCK_PREFLIGHT_BUCK="${scratch}/buck" \
  MNT_BUCK_PREFLIGHT_ISOLATION_DIR="preflight-lock" FAKE_GENERATED_FACE_GATE_FAIL=1 "${harness}"; then
  echo "expected a registered generated-face gate failure to fail preflight" >&2
  exit 1
fi

if PATH="${scratch}/bin:${PATH}" REAL_PYTHON3="${real_python}" HARNESS_LOG="${log}" FAKE_SNAPSHOT_ROOT="${scratch}/archive" \
  MNT_BUCK_PREFLIGHT_BUCK="${scratch}/buck" \
  MNT_BUCK_PREFLIGHT_ISOLATION_DIR="preflight-lock" FAKE_SNAPSHOT_NODE_DEPS_FAIL=1 "${harness}"; then
  echo "expected missing or inconsistent snapshot dependencies to fail preflight" >&2
  exit 1
fi

grep -Fq '2026-07-15' "${playbook}"
grep -Fq 'Cells are trust, toolchain, and configuration boundaries' "${playbook}"
grep -Fq 'No per-module cells' "${playbook}"
grep -Fq 'validate_generated_faces.py' "${harness}"
grep -Fq 'generated_face_registry.json' "${repo_root}/tools/buck/test_validate_generated_faces.py"
grep -Fq 'console-buck2-scale-playbook.md' "${roadmap}"
grep -Fq 'console-buck2-scale-playbook.md' "${ledger}"

echo "preflight: PASS"
