#!/bin/sh
set -eu
[ "$(id -u)" = 0 ]
cd "$(dirname "$0")"
umask 077
install -d -m 0710 -o root -g 65532 secrets
if [ ! -s secrets/origin-token ]; then
  tmp=$(mktemp secrets/.origin.XXXXXX)
  trap 'rm -f "$tmp"' EXIT
  openssl rand -hex 48 > "$tmp"
  ln "$tmp" secrets/origin-token
  rm "$tmp"
  trap - EXIT
fi
chown root:65532 secrets/origin-token
chmod 0440 secrets/origin-token
# Retained across releases: generating a new key during deployment would sign
# every remembered browser out. Never repair/overwrite an existing invalid key.
if [ ! -e secrets/remembered-session-key ]; then
  tmp=$(mktemp secrets/.remembered.XXXXXX)
  trap 'rm -f "$tmp"' EXIT
  openssl rand -base64 32 | tr '+/' '-_' > "$tmp"
  ln "$tmp" secrets/remembered-session-key
  rm "$tmp"
  trap - EXIT
fi
python3 - <<'PY'
import base64
from pathlib import Path
key = Path('secrets/remembered-session-key').read_bytes().strip()
if len(key) != 44 or len(base64.b64decode(key, altchars=b'-_', validate=True)) != 32:
    raise RuntimeError('Invalid remembered-session key; restore the existing key from backup')
PY
chown root:65532 secrets/remembered-session-key
chmod 0440 secrets/remembered-session-key
sh refresh-trust.sh
install -m 0644 veyro-webmail-trust.service veyro-webmail-trust.path /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now veyro-webmail-trust.path
python3 configure-recovery.py
python3 configure-org-broker.py
python3 configure-recovery.py --configure-org-roles
docker compose up -d --build
