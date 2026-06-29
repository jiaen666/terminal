#!/bin/bash
set -e

# If a custom command is given, run it directly (e.g., bridge-api only)
if [ $# -gt 0 ]; then
  echo "Starting custom command: $@"
  exec "$@"
fi

# Default: start bridge API + guacd
echo "Starting bridge API on port 5998..."
python3 /usr/local/bin/bridge-api.py &
BRIDGE_PID=$!
sleep 1

echo "Applying RDP cert bypass patch..."
/usr/local/bin/patch-rdp.sh

echo "Importing RDP server certificates..."
for target in ${RDP_IMPORT_CERTS:-172.30.64.6:3389}; do
  host=$(echo "$target" | cut -d: -f1)
  port=$(echo "$target" | cut -d: -f2)
  echo "  Importing cert from $host:$port..."
  cert_pem=$(echo | openssl s_client -connect "${host}:${port}" 2>/dev/null | openssl x509 -outform PEM 2>/dev/null) || {
    echo "  WARNING: Could not fetch cert from $host:$port, skipping"
    continue
  }
  echo "$cert_pem" > "/usr/local/share/ca-certificates/rdp-${host}.crt"
  update-ca-certificates 2>/dev/null || true
  cert_hash=$(echo "$cert_pem" | openssl x509 -outform DER 2>/dev/null | sha256sum | awk '{print $1}')
  mkdir -p /root/.config/freerdp/server /root/.config/freerdp/certs
  echo "$cert_hash" > "/root/.config/freerdp/server/${host}:${port}"
  echo "$cert_pem" > "/root/.config/freerdp/certs/${cert_hash}"
  echo "$host $port 0 $cert_hash" > /root/.config/freerdp/known_hosts2
  echo "  Cert imported: hash=$cert_hash"
done

echo "Starting guacd with SSL bypass..."
export LD_PRELOAD=/usr/local/lib/sslbypass.so
exec guacd -b 0.0.0.0 -f
