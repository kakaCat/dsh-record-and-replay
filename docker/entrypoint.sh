#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-cua}"
SCREEN_WIDTH="${CUA_SCREEN_WIDTH:-1280}"
SCREEN_HEIGHT="${CUA_SCREEN_HEIGHT:-720}"
READY_FILE=/tmp/dsh-record-replay-ready

if ! [[ "$SCREEN_WIDTH" =~ ^[1-9][0-9]*$ && "$SCREEN_HEIGHT" =~ ^[1-9][0-9]*$ ]]; then
    echo "CUA_SCREEN_WIDTH and CUA_SCREEN_HEIGHT must be positive integers" >&2
    exit 64
fi

# All mutable runtime paths live on the tmpfs or writable home volume.
mkdir -p /tmp/.X11-unix "$XDG_RUNTIME_DIR" "$CUA_DRIVER_RS_HOME"
chmod 0700 "$XDG_RUNTIME_DIR"
rm -f "$READY_FILE"

xvfb_pid=""
cleanup() {
    if [[ -n "$xvfb_pid" ]]; then
        kill "$xvfb_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" \
    -nolisten tcp -ac -noreset &
xvfb_pid=$!

# Do not expose readiness until X11 actually accepts connections.
display_ready=false
for ((attempt = 0; attempt < 100; attempt++)); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
        display_ready=true
        break
    fi
    if ! kill -0 "$xvfb_pid" 2>/dev/null; then
        echo "Xvfb exited before $DISPLAY became ready" >&2
        exit 1
    fi
    sleep 0.1
done
if [[ "$display_ready" != true ]]; then
    echo "Timed out waiting for X11 on $DISPLAY" >&2
    exit 1
fi

# A session bus needs no writable /run; AT-SPI can activate on demand.
dbus_env="$(dbus-launch --sh-syntax --exit-with-session)"
eval "$dbus_env"
unset dbus_env
openbox &

touch "$READY_FILE"

# PID 1 becomes the command, so docker stop delivers SIGTERM directly.
exec "$@"
