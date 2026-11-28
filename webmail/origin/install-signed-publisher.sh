#!/bin/sh
# Run on the mail origin from a verified checkout: give the hash of the
# release Mac's bearer token. The origin never needs the Ed25519 private key.
set -eu
[ "$(id -u)" = 0 ] && [ "$(hostname -f)" = post.veyro.dk ] || exit 1
[ "$#" = 1 ] || { echo 'Expected the SHA256 of the transfer token.' >&2; exit 1; }
case "$1" in *[!0-9a-f]*) exit 1;; esac
[ "${#1}" = 64 ] || exit 1
cd "$(dirname "$0")"
umask 077
release_user=veyro-mail-release
if ! getent passwd "$release_user" >/dev/null; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$release_user"
fi
install -d -m 0755 /opt/veyro-mail-release/transfer /etc/veyro-mail-release
install -m 0644 desktop_release.py /opt/veyro-mail-release/
install -m 0644 transfer/transfer.py transfer/signed_transfer.py /opt/veyro-mail-release/transfer/
# Refuse an accidental trust-root change to clients already using this feed.
key=/etc/veyro-mail-release/update-signing-key.pem
if [ -e "$key" ] && ! cmp -s "$key" ../desktop/assets/update-signing-key.pem; then
    echo 'The installed public update key differs. Check the existing release identity before rotating it.' >&2
    exit 1
fi
install -m 0644 ../desktop/assets/update-signing-key.pem "$key"
token_hash_file=$(mktemp)
trap 'rm -f "$token_hash_file"' EXIT
printf '%s\n' "$1" > "$token_hash_file"
install -g "$release_user" -m 0440 "$token_hash_file" /etc/veyro-mail-release/token.sha256
# Keep existing root-owned legacy installers in place. The sticky bit prevents
# the publisher account from removing previously provisioned root-owned names.
install -d -o root -g "$release_user" -m 1775 /srv/veyro-mail-downloads
install -m 0644 veyro-mail-release.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable veyro-mail-release.service
systemctl restart veyro-mail-release.service
systemctl is-active --quiet veyro-mail-release.service
