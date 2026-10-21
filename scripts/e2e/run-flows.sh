#!/usr/bin/env bash
# Run one suite of Maestro flows against the booted simulator ($UDID).
#
#   scripts/e2e/run-flows.sh <suite dir under .maestro> [flow names, comma separated]
#
# Needs in the environment: UDID, OUT (output folder), and for the flows the
# E2E_* values (see .github/workflows/e2e-ios.yml). Output: $OUT/report.xml,
# $OUT/screenshots, $OUT/run.mp4, $OUT/app.log.
#
# Secrets: Maestro's debug output and the JSON under ~/.maestro/tests hold
# every typed text, passwords included, and artifacts of this public repo are
# public. Only the warm-up (which types a made-up address) prints a debug
# log; afterwards only PNGs are copied, and every text file in $OUT is
# scrubbed of the secret values before upload.
set -uo pipefail
SUITE=$1
ONLY=${2:-}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$OUT/screenshots"

maestro --version

xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$OUT/run.mp4" &
RECORDER=$!

# Warm-up: the XCTest driver takes minutes to start on a cold runner.
touch "$RUNNER_TEMP/flows-started"
(cd "$OUT/screenshots" && maestro --device "$UDID" test \
  --debug-output "$RUNNER_TEMP/maestro-warmup" "$ROOT/.maestro/launch.yaml")
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo "::group::Maestro warm-up log"
  find "$RUNNER_TEMP/maestro-warmup" -name 'maestro.log' -exec tail -n 300 {} \;
  echo "::endgroup::"
  maestro --device "$UDID" hierarchy > "$OUT/hierarchy-warmup.json" 2>/dev/null || true
fi

if [ $STATUS -eq 0 ]; then
  ARGS=(
    -e "SERVER=$E2E_SERVER"
    -e "PASSWORD=$E2E_PASSWORD"
    -e "ACCOUNT=${E2E_ACCOUNT:-}"
    -e "ACCOUNT2=${E2E_ACCOUNT2:-}"
    -e "TOTP_ACCOUNT=${E2E_TOTP_ACCOUNT:-}"
    -e "WEBMAIL=${E2E_WEBMAIL:-}"
    -e "HELPER=http://127.0.0.1:${HELPER_PORT:-8787}"
    -e "ORIENTATION=${ORIENTATION:-portrait}"
    -e "DEVICE=${DEVICE:-phone}"
    -e "APPEARANCE=${APPEARANCE:-light}"
  )
  TARGETS=()
  if [ -n "$ONLY" ]; then
    IFS=',' read -ra NAMES <<< "$ONLY"
    for n in "${NAMES[@]}"; do
      f="$ROOT/.maestro/$SUITE/${n%.yaml}.yaml"
      [ -f "$f" ] && TARGETS+=("$f") || echo "::warning::no flow $SUITE/$n"
    done
  else
    TARGETS=("$ROOT/.maestro/$SUITE")
  fi
  if [ ${#TARGETS[@]} -gt 0 ]; then
    (cd "$OUT/screenshots" && maestro --device "$UDID" test \
      --format junit --output "$OUT/report.xml" \
      "${ARGS[@]}" "${TARGETS[@]}")
    STATUS=$?
  fi
fi

kill -INT "$RECORDER" 2>/dev/null || true
wait "$RECORDER" 2>/dev/null || true

# Screenshots of failed steps land under ~/.maestro/tests. Images only, plus
# a summary of the steps without their arguments (see failed-steps.mjs).
find "$HOME/.maestro/tests" -name '*.png' -exec cp {} "$OUT/screenshots/" \; 2>/dev/null || true
node "$ROOT/scripts/e2e/failed-steps.mjs" "$HOME/.maestro/tests" > "$OUT/steps.txt" 2>&1 || true

xcrun simctl spawn "$UDID" log show --last 60m --style compact \
  --predicate 'process == "BulwarkMobile"' > "$OUT/app.log" 2>&1 || true

# Scrub secrets from every text file that gets uploaded.
for f in $(find "$OUT" -type f \( -name '*.xml' -o -name '*.log' -o -name '*.json' -o -name '*.txt' \)); do
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    let s = fs.readFileSync(f, "utf8");
    for (const k of ["E2E_PASSWORD", "E2E_USERB_PASSWORD", "E2E_TOTP_SECRET"]) {
      const v = process.env[k];
      if (v && v.length >= 6) s = s.split(v).join("***");
    }
    fs.writeFileSync(f, s);
  ' "$f"
done

ls -la "$OUT/screenshots" | tail -n +2 | wc -l | xargs echo "screenshots:"
exit $STATUS
