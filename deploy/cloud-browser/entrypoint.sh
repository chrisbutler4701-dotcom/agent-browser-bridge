#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:99}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"

sandbox_flag=""
if [ "${FBB_CLOUD_NO_SANDBOX:-0}" = "1" ]; then
  if [ "${FBB_ENV:-production}" != "development" ]; then
    echo "FBB_CLOUD_NO_SANDBOX=1 is allowed only when FBB_ENV=development; refusing to start." >&2
    exit 1
  fi
  sandbox_flag="--no-sandbox"
  echo "WARNING: CHROMIUM SANDBOX DISABLED FOR DEVELOPMENT." >&2
fi

if [ "${FBB_ENTRYPOINT_DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' "$sandbox_flag"
  exit 0
fi

Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp &
xvfb_pid=$!

# A previous container leaves Chromium's singleton lock in the persistent profile,
# keyed to its old hostname; clear it so a restart reuses the paired profile.
# Safe because each cloud browser owns its own /profile volume.
rm -f /profile/SingletonLock /profile/SingletonSocket /profile/SingletonCookie

chromium_bin="${CHROMIUM_BIN:-$(node -e "import('playwright-core').then(({ chromium }) => process.stdout.write(chromium.executablePath()))")}"
"$chromium_bin" \
  --user-data-dir=/profile \
  --disable-extensions-except=/opt/fbb-extension \
  --load-extension=/opt/fbb-extension \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --no-first-run \
  $sandbox_flag \
  --no-default-browser-check \
  about:blank &
chromium_pid=$!

cleanup() {
  kill "$chromium_pid" "$xvfb_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

node /opt/fbb-cloud/pair.mjs
wait "$chromium_pid"
