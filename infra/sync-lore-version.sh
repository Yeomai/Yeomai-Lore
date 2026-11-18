#!/bin/sh
set -eu

env_file="${1:?usage: sync-lore-version.sh <env-file> [image-runtime-env]}"
image_env="${2:-/usr/local/share/lore/runtime.env}"

image_lore_version="$(
  sed -n 's/^LORE_VERSION=//p' "$image_env" |
    head -n 1
)"
if [ -z "$image_lore_version" ]; then
  echo "The image runtime configuration has no LORE_VERSION" >&2
  exit 1
fi

image_portal_version="$(
  sed -n 's/^PORTAL_VERSION=//p' "$image_env" |
    head -n 1
)"
if [ -z "$image_portal_version" ]; then
  echo "The image runtime configuration has no PORTAL_VERSION" >&2
  exit 1
fi

sync_value() {
  key="$1"
  value="$2"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s/^${key}=.*/${key}=${value}/" "$env_file"
  else
    printf '\n%s=%s\n' "$key" "$value" >>"$env_file"
  fi
}

sync_value LORE_VERSION "$image_lore_version"
sync_value PORTAL_VERSION "$image_portal_version"

image_access_token_ttl="$(
  sed -n 's/^ACCESS_TOKEN_TTL_SECONDS=//p' "$image_env" |
    head -n 1
)"
if [ -n "$image_access_token_ttl" ]; then
  sync_value ACCESS_TOKEN_TTL_SECONDS "$image_access_token_ttl"
fi

printf '%s\n' "$image_lore_version"
