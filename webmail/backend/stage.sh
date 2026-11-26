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
sh refresh-trust.sh
install -m 0644 veyro-webmail-trust.service veyro-webmail-trust.path /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now veyro-webmail-trust.path
docker compose up -d --build
