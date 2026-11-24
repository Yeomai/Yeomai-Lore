#!/bin/sh
set -eu

mkdir -p /data/config /data/keys /data/imports /data/run /data/lore/store /certs
if [ ! -f /data/config/.env ]; then
  cp /usr/local/share/lore/runtime.env /data/config/.env
fi

# Version fields belong to the image and must follow it across upgrades. The
# helper changes only these fields and preserves the other persisted settings.
/usr/local/bin/sync-lore-version \
  /data/config/.env \
  /usr/local/share/lore/runtime.env \
  >/dev/null

if [ ! -f /data/config/local.toml ]; then
  cp /usr/local/share/lore/config/local.toml /data/config/local.toml
fi

set -a
. /data/config/.env
set +a

export NODE_ENV="${NODE_ENV:-production}"
export PORTAL_VERSION="${PORTAL_VERSION:?The image has no PORTAL_VERSION}"
export LORE_VERSION="${LORE_VERSION:?The image has no LORE_VERSION}"
export WEB_INTERNAL_PORT="${WEB_INTERNAL_PORT:-41340}"
export PUBLIC_GATEWAY_PORT="${PUBLIC_GATEWAY_PORT:-3000}"
export HOST="${HOST:-0.0.0.0}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
export PORT="${PORT:-4000}"
export DATABASE_PATH="${DATABASE_PATH:-/data/portal.sqlite}"
export APP_PUBLIC_URL="${APP_PUBLIC_URL:-http://localhost:3000}"
export API_INTERNAL_URL="${API_INTERNAL_URL:-http://127.0.0.1:4000}"
export LORE_GRPC_URL="${LORE_GRPC_URL:-localhost:41337}"
export LORE_HTTP_URL="${LORE_HTTP_URL:-http://localhost:41339}"
export LORE_PUBLIC_URL="${LORE_PUBLIC_URL:-lore://localhost:3000}"
export LORE_INTERNAL_URL="${LORE_INTERNAL_URL:-lore://localhost:41337}"
export LORE_CLI_PATH="${LORE_CLI_PATH:-/usr/local/bin/lore}"
export LORE_IMPORT_WORK_DIR="${LORE_IMPORT_WORK_DIR:-/data/imports}"
export GIT_PATH="${GIT_PATH:-git}"
export OIDC_KEY_DIR="${OIDC_KEY_DIR:-/data/keys}"
export LORE_RUNTIME_CONFIG_PATH="${LORE_RUNTIME_CONFIG_PATH:-/data/config/local.toml}"
export LORE_STORAGE_PATH="${LORE_STORAGE_PATH:-/data/lore/store}"
export LORE_QUIC_TLS_CERT_FILE="${LORE_QUIC_TLS_CERT_FILE:-/certs/lore.crt}"
export LORE_QUIC_TLS_KEY_FILE="${LORE_QUIC_TLS_KEY_FILE:-/certs/lore.key}"
export LORE_SUPERVISOR_PID_FILE="${LORE_SUPERVISOR_PID_FILE:-/data/run/lore-supervisor.pid}"
export LORE_SUPERVISOR_SOCKET="${LORE_SUPERVISOR_SOCKET:-/data/run/lore-supervisor.sock}"
export INTERNAL_GATEWAY_SECRET_FILE="${INTERNAL_GATEWAY_SECRET_FILE:-/data/run/gateway-internal-secret}"
export GRPC_HOST="${GRPC_HOST:-0.0.0.0}"
export GRPC_PORT="${GRPC_PORT:-50051}"
export GRPC_TLS_CERT_FILE="${GRPC_TLS_CERT_FILE:-/certs/grpc.crt}"
export GRPC_TLS_KEY_FILE="${GRPC_TLS_KEY_FILE:-/certs/grpc.key}"
export SSL_CERT_FILE="${SSL_CERT_FILE:-/certs/ca.crt}"

printf '\n============================================================\n'
printf ' Yeomai Lore %s\n' "$PORTAL_VERSION"
printf ' Bundled Epic Games Lore %s\n' "$LORE_VERSION"
printf '============================================================\n\n'
if [ -f /usr/local/share/yeomai-lore/NOTICE ]; then
  cat /usr/local/share/yeomai-lore/NOTICE
  printf '\n'
fi

if [ ! -f /certs/ca.crt ] ||
   [ ! -f /certs/ca.key ] ||
   [ ! -f /certs/grpc.crt ] ||
   [ ! -f /certs/grpc.key ]; then
  /usr/local/bin/generate-certs.sh /certs
fi
if [ ! -f /certs/lore.crt ] || [ ! -f /certs/lore.key ]; then
  cp /certs/grpc.crt /certs/lore.crt
  cp /certs/grpc.key /certs/lore.key
fi

exec node /usr/local/bin/run-app.mjs
