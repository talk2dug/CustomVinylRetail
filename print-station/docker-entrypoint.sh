#!/usr/bin/env bash
set -euo pipefail

# If DISPLAY is not provided, start a virtual framebuffer so Electron has a screen.
if [ -z "${DISPLAY:-}" ]; then
  export DISPLAY=:99
  XVFB_ARGS=${XVFB_ARGS:-"-screen 0 1920x1080x24"}
  echo "DISPLAY not set; starting Xvfb on ${DISPLAY} (${XVFB_ARGS})"
  Xvfb "${DISPLAY}" ${XVFB_ARGS} &
  XVFB_PID=$!
  # Give Xvfb a moment to boot before launching Electron.
  sleep 2
  cleanup() {
    if ps -p "${XVFB_PID}" >/dev/null 2>&1; then
      kill "${XVFB_PID}"
    fi
  }
  trap cleanup EXIT
fi

if [ ! -d node_modules ] || [ ! -f node_modules/.modules-built ]; then
  echo "Installing dependencies..."
  npm install
  # Stamp a marker so we know install completed for named volumes.
  touch node_modules/.modules-built
fi

if [ "$#" -eq 0 ]; then
  set -- npm run dev
fi

exec "$@"
