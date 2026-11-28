#!/bin/sh
# On post.veyro.dk: sh install-downloads.sh /absolute/path/to/staged-installers
# After success, run the existing publish.sh to validate and reload Caddy.
set -eu
[ "$(id -u)" = 0 ] && [ "$(hostname -f)" = post.veyro.dk ] || exit 1
[ "$#" = 1 ] || { echo 'Expected a staging directory.' >&2; exit 1; }
source_dir=$(cd -- "$1" && pwd -P)
origin_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
version=0.1.0-beta.2
manifest="$origin_dir/SHA256SUMS-$version.txt"
base=/srv/veyro-mail-downloads
install -d -o root -g root -m 0755 "$base"
exec 9>/run/lock/veyro-mail-downloads.lock
flock 9
if [ -e "$base/$version" ]; then
    (cd "$base/$version" && sha256sum --strict -c "$manifest")
    exit
fi
staged=$(mktemp -d "$base/.install.XXXXXXXX")
trap 'rm -rf -- "$staged"' EXIT
while read -r checksum filename; do
    install -o root -g root -m 0644 -- "$source_dir/$filename" "$staged/$filename"
done < "$manifest"
(cd "$staged" && sha256sum --strict -c "$manifest")
chmod 0755 "$staged"
mv -T -- "$staged" "$base/$version"
