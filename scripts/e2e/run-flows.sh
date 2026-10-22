#!/usr/bin/env bash
# Run one suite of Maestro flows against the booted simulator ($UDID).
#
#   scripts/e2e/run-flows.sh <suite dir under .maestro> [flow names, comma separated]
#
# Needs in the environment: UDID, OUT (output folder), and for the flows the
# E2E_* values (see .github/workflows/e2e-ios.yml). Output: $OUT/report.xml,
# $OUT/screenshots, $OUT/run.mp4, $OUT/app.log, $OUT/steps.txt.
#
# Each flow runs in its own Maestro process with a time cap: when the XCTest
# driver dies (it does, now and then), only that flow fails and the next one
# starts a fresh driver.
#
# Secrets: Maestro's debug output holds every typed text, passwords included,
# and artifacts of this public repo are public. Only the warm-up (which types
# a made-up address) prints a debug log; the debug output of the real flows
# stays on the runner, and only PNGs and an argument-free summary of the
# steps (failed-steps.mjs) are copied. Every text file in $OUT is scrubbed of
# the secret values before upload.
set -uo pipefail
SUITE=$1
ONLY=${2:-}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
FLOW_TIMEOUT=${FLOW_TIMEOUT:-900}
mkdir -p "$OUT/screenshots" "$OUT/junit"
DEBUG_DIR="$RUNNER_TEMP/maestro-debug"
mkdir -p "$DEBUG_DIR"

# perl's alarm stands in for coreutils timeout, which macOS lacks.
capped() { perl -e 'alarm shift; exec @ARGV' "$FLOW_TIMEOUT" "$@"; }

maestro --version

xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$OUT/run.mp4" &
RECORDER=$!

# Warm-up: the XCTest driver takes minutes to start on a cold runner.
WARMUP_START=$(date +%s)
(cd "$OUT/screenshots" && capped maestro --device "$UDID" test \
  --debug-output "$RUNNER_TEMP/maestro-warmup" "$ROOT/.maestro/launch.yaml")
STATUS=$?
echo "warm-up took $(( $(date +%s) - WARMUP_START )) s (status $STATUS)"
if [ $STATUS -ne 0 ]; then
  echo "::group::Maestro warm-up log"
  find "$RUNNER_TEMP/maestro-warmup" -name 'maestro.log' -exec tail -n 300 {} \;
  echo "::endgroup::"
fi

if [ $STATUS -eq 0 ]; then
  ARGS=(
    -e "SERVER=$E2E_SERVER"
    -e "PASSWORD=$E2E_PASSWORD"
    -e "ACCOUNT=${E2E_ACCOUNT:-}"
    -e "ACCOUNT2=${E2E_ACCOUNT2:-}"
    -e "TOTP_ACCOUNT=${E2E_TOTP_ACCOUNT:-}"
    -e "WEBMAIL=${E2E_WEBMAIL:-}"
    -e "WEBMAIL_BETA=${E2E_WEBMAIL_BETA:-https://bulwark-beta.internal.bulwarkmail.org}"
    -e "HELPER=http://127.0.0.1:${HELPER_PORT:-8787}"
    -e "ORIENTATION=${ORIENTATION:-portrait}"
    -e "DEVICE=${DEVICE:-phone}"
    -e "APPEARANCE=${APPEARANCE:-light}"
  )
  FLOWS=()
  if [ -n "$ONLY" ]; then
    IFS=',' read -ra NAMES <<< "$ONLY"
    for n in "${NAMES[@]}"; do
      f="$ROOT/.maestro/$SUITE/${n%.yaml}.yaml"
      if [ -f "$f" ]; then FLOWS+=("$f"); else echo "::warning::no flow $SUITE/$n"; fi
    done
  else
    for f in "$ROOT/.maestro/$SUITE"/*.yaml; do FLOWS+=("$f"); done
  fi

  FAILED=()
  for f in "${FLOWS[@]}"; do
    name=$(basename "$f" .yaml)
    started=$(date +%s)
    echo "::group::$name"
    (cd "$OUT/screenshots" && capped maestro --device "$UDID" test \
      --format junit --output "$OUT/junit/$name.xml" \
      --debug-output "$DEBUG_DIR/$name" \
      "${ARGS[@]}" "$f")
    rc=$?
    echo "::endgroup::"
    echo "$name: exit $rc after $(( $(date +%s) - started )) s"
    if [ $rc -ne 0 ]; then
      FAILED+=("$name")
      # What the screen showed when it failed.
      xcrun simctl io "$UDID" screenshot "$OUT/screenshots/FAILED-$name.png" >/dev/null 2>&1 || true
    fi
  done
  if [ ${#FAILED[@]} -gt 0 ]; then
    echo "::error::Failed flows: ${FAILED[*]}"
    STATUS=1
  fi

  node -e '
    const fs = require("fs"), path = require("path");
    const dir = process.argv[1];
    const cases = fs.readdirSync(dir).filter((f) => f.endsWith(".xml")).sort()
      .map((f) => (fs.readFileSync(path.join(dir, f), "utf8").match(/<testcase[\s\S]*?<\/testcase>/g) || []).join("\n"));
    fs.writeFileSync(process.argv[2], `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n<testsuite name="${process.argv[3]}">\n${cases.join("\n")}\n</testsuite>\n</testsuites>\n`);
  ' "$OUT/junit" "$OUT/report.xml" "$SUITE" || true
fi

kill -INT "$RECORDER" 2>/dev/null || true
wait "$RECORDER" 2>/dev/null || true

# Images of failed steps, plus a summary of the steps without arguments.
find "$DEBUG_DIR" "$HOME/.maestro/tests" -name '*.png' -exec cp {} "$OUT/screenshots/" \; 2>/dev/null || true
node "$ROOT/scripts/e2e/failed-steps.mjs" "$DEBUG_DIR" > "$OUT/steps.txt" 2>&1 || true
find "$DEBUG_DIR" -type f | sed "s|$DEBUG_DIR/||" > "$OUT/debug-files.txt" 2>/dev/null || true

# --info: console.log of the JS lands at info level.
xcrun simctl spawn "$UDID" log show --last 90m --style compact --info \
  --predicate 'process == "BulwarkMobile" AND (subsystem == "com.facebook.react.log" OR messageType >= 16)' \
  > "$OUT/app.log" 2>&1 || true

# Push: what iOS did with the notification (the extension's own log, and
# SpringBoard / usernotificationsd / apsd lines naming the app), plus the
# notification settings the simulator stored for it.
if [ "$SUITE" = push ]; then
  xcrun simctl spawn "$UDID" log show --last 90m --style compact --info --predicate \
    'process == "NotificationService" OR ((process == "SpringBoard" OR process CONTAINS "usernotification" OR process == "apsd") AND eventMessage CONTAINS[c] "bulwarkmail")' \
    > "$OUT/push.log" 2>&1 || true
  SIMDATA="$HOME/Library/Developer/CoreSimulator/Devices/$UDID/data"
  {
    find "$SIMDATA/Library" \( -path '*BulletinBoard*' -o -path '*UserNotifications*' \) -maxdepth 4 2>/dev/null | head -50
    for f in $(find "$SIMDATA/Library" \( -path '*BulletinBoard*' -o -path '*UserNotifications*' \) -name '*.plist' 2>/dev/null | head -20); do
      echo "== $f"
      plutil -p "$f" 2>/dev/null | grep -i -A12 bulwarkmail | head -60
    done
    echo "== app extension in the bundle"
    ls "$(xcrun simctl get_app_container "$UDID" org.bulwarkmail.mobile app 2>/dev/null)/PlugIns" 2>&1
  } > "$OUT/push-settings.txt" 2>&1 || true
fi

# Scrub secrets from every text file that gets uploaded.
find "$OUT" -type f \( -name '*.xml' -o -name '*.log' -o -name '*.json' -o -name '*.txt' \) -print0 |
  while IFS= read -r -d '' f; do
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

echo "screenshots: $(ls "$OUT/screenshots" | wc -l)"
exit $STATUS
