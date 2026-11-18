#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
VERSION="${LORE_VERSION:-0.14.0}"
INSTALL_DIR="${LORE_INSTALL_DIR:-$ROOT/data/local/bin}"
REPO="${LORE_REPO:-EpicGames/lore}"
BINARIES="${LORE_INSTALL_BINARIES:-lore loreserver}"

case "$(uname -s)" in
  Darwin) os=apple-darwin ;;
  Linux) os=unknown-linux-gnu ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch=aarch64 ;;
  x86_64|amd64) arch=x86_64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

triple="$arch-$os"
mkdir -p "$INSTALL_DIR"
work="$(mktemp -d)"
release_json="$work/release.json"
trap 'rm -rf "$work"' EXIT INT TERM

curl -fsSL \
  --retry 5 \
  --retry-delay 2 \
  --retry-all-errors \
  --connect-timeout 15 \
  "https://api.github.com/repos/$REPO/releases/tags/v$VERSION" \
  -o "$release_json"

asset_url() {
  node -e '
    const fs = require("fs");
    const [file, binary, triple] = process.argv.slice(1);
    const release = JSON.parse(fs.readFileSync(file, "utf8"));
    const pattern = new RegExp(
      "^" + binary + "-v?[0-9][^\\\"]*-" + triple + "\\.tar\\.gz$"
    );
    const asset = release.assets.find((item) => pattern.test(item.name));
    if (!asset) process.exit(2);
    process.stdout.write(asset.browser_download_url);
  ' "$release_json" "$1" "$triple"
}

install_binary() {
  binary="$1"
  installed="$INSTALL_DIR/$binary"
  if [ -x "$installed" ] &&
     "$installed" --version 2>/dev/null | grep -q "$VERSION"; then
    echo "$binary $VERSION already installed"
    return
  fi

  url="$(asset_url "$binary")"
  archive="$work/$binary.tar.gz"
  extract="$work/$binary"
  mkdir -p "$extract"
  echo "Downloading $binary $VERSION for $triple"
  curl -fL \
    --retry 5 \
    --retry-delay 2 \
    --retry-all-errors \
    --connect-timeout 15 \
    "$url" -o "$archive"
  tar -xzf "$archive" -C "$extract"
  source_binary="$(find "$extract" -type f -name "$binary" | head -n 1)"
  if [ -z "$source_binary" ]; then
    echo "Archive does not contain $binary" >&2
    exit 1
  fi
  install -m 0755 "$source_binary" "$installed"
  "$installed" --version
}

for binary in $BINARIES; do
  install_binary "$binary"
done
echo "Installed Lore binaries ($BINARIES) in $INSTALL_DIR"
