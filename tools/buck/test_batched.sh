#!/usr/bin/env bash
# Run the hermetic (non-needs-postgres) rust_test targets under `buck2 test` in
# small batches — the default buck2 test runner aborts a whole invocation if any
# one target in it can't launch, so batching isolates failures and keeps the rest
# green. Usage: tools/buck/test_batched.sh [BATCH_SIZE]
set -uo pipefail
cd "$(dirname "$0")/../.."
BATCH="${1:-4}"
# bash 3.2 (macOS) has no mapfile; target names have no spaces so word-split is safe.
TARGETS=( $(buck2 uquery \
  "kind('rust_test', '//backend/...') - attrfilter('labels', 'needs-postgres', '//backend/...')" \
  2>/dev/null | sed 's#^root##') )
echo "hermetic rust_test targets: ${#TARGETS[@]} (batch size $BATCH)"
total_pass=0 total_fail=0 crashed=()
for ((i = 0; i < ${#TARGETS[@]}; i += BATCH)); do
  group=("${TARGETS[@]:i:BATCH}")
  out=$(buck2 test "${group[@]}" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g')
  line=$(grep -oE "Pass [0-9]+\. Fail [0-9]+" <<<"$out" | tail -1)
  if [[ -z "$line" ]]; then
    crashed+=("${group[*]}")
    echo "  CRASH/none: ${group[*]##*:}"
  else
    p=$(grep -oE "Pass [0-9]+" <<<"$line"); p=${p#Pass }
    f=$(grep -oE "Fail [0-9]+" <<<"$line"); f=${f#Fail }
    total_pass=$((total_pass + p)); total_fail=$((total_fail + f))
    [[ "$f" != 0 ]] && echo "  FAIL($f): ${group[*]##*:}"
  fi
done
echo "=================================================="
echo "TOTAL: Pass $total_pass  Fail $total_fail  CrashedBatches ${#crashed[@]}"
[[ ${#crashed[@]} -gt 0 ]] && printf 'crashed batch: %s\n' "${crashed[@]}"
exit 0
