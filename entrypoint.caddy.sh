#!/bin/sh
# HTTPS 变体 entrypoint — 与已审计镜像 ghcr.io/kanzuori197/deepseek-harness-nas 逐字一致
set -eu

: "${DSH_AUTH_USERNAME:?DSH_AUTH_USERNAME is required}"
: "${DSH_AUTH_PASSWORD:?DSH_AUTH_PASSWORD is required}"
: "${HTTPS_ACCESS_HOST:?HTTPS_ACCESS_HOST is required}"

if [ "${#DSH_AUTH_PASSWORD}" -lt 12 ]; then
  echo "DSH_AUTH_PASSWORD must contain at least 12 characters" >&2
  exit 1
fi

DSH_AUTH_PASSWORD_HASH="$(caddy hash-password --plaintext "$DSH_AUTH_PASSWORD")"
export DSH_AUTH_PASSWORD_HASH

dsh web &
dsh_pid=$!

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy_pid=$!

terminate() {
  kill "$dsh_pid" "$caddy_pid" 2>/dev/null || true
}

trap terminate INT TERM EXIT

while kill -0 "$dsh_pid" 2>/dev/null && kill -0 "$caddy_pid" 2>/dev/null; do
  sleep 2
done

if ! kill -0 "$dsh_pid" 2>/dev/null; then
  wait "$dsh_pid"
else
  wait "$caddy_pid"
fi
