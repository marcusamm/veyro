#!/bin/sh
set -eu
cd "$(dirname "$0")"
umask 077
source_cert=/opt/mailcow-dockerized/data/assets/ssl/cert.pem
dest=secrets/mailcow-public.pem
tmp=$(mktemp secrets/.mailcow-public.XXXXXX)
trap 'rm -f "$tmp"' EXIT
# Extract the public leaf even when the source bundle also includes a chain.
openssl x509 -in "$source_cert" -out "$tmp"
openssl verify -partial_chain -trusted "$tmp" -verify_hostname post.veyro.dk "$tmp" >/dev/null
if cmp -s "$tmp" "$dest"; then exit 0; fi
chown root:65532 "$tmp"
chmod 0440 "$tmp"
mv -f "$tmp" "$dest"
