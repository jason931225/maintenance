#!/usr/bin/env bash
set -euo pipefail

: "${REPO:?REPO is required}"
: "${SHA:?SHA is required}"

timeout_seconds="${CI_GATE_TIMEOUT_SECONDS:-3600}"
poll_seconds="${CI_GATE_POLL_SECONDS:-30}"
max_polls="${CI_GATE_MAX_POLLS:-0}"
deadline=$((SECONDS + timeout_seconds))
polls=0

while (( SECONDS < deadline )); do
  runs="$(gh run list \
    --repo "$REPO" \
    --workflow ci.yml \
    --commit "$SHA" \
    --event push \
    --branch main \
    --limit 20 \
    --json status,conclusion,url,event,headBranch,createdAt,databaseId)"
  runs="$(jq '[.[]
    | select(.event == "push" and .headBranch == "main")]
    | sort_by(.createdAt, .databaseId)
    | reverse' <<<"$runs")"

  if [[ "$(jq 'length' <<<"$runs")" -gt 0 ]]; then
    status="$(jq -r '.[0].status' <<<"$runs")"
    conclusion="$(jq -r '.[0].conclusion // ""' <<<"$runs")"
    url="$(jq -r '.[0].url' <<<"$runs")"
    echo "Protected-main push CI for $SHA: ${status}/${conclusion} ${url}"
    if [[ "$status" == "completed" ]]; then
      [[ "$conclusion" == "success" ]] && exit 0
      echo "::error::Protected-main push CI did not pass for ${SHA}: ${conclusion} ${url}"
      exit 1
    fi
  else
    echo "No protected-main push CI run for $SHA yet."
  fi

  polls=$((polls + 1))
  if (( max_polls > 0 && polls >= max_polls )); then
    break
  fi
  sleep "$poll_seconds"
done

echo "::error::Timed out waiting for protected-main push CI to finish for ${SHA}"
exit 1
