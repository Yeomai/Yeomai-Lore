#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
IMAGE="${LORE_IMAGE:-yeomai-lore-web:1.1.7}"
CONTAINER="${LORE_CONTAINER_NAME:-yeomai-lore-web}"

for dir in site certs; do
  mkdir -p "$ROOT/docker-data/$dir"
done
mkdir -p "$ROOT/docker-data/site/lore"

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --stop-timeout 30 \
  -p 3000:3000/tcp \
  -p 3000:3000/udp \
  -v "$ROOT/docker-data/site:/data" \
  -v "$ROOT/docker-data/certs:/certs" \
  "$IMAGE"

for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" curl -fsS \
      http://127.0.0.1:41339/health_check >/dev/null 2>&1 &&
     docker exec "$CONTAINER" curl -fsS \
      http://127.0.0.1:3000/health_check >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker exec "$CONTAINER" curl -fsS \
    http://127.0.0.1:41339/health_check >/dev/null 2>&1 ||
   ! docker exec "$CONTAINER" curl -fsS \
    http://127.0.0.1:3000/health_check >/dev/null 2>&1; then
  docker logs "$CONTAINER" >&2
  exit 1
fi

echo "Yeomai Lore is running"
echo "Web:  http://localhost:3000"
echo "Lore: lore://localhost:3000"
echo "Configuration: $ROOT/docker-data/site/config"
