#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }
cd -- "$(dirname -- "$0")"
umask 077
if [ ! -s .env ]; then
  tmp=$(mktemp .env.XXXXXX)
  trap 'rm -f "$tmp"' EXIT
  for key in PG_PASSWORD AUTHENTIK_SECRET_KEY BOOTSTRAP_PASSWORD VEYRO_OIDC_SECRET; do
    printf '%s=%s\n' "$key" "$(openssl rand -hex 48)"
  done >"$tmp"
  ln "$tmp" .env
  rm "$tmp"
  trap - EXIT
fi
chmod 600 .env
if ! grep -q '^BOOTSTRAP_PASSWORD_HASH=' .env; then
  python3 - <<'PY'
import base64
import hashlib
from pathlib import Path
import secrets

path = Path(".env")
password = next(line.split("=", 1)[1] for line in path.read_text().splitlines() if line.startswith("BOOTSTRAP_PASSWORD="))
salt = secrets.token_hex(16)
rounds = 1_200_000
digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), rounds)
value = "$".join(("pbkdf2_sha256", str(rounds), salt, base64.b64encode(digest).decode()))
with path.open("a") as env:
    env.write(f"BOOTSTRAP_PASSWORD_HASH='{value}'\n")
PY
fi
docker compose up --detach
