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
install -m 0440 -o root -g 65532 /opt/mailcow-dockerized/data/assets/ssl/cert.pem secrets/mailcow-public.pem
docker compose up -d --build
