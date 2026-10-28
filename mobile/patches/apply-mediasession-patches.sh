#!/bin/bash
# Pre-build verification for 7-Sonata mobile.
#
# IMPORTANT HISTORY (do not regress):
#   v1.6.0 (known-good, user-verified) used the ORIGINAL unpatched
#   @jofr/capacitor-media-session@4.0.0 plugin, an EMPTY MainActivity and a
#   bare AndroidManifest. The MediaSessionService / MediaButtonReceiver and
#   the FOREGROUND_SERVICE* / POST_NOTIFICATIONS / WAKE_LOCK permissions come
#   from the plugin's OWN library manifest via the Gradle manifest merger.
#   Our later "hardening" (native patches 1-5, JS playpause action +
#   visibilitychange/3s retries, manual <service> in the app manifest,
#   onKeyDown media-key interception, server.androidScheme=http) BROKE the
#   notification shade on real devices. All of it was reverted.
#
# This script now only GUARDS the known-good state:
#   1. the plugin must be the pristine npm original (no SonataMs markers),
#   2. the plugin's library manifest must still declare the service,
#   3. the app manifest must stay bare (no hand-added <service>).
set -e
cd "$(dirname "$0")/.."

P="node_modules/@jofr/capacitor-media-session"
PJ="$P/android/src/main/java/io/github/jofr/capacitor/mediasessionplugin"

if rg -q "SonataMs|registeredActions" "$PJ" 2>/dev/null; then
  echo "GUARD FAILED: plugin is patched! Restore the pristine npm package:" >&2
  echo "  rm -rf $P && bun install  (or copy files from the npm tarball)" >&2
  exit 1
else
  echo "Guard 1 OK: plugin is the pristine unpatched original."
fi

PM="$P/android/src/main/AndroidManifest.xml"
if rg -q "MediaSessionService" "$PM" && rg -q "MediaButtonReceiver" "$PM"; then
  echo "Guard 2 OK: plugin library manifest declares service + receiver."
else
  echo "GUARD FAILED: plugin library manifest lost service/receiver!" >&2
  exit 1
fi

AM="android/app/src/main/AndroidManifest.xml"
if rg -q "MediaSessionService" "$AM"; then
  echo "GUARD FAILED: app manifest has a hand-added <service> — revert it to" >&2
  echo "  the bare 9965e95 state; the merger adds it from the plugin AAR." >&2
  exit 1
else
  echo "Guard 3 OK: app manifest is bare (service comes from the AAR merger)."
fi

echo "All guards passed — known-good v1.6.0 configuration."
