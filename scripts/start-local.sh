#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LORE_VERSION="${LORE_VERSION:-0.14.0}"
WEB_INTERNAL_PORT="${WEB_INTERNAL_PORT:-41340}"
PUBLIC_GATEWAY_PORT="${PUBLIC_GATEWAY_PORT:-3000}"
export LORE_VERSION

LOCAL_DIR="$ROOT/data/local"
RUN_DIR="$LOCAL_DIR/run"
LOG_DIR="$LOCAL_DIR/logs"
LORE_DIR="$LOCAL_DIR/lore"
CERT_DIR="$ROOT/data/dev-certs"
LORE_CERT_DIR="$LOCAL_DIR/certs"
mkdir -p \
  "$RUN_DIR" \
  "$LOG_DIR" \
  "$LORE_DIR" \
  "$CERT_DIR" \
  "$LORE_CERT_DIR" \
  "$LOCAL_DIR/config"

for tool in node curl openssl git tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing required command: $tool" >&2
    exit 1
  fi
done

if [ ! -f "$CERT_DIR/grpc.crt" ]; then
  sh infra/generate-certs.sh "$CERT_DIR"
fi
if [ ! -f "$LORE_CERT_DIR/lore.crt" ] ||
   [ ! -f "$LORE_CERT_DIR/lore.key" ]; then
  cp "$CERT_DIR/grpc.crt" "$LORE_CERT_DIR/lore.crt"
  cp "$CERT_DIR/grpc.key" "$LORE_CERT_DIR/lore.key"
fi
install_lore=0
for binary in lore loreserver; do
  binary_path="$ROOT/data/local/bin/$binary"
  if [ ! -x "$binary_path" ] ||
     ! "$binary_path" --version 2>/dev/null | grep -Fq "$LORE_VERSION"; then
    install_lore=1
  fi
done
if [ "$install_lore" -eq 1 ]; then
  sh scripts/install-lore.sh
fi

kill_tree() {
  parent="$1"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      taskkill //PID "$parent" //T //F >/dev/null 2>&1 || true
      return
      ;;
  esac
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$parent" 2>/dev/null || true
}

cleanup() {
  for name in gateway web api lore; do
    pid_file="$RUN_DIR/$name.pid"
    if [ -f "$pid_file" ]; then
      pid="$(cat "$pid_file")"
      kill_tree "$pid"
      rm -f "$pid_file"
    fi
  done
}
trap cleanup EXIT INT TERM

(
  cd "$ROOT/apps/server"
  APP_PUBLIC_URL=http://localhost:3000 \
  DATABASE_PATH="$LOCAL_DIR/portal.sqlite" \
  OIDC_KEY_DIR="$ROOT/data/keys" \
  GRPC_TLS_CERT_FILE="$CERT_DIR/grpc.crt" \
  GRPC_TLS_KEY_FILE="$CERT_DIR/grpc.key" \
  LORE_CLI_PATH="$ROOT/data/local/bin/lore" \
  LORE_PUBLIC_URL=lore://localhost:3000 \
  LORE_INTERNAL_URL=lore://localhost:41337 \
  LORE_RUNTIME_CONFIG_PATH="$LOCAL_DIR/config/local.toml" \
  LORE_STORAGE_PATH="$LORE_DIR" \
  LORE_QUIC_TLS_CERT_FILE="$LORE_CERT_DIR/lore.crt" \
  LORE_QUIC_TLS_KEY_FILE="$LORE_CERT_DIR/lore.key" \
  LORE_SUPERVISOR_PID_FILE="$RUN_DIR/lore-supervisor.pid" \
  LORE_SUPERVISOR_SOCKET="$RUN_DIR/lore-supervisor.sock" \
  exec node "$ROOT/apps/server/node_modules/tsx/dist/cli.mjs" src/index.ts
) >"$LOG_DIR/api.log" 2>&1 &
echo $! >"$RUN_DIR/api.pid"

for _ in $(seq 1 30); do
  curl -fsS http://localhost:4000/health_check >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://localhost:4000/health_check >/dev/null 2>&1 || {
  echo "API failed to start. See $LOG_DIR/api.log" >&2
  exit 1
}

(
  cd "$ROOT/apps/web"
  APP_PUBLIC_URL=http://localhost:3000 \
  API_INTERNAL_URL=http://localhost:4000 \
  LORE_VERSION="$LORE_VERSION" \
  PORT="$WEB_INTERNAL_PORT" \
  exec node "$ROOT/apps/web/node_modules/next/dist/bin/next" \
    dev --port "$WEB_INTERNAL_PORT"
) >"$LOG_DIR/web.log" 2>&1 &
echo $! >"$RUN_DIR/web.pid"

for _ in $(seq 1 30); do
  curl -fsS "http://localhost:$WEB_INTERNAL_PORT/login" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://localhost:$WEB_INTERNAL_PORT/login" >/dev/null 2>&1 || {
  echo "Web interface failed to start. See $LOG_DIR/web.log" >&2
  exit 1
}

PUBLIC_GATEWAY_HOST=0.0.0.0 \
PUBLIC_GATEWAY_PORT="$PUBLIC_GATEWAY_PORT" \
WEB_INTERNAL_URL="http://localhost:$WEB_INTERNAL_PORT" \
LORE_GRPC_INTERNAL_URL=localhost:41337 \
LORE_QUIC_INTERNAL_URL=localhost:41337 \
node "$ROOT/scripts/public-gateway.mjs" \
  >"$LOG_DIR/gateway.log" 2>&1 &
echo $! >"$RUN_DIR/gateway.pid"

for _ in $(seq 1 30); do
  curl -fsS "http://localhost:$PUBLIC_GATEWAY_PORT/health_check" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://localhost:$PUBLIC_GATEWAY_PORT/health_check" >/dev/null 2>&1 || {
  echo "Public gateway failed to start. See $LOG_DIR/gateway.log" >&2
  exit 1
}

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    SSL_CERT_FILE="$CERT_DIR/ca.crt" \
      "$ROOT/data/local/bin/loreserver.exe" \
      --config "$LOCAL_DIR/config" \
      >"$LOG_DIR/lore.log" 2>&1 &
    ;;
  *)
    SSL_CERT_FILE="$CERT_DIR/ca.crt" \
      node "$ROOT/scripts/supervise-lore.mjs" \
      "$ROOT/data/local/bin/loreserver" \
      "$LOCAL_DIR/config" \
      "$RUN_DIR/lore-supervisor.pid" \
      "$RUN_DIR/lore-supervisor.sock" \
      >"$LOG_DIR/lore.log" 2>&1 &
    ;;
esac
echo $! >"$RUN_DIR/lore.pid"

for _ in $(seq 1 30); do
  curl -fsS http://localhost:41339/health_check >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://localhost:41339/health_check >/dev/null 2>&1 || {
  echo "Lore Server failed to start. See $LOG_DIR/lore.log" >&2
  exit 1
}

cat <<EOF
Yeomai Lore is running:
  Web:  http://localhost:$PUBLIC_GATEWAY_PORT
  API:  http://localhost:4000
  Lore: lore://localhost:$PUBLIC_GATEWAY_PORT

Logs: $LOG_DIR
Press Ctrl-C to stop application processes.
EOF

wait
