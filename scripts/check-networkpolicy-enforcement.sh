#!/usr/bin/env bash
# Read back live cluster NetworkPolicy enforcement prerequisites.
#
# This deliberately complements scripts/render-k8s-manifests.sh. Rendering proves
# the Kubernetes desired state is syntactically valid; this preflight proves the
# target cluster has a policy-capable CNI/enforcer before operators claim network
# isolation.
set -euo pipefail

KUBECTL="${KUBECTL:-kubectl}"
NAMESPACE="${MNT_NETWORKPOLICY_NAMESPACE:-maintenance}"
MODE="${MNT_NETWORKPOLICY_PREFLIGHT:-warn}"
EXPECTED_ENFORCER="${MNT_NETWORKPOLICY_EXPECTED_ENFORCER:-auto}"
CILIUM_NAMESPACE="${MNT_NETWORKPOLICY_CILIUM_NAMESPACE:-kube-system}"

usage() {
  cat <<'USAGE'
Usage: scripts/check-networkpolicy-enforcement.sh

Environment:
  MNT_NETWORKPOLICY_PREFLIGHT=warn|require|off
      warn    (default): print a warning and exit 0 when no live cluster/CNI proof
               is available. Suitable for generic CI where manifests still render.
      require: fail when kubectl cannot reach the target cluster, the namespace or
               NetworkPolicies are absent, or no policy-capable CNI is detected.
      off:     skip the live readback entirely.
  MNT_NETWORKPOLICY_NAMESPACE=maintenance
      Namespace that must contain applied NetworkPolicy objects.
  MNT_NETWORKPOLICY_EXPECTED_ENFORCER=auto|cilium|calico|canal|antrea|kube-router|ovn-kubernetes
      Optional expected CNI/policy enforcer. "auto" accepts any recognized
      NetworkPolicy-capable enforcer and rejects plain flannel-only clusters.
  MNT_NETWORKPOLICY_CILIUM_NAMESPACE=kube-system
      Namespace that must contain the Cilium DaemonSet/config when the expected
      enforcer is cilium.
  KUBECTL=kubectl
      kubectl binary to use.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

case "${MODE}" in
  warn|warning)
    MODE="warn"
    ;;
  require|required|fail|strict)
    MODE="require"
    ;;
  off|skip|disabled)
    echo "networkpolicy-preflight: skipped (MNT_NETWORKPOLICY_PREFLIGHT=${MODE})"
    exit 0
    ;;
  *)
    echo "networkpolicy-preflight: invalid MNT_NETWORKPOLICY_PREFLIGHT=${MODE}; expected warn, require, or off" >&2
    exit 2
    ;;
esac

case "${EXPECTED_ENFORCER}" in
  auto|cilium|calico|canal|antrea|kube-router|ovn-kubernetes)
    ;;
  *)
    echo "networkpolicy-preflight: invalid MNT_NETWORKPOLICY_EXPECTED_ENFORCER=${EXPECTED_ENFORCER}" >&2
    exit 2
    ;;
esac

finish_unavailable() {
  local message="$1"
  if [[ "${MODE}" == "require" ]]; then
    echo "networkpolicy-preflight: FAIL: ${message}" >&2
    exit 1
  fi
  echo "networkpolicy-preflight: WARNING: ${message}" >&2
  echo "networkpolicy-preflight: CI/render validation continues, but this is NOT live NetworkPolicy enforcement proof." >&2
  exit 0
}

require_output() {
  local description="$1"
  shift
  local output
  if ! output="$("$@" 2>/dev/null)"; then
    finish_unavailable "could not ${description}; check kubeconfig, RBAC, and target cluster context"
  fi
  printf '%s' "${output}"
}

if ! command -v "${KUBECTL}" >/dev/null 2>&1; then
  finish_unavailable "${KUBECTL} not found; cannot read cluster/CNI NetworkPolicy capability"
fi

context="$(require_output "read kubectl current-context" "${KUBECTL}" config current-context)"
if [[ -z "${context}" ]]; then
  finish_unavailable "kubectl has no current context"
fi

api_resources="$(require_output "read Kubernetes networking.k8s.io API resources" "${KUBECTL}" api-resources --api-group=networking.k8s.io --no-headers)"
if ! grep -Eq '(^|[[:space:]])networkpolicies([[:space:]]|$)' <<<"${api_resources}"; then
  finish_unavailable "cluster ${context} does not advertise networking.k8s.io NetworkPolicy resources"
fi

if ! "${KUBECTL}" get namespace "${NAMESPACE}" >/dev/null 2>&1; then
  finish_unavailable "namespace ${NAMESPACE} is not readable in cluster ${context}; applied NetworkPolicies cannot be confirmed"
fi

policies="$(require_output "read NetworkPolicies in namespace ${NAMESPACE}" "${KUBECTL}" -n "${NAMESPACE}" get networkpolicy -o name --ignore-not-found)"
if [[ -z "${policies}" ]]; then
  finish_unavailable "namespace ${NAMESPACE} has no applied NetworkPolicy objects in cluster ${context}"
fi

resources="$(require_output "list CNI controller/agent workloads" "${KUBECTL}" get pods,daemonsets,deployments -A -o jsonpath='{range .items[*]}{.kind} {.metadata.namespace}/{.metadata.name}{"\n"}{end}')"
crds="$(${KUBECTL} get crd -o name 2>/dev/null || true)"
snapshot="$(printf '%s\n%s\n' "${resources}" "${crds}" | tr '[:upper:]' '[:lower:]')"

declare -a enforcers=()

if grep -Eq '(^|[[:space:]/-])cilium([[:space:]/-]|$)|cilium\.io|ciliumnetworkpolic' <<<"${snapshot}"; then
  enforcers+=("cilium")
fi
if grep -Eq 'calico-node|tigera-operator|projectcalico\.org|calico\.org|/calico($|[[:space:]-])|(^|[[:space:]/-])canal([[:space:]/-]|$)' <<<"${snapshot}"; then
  enforcers+=("calico")
fi
if grep -Eq 'antrea-agent|antrea-controller|antrea\.io|antrea\.tanzu\.vmware\.com' <<<"${snapshot}"; then
  enforcers+=("antrea")
fi
if grep -Eq 'kube-router' <<<"${snapshot}"; then
  enforcers+=("kube-router")
fi
if grep -Eq 'ovn-kubernetes|ovnkube-node|openshift-ovn-kubernetes' <<<"${snapshot}"; then
  enforcers+=("ovn-kubernetes")
fi

flannel_detected=0
if grep -Eq 'kube-flannel|/flannel($|[[:space:]-])|flannel\.cni|(^|[[:space:]/-])canal([[:space:]/-]|$)' <<<"${snapshot}"; then
  flannel_detected=1
fi
flannel_note=""
if [[ "${flannel_detected}" -eq 1 ]]; then
  flannel_note=" (flannel present)"
fi

expected_found=0
if [[ "${EXPECTED_ENFORCER}" == "auto" ]]; then
  if [[ "${#enforcers[@]}" -eq 0 ]]; then
    if [[ "${flannel_detected}" -eq 1 ]]; then
      finish_unavailable "cluster ${context} appears to run flannel without a detected policy engine; plain flannel does not enforce NetworkPolicy"
    fi
    finish_unavailable "no recognized policy-capable CNI/enforcer found in cluster ${context}; checked Cilium, Calico/Canal, Antrea, kube-router, and OVN-Kubernetes"
  fi
else
  for enforcer in "${enforcers[@]}"; do
    if [[ "${EXPECTED_ENFORCER}" == "${enforcer}" ]]; then
      expected_found=1
    fi
    if [[ "${EXPECTED_ENFORCER}" == "canal" && "${enforcer}" == "calico" && "${flannel_detected}" -eq 1 ]]; then
      expected_found=1
    fi
  done
  if [[ "${expected_found}" -ne 1 ]]; then
    finish_unavailable "expected ${EXPECTED_ENFORCER} NetworkPolicy enforcer was not detected in cluster ${context}; detected: ${enforcers[*]:-none}${flannel_note}"
  fi
fi

cilium_ready_note=""
if [[ "${EXPECTED_ENFORCER}" == "cilium" ]]; then
  cilium_status="$("${KUBECTL}" -n "${CILIUM_NAMESPACE}" get daemonset cilium -o jsonpath='{.status.desiredNumberScheduled} {.status.numberReady} {.status.updatedNumberScheduled}' 2>/dev/null || true)"
  if [[ -z "${cilium_status}" ]]; then
    finish_unavailable "expected cilium, but daemonset ${CILIUM_NAMESPACE}/cilium is not readable; Cilium live status cannot be proven"
  fi

  read -r cilium_desired cilium_ready cilium_updated <<<"${cilium_status}"
  cilium_desired="${cilium_desired:-0}"
  cilium_ready="${cilium_ready:-0}"
  cilium_updated="${cilium_updated:-0}"
  if [[ ! "${cilium_desired}" =~ ^[0-9]+$ || ! "${cilium_ready}" =~ ^[0-9]+$ || ! "${cilium_updated}" =~ ^[0-9]+$ ]]; then
    finish_unavailable "could not parse Cilium DaemonSet readiness in ${CILIUM_NAMESPACE}: '${cilium_status}'"
  fi
  if (( cilium_desired < 1 || cilium_ready < cilium_desired || cilium_updated < cilium_desired )); then
    finish_unavailable "Cilium DaemonSet is not fully ready in ${CILIUM_NAMESPACE}: desired=${cilium_desired} ready=${cilium_ready} updated=${cilium_updated}"
  fi

  cilium_config="$("${KUBECTL}" -n "${CILIUM_NAMESPACE}" get configmap cilium-config -o jsonpath='{.data.enable-policy} {.data.enable-k8s-networkpolicy}' 2>/dev/null || true)"
  if [[ -z "${cilium_config}" ]]; then
    finish_unavailable "expected cilium, but configmap ${CILIUM_NAMESPACE}/cilium-config is not readable; Cilium NetworkPolicy settings cannot be proven"
  fi
  read -r cilium_enable_policy cilium_enable_k8s_np <<<"${cilium_config}"
  if [[ "${cilium_enable_policy}" == "never" || "${cilium_enable_k8s_np}" == "false" ]]; then
    finish_unavailable "Cilium is live but Kubernetes NetworkPolicy enforcement appears disabled: enable-policy=${cilium_enable_policy:-unknown} enable-k8s-networkpolicy=${cilium_enable_k8s_np:-unknown}"
  fi
  cilium_ready_note=" cilium_daemonset=${cilium_ready}/${cilium_desired} cilium_enable_policy=${cilium_enable_policy:-unknown} cilium_k8s_networkpolicy=${cilium_enable_k8s_np:-unknown}"
fi

policy_count="$(grep -c '^' <<<"${policies}")"
echo "networkpolicy-preflight: PASS"
echo "networkpolicy-preflight: context=${context} namespace=${NAMESPACE} policies=${policy_count} detected_enforcers=${enforcers[*]} expected=${EXPECTED_ENFORCER}${cilium_ready_note}"
echo "networkpolicy-preflight: live cluster has applied NetworkPolicies and a recognized policy-capable CNI/enforcer."
