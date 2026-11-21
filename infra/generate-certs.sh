#!/bin/sh
set -eu

cert_dir="${1:-/certs}"
mkdir -p "$cert_dir"

if [ -f "$cert_dir/ca.crt" ] &&
   [ -f "$cert_dir/ca.key" ] &&
   [ -f "$cert_dir/grpc.crt" ] &&
   [ -f "$cert_dir/grpc.key" ]; then
  chmod 0600 "$cert_dir/ca.key" "$cert_dir/grpc.key"
  chmod 0644 "$cert_dir/ca.crt" "$cert_dir/grpc.crt"
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache openssl >/dev/null
  else
    echo "openssl is required" >&2
    exit 1
  fi
fi

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    subject_prefix="//CN"
    ;;
  *)
    subject_prefix="/CN"
    ;;
esac

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
  -keyout "$cert_dir/ca.key" \
  -out "$cert_dir/ca.crt" \
  -subj "$subject_prefix=Yeomai Lore Dev CA"

openssl req -newkey rsa:2048 -nodes -sha256 \
  -keyout "$cert_dir/grpc.key" \
  -out "$cert_dir/grpc.csr" \
  -subj "$subject_prefix=host.docker.internal"

cat > "$cert_dir/grpc.ext" <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1
EOF

openssl x509 -req -sha256 -days 365 \
  -in "$cert_dir/grpc.csr" \
  -CA "$cert_dir/ca.crt" \
  -CAkey "$cert_dir/ca.key" \
  -CAserial "$cert_dir/ca.srl" \
  -CAcreateserial \
  -out "$cert_dir/grpc.crt" \
  -extfile "$cert_dir/grpc.ext"

rm -f "$cert_dir/grpc.csr" "$cert_dir/grpc.ext" "$cert_dir/ca.srl"
chmod 0600 "$cert_dir/ca.key" "$cert_dir/grpc.key"
chmod 0644 "$cert_dir/ca.crt" "$cert_dir/grpc.crt"
