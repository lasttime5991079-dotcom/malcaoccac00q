#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

for program in node obs pulseaudio pactl xvfb-run xauth setsid; do
  command -v "$program" >/dev/null || { echo "Missing runner dependency: $program" >&2; exit 1; }
done

if [[ -z "${CHROME_PATH:-}" ]]; then
  CHROME_PATH=$(command -v google-chrome || command -v google-chrome-stable || true)
fi
if [[ ! -x "$CHROME_PATH" ]]; then
  echo 'Install Google Chrome or configure CHROME_PATH with its executable path.' >&2
  exit 1
fi
export CHROME_PATH

runtime_dir=$(mktemp -d /tmp/obs-stream.XXXXXXXX)
pulse_pid=''
stream_pid=''
cleanup() {
  if [[ -n "$stream_pid" ]]; then
    if [[ -f "$runtime_dir/stream.pid" ]]; then
      kill -TERM "$(<"$runtime_dir/stream.pid")" 2>/dev/null || true
      for attempt in {1..150}; do
        kill -0 "$stream_pid" 2>/dev/null || break
        sleep 0.2
      done
    fi
    kill -TERM -- "-$stream_pid" 2>/dev/null || true
    wait "$stream_pid" 2>/dev/null || true
  fi
  if [[ -n "$pulse_pid" ]]; then
    kill -TERM "$pulse_pid" 2>/dev/null || true
    wait "$pulse_pid" 2>/dev/null || true
  fi
  rm -rf -- "$runtime_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(umask 077; printf '%s\0' "${STREAM_INGEST_URL:-}" "${STREAM_KEY:-}" > "$runtime_dir/stream.env")
unset STREAM_INGEST_URL STREAM_KEY

export PULSE_RUNTIME_PATH="$runtime_dir"
export PULSE_STATE_PATH="$runtime_dir"
export PULSE_SERVER="unix:$runtime_dir/native"
export PULSE_SINK=obs_stream
export PULSE_SOURCE=obs_stream.monitor
export PULSE_COOKIE="$runtime_dir/cookie"
head -c 256 /dev/urandom > "$PULSE_COOKIE"
pulseaudio -n --daemonize=no \
  --exit-idle-time=-1 --use-pid-file=no --log-level=error --log-target="file:$runtime_dir/pulse.log" \
  --load="module-native-protocol-unix socket=$runtime_dir/native auth-cookie=$PULSE_COOKIE" \
  --load="module-null-sink sink_name=$PULSE_SINK rate=48000 channels=2" &
pulse_pid=$!
for attempt in {1..30}; do
  if pactl info >/dev/null 2>&1; then break; fi
  if ! kill -0 "$pulse_pid" 2>/dev/null; then break; fi
  sleep 0.2
done
if ! pactl info >/dev/null 2>&1; then
  echo 'Could not start the private PulseAudio server.' >&2
  if [[ -f "$runtime_dir/pulse.log" ]]; then cat "$runtime_dir/pulse.log" >&2; fi
  exit 1
fi

setsid xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24 -nolisten tcp' \
  bash -e -c '
    {
      IFS= read -r -d "" STREAM_INGEST_URL
      IFS= read -r -d "" STREAM_KEY
    } < "$1/stream.env"
    rm -f -- "$1/stream.env"
    export STREAM_INGEST_URL STREAM_KEY
    echo "$$" > "$1/stream.pid"
    exec node stream.js
  ' bash "$runtime_dir" &
stream_pid=$!
wait "$stream_pid"
