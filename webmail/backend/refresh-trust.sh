#!/bin/sh
set -eu
cd "$(dirname "$0")"
umask 077
source_cert=/opt/mailcow-dockerized/data/assets/ssl/cert.pem
dest=secrets/mailcow-public.pem
tmp=$(mktemp secrets/.mailcow-public.XXXXXX)
install -d -m 0750 -o root -g 65532 secrets/broker-trust
broker_tmp=$(mktemp secrets/broker-trust/.mailcow-public.XXXXXX)
trap 'rm -f "$tmp" "$broker_tmp"' EXIT
# Extract the public leaf even when the source bundle also includes a chain.
openssl x509 -in "$source_cert" -out "$tmp"
openssl verify -partial_chain -trusted "$tmp" -verify_hostname post.veyro.dk "$tmp" >/dev/null
if ! cmp -s "$tmp" secrets/broker-trust/mailcow-public.pem; then
  install -m 0440 -o root -g 65532 "$tmp" "$broker_tmp"
  mv -f "$broker_tmp" secrets/broker-trust/mailcow-public.pem
fi
if ! cmp -s "$tmp" "$dest"; then
  chown root:65532 "$tmp"
  chmod 0440 "$tmp"
  mv -f "$tmp" "$dest"
fi
