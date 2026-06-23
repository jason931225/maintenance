#!/usr/bin/env bash
# Manual deploy helper: take a built commit all the way to a verified prod rollout.
#
#   scripts/deploy.sh [<git-sha>]
#
# Given a git sha (default: HEAD), this:
#   1. Finds + watches that sha's "Image Release" run until it completes.
#   2. Reads both freshly built @sha256 digests (mnt-app, mnt-web) from the run's
#      digest artifacts (the same artifacts the auto-bump job consumes).
#   3. Bumps deploy/apps/maintenance/overlays/prod/kustomization.yaml via
#      scripts/bump-prod-digests.sh and commits the change to the current branch
#      (skipped if CI already auto-committed the same digests — idempotent).
#   4. Triggers an Argo sync and waits for the mnt-app/mnt-web Rollouts to go
#      Healthy (the blue/green canary still gates a bad release).
#   5. Verifies the public endpoints return HTTP 200.
#
# Idempotent: safe to re-run. Each step echoes what it is doing and skips work
# that is already done. Requires: gh (authenticated), git. Argo + rollout
# verification additionally need kubectl with the cluster's kubeconfig and the
# argo-rollouts kubectl plugin; those steps self-skip with a clear note when the
# tools or cluster are unreachable (so the digest bump still completes locally).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

SHA="${1:-$(git rev-parse HEAD)}"
SHORT_SHA="${SHA:0:7}"
WORKFLOW="image-release.yml"
APP_NAME="maintenance"             # ArgoCD Application name
NAMESPACE="maintenance"            # cluster namespace for the rollouts
ROLLOUTS=(mnt-app mnt-web)
ENDPOINTS=(https://console.knllogistic.com https://knllogistic.com)
ARGO_NS="argocd"

log() { echo "deploy: $*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

require() {
  if ! have "$1"; then
    echo "deploy: required tool '$1' not found on PATH." >&2
    exit 1
  fi
}

require gh
require git

# ---------------------------------------------------------------------------
# 1. Find + watch the Image Release run for this sha.
# ---------------------------------------------------------------------------
log "[1/5] locating the '${WORKFLOW}' run for ${SHORT_SHA}"
RUN_ID=""
for _ in $(seq 1 30); do
  RUN_ID="$(gh run list --workflow "${WORKFLOW}" --commit "${SHA}" \
    --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  if [[ -n "${RUN_ID}" && "${RUN_ID}" != "null" ]]; then
    break
  fi
  log "  no run yet for ${SHORT_SHA}; waiting for it to register..."
  sleep 10
done

if [[ -z "${RUN_ID}" || "${RUN_ID}" == "null" ]]; then
  echo "deploy: no '${WORKFLOW}' run found for ${SHA}. Push the commit and let CI build it first." >&2
  exit 1
fi

log "  found run ${RUN_ID}; watching until it completes"
# `gh run watch --exit-status` returns non-zero if the run failed.
if ! gh run watch "${RUN_ID}" --exit-status >/dev/null 2>&1; then
  echo "deploy: image-release run ${RUN_ID} did not succeed; aborting (nothing vulnerable is deployed)." >&2
  echo "deploy: inspect it with: gh run view ${RUN_ID} --log-failed" >&2
  exit 1
fi
log "  run ${RUN_ID} succeeded"

# ---------------------------------------------------------------------------
# 2. Read both digests from the run's digest artifacts.
# ---------------------------------------------------------------------------
log "[2/5] reading built digests from run ${RUN_ID} artifacts"
ART_DIR="$(mktemp -d)"
trap 'rm -rf "${ART_DIR}"' EXIT

gh run download "${RUN_ID}" --name digest-mnt-app --dir "${ART_DIR}/app"
gh run download "${RUN_ID}" --name digest-mnt-web --dir "${ART_DIR}/web"

APP_DIGEST="$(cat "${ART_DIR}/app/digest-mnt-app.txt")"
WEB_DIGEST="$(cat "${ART_DIR}/web/digest-mnt-web.txt")"
log "  mnt-app digest: ${APP_DIGEST}"
log "  mnt-web digest: ${WEB_DIGEST}"

# ---------------------------------------------------------------------------
# 3. Bump the overlay + commit (idempotent: a no-op if already current).
# ---------------------------------------------------------------------------
OVERLAY="deploy/apps/maintenance/overlays/prod/kustomization.yaml"
log "[3/5] bumping ${OVERLAY}"
bash "${REPO_ROOT}/scripts/bump-prod-digests.sh" "${APP_DIGEST}" "${WEB_DIGEST}"

if git diff --quiet -- "${OVERLAY}"; then
  log "  digests already current (likely CI auto-bumped); nothing to commit"
else
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  log "  committing the bump to ${BRANCH}"
  git add "${OVERLAY}"
  git commit -m "deploy(prod): auto-bump mnt-app/mnt-web @${SHORT_SHA}"
  git push origin "HEAD:${BRANCH}"
fi

# ---------------------------------------------------------------------------
# 4. Nudge Argo to pick up the committed digests + wait for the rollouts.
#    The Application already has syncPolicy.automated, so a hard refresh just
#    shortens the reconcile latency; the Argo Rollouts blue/green canary gates a
#    bad release regardless of how the sync was triggered.
# ---------------------------------------------------------------------------
log "[4/5] refreshing Argo + waiting for rollouts to be Healthy"
if ! have kubectl || ! kubectl version >/dev/null 2>&1; then
  log "  kubectl/cluster unreachable; skipping the in-cluster refresh + rollout wait."
  log "  Argo automated sync will reconcile the committed digests on its own; re-run"
  log "  this script from a host with cluster access to gate on rollout health."
else
  log "  requesting an Argo hard refresh on Application/${APP_NAME}"
  kubectl -n "${ARGO_NS}" annotate "application/${APP_NAME}" \
    "argocd.argoproj.io/refresh=hard" --overwrite >/dev/null

  for rollout in "${ROLLOUTS[@]}"; do
    log "  waiting for rollout ${rollout} to be Healthy"
    kubectl argo rollouts status "${rollout}" -n "${NAMESPACE}" --timeout 600s \
      || { echo "deploy: rollout ${rollout} did not reach Healthy in time." >&2; exit 1; }
    log "  rollout ${rollout} is Healthy"
  done
fi

# ---------------------------------------------------------------------------
# 5. Verify the public endpoints return HTTP 200.
# ---------------------------------------------------------------------------
log "[5/5] verifying public endpoints return HTTP 200"
for url in "${ENDPOINTS[@]}"; do
  code=""
  for _ in $(seq 1 12); do
    code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "${url}" 2>/dev/null || true)"
    if [[ "${code}" == "200" ]]; then
      break
    fi
    log "  ${url} -> ${code:-no-response}; retrying..."
    sleep 5
  done
  if [[ "${code}" != "200" ]]; then
    echo "deploy: ${url} did not return 200 (last: ${code:-no-response})." >&2
    exit 1
  fi
  log "  ${url} -> 200"
done

log "done: ${SHORT_SHA} deployed and verified (mnt-app=${APP_DIGEST}, mnt-web=${WEB_DIGEST})"
