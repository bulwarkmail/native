#!/usr/bin/env bash
# Boot a fresh simulator for one test leg and install the app.
#
#   scripts/e2e/boot-sim.sh <phone|tablet> <light|dark> <app path>
#
# Writes UDID and SIM_NAME to $GITHUB_ENV. Every simulator gets the keyboard
# set up for XCTest typing: a fresh one shows the slide-to-type tip over the
# keyboard the first time a field gets focus, and predictions, autocorrect and
# password AutoFill can swallow or rewrite typed text.
set -euo pipefail
DEVICE=$1
APPEARANCE=$2
APP=$3

case "$DEVICE" in
  phone) PATTERN='^iPhone' ;;
  tablet) PATTERN='^iPad Pro 11|^iPad Air 11|^iPad \(' ;;
  *) echo "unknown device $DEVICE" >&2; exit 1 ;;
esac

# The newest matching device type on the newest iOS runtime the image ships.
RUNTIME=$(xcrun simctl list runtimes available -j | jq -r '[.runtimes[] | select(.platform == "iOS")] | sort_by(.version | split(".") | map(tonumber)) | last | .identifier')
UDID=$(xcrun simctl list devices available -j | jq -r --arg rt "$RUNTIME" --arg re "$PATTERN" '
  [.devices[$rt][] | select(.name | test($re))] | last | .udid // empty')
if [ -z "$UDID" ]; then
  xcrun simctl list devices available
  echo "::error::No $DEVICE simulator on $RUNTIME"
  exit 1
fi
NAME=$(xcrun simctl list devices -j | jq -r --arg u "$UDID" '.devices[][] | select(.udid == $u) | .name')
echo "Using $NAME ($UDID) on $RUNTIME"

xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b

PREFS=com.apple.keyboard.preferences
xcrun simctl spawn "$UDID" defaults write $PREFS DidShowContinuousPathIntroduction -bool true
xcrun simctl spawn "$UDID" defaults write $PREFS KeyboardContinuousPathEnabled -bool false
xcrun simctl spawn "$UDID" defaults write $PREFS KeyboardPrediction -bool false
xcrun simctl spawn "$UDID" defaults write $PREFS KeyboardAutocorrection -bool false
xcrun simctl spawn "$UDID" defaults write $PREFS KeyboardAutocapitalization -bool false
xcrun simctl spawn "$UDID" defaults write $PREFS KeyboardShowPredictionBar -bool false
xcrun simctl spawn "$UDID" defaults write com.apple.WebUI AutoFillPasswords -bool false || true

xcrun simctl ui "$UDID" appearance "$APPEARANCE"
xcrun simctl install "$UDID" "$APP"

{
  echo "UDID=$UDID"
  echo "SIM_NAME=$NAME"
} >> "${GITHUB_ENV:-/dev/null}"
