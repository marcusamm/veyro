#!/bin/sh
set -eu
[ "$(id -u)" = 0 ]
[ "$(hostname -f)" = post.veyro.dk ]
cd -- "$(dirname -- "$0")"
conf=/etc/caddy/Caddyfile
site=/etc/caddy/veyro-post-routes/mail-api.caddy
grep -qxF '# Veyro SOGo public endpoint' "$conf"
exec 9>/run/lock/veyro-sogo-publish.lock
flock 9
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
cp -p "$conf" "$tmp/old"
[ ! -f "$site" ] || cp -p "$site" "$tmp/old-site"
python3 - "$conf" "$tmp/Caddyfile" <<'PY'
from pathlib import Path
import sys
content = Path(sys.argv[1]).read_text()
marker = "\t\trespond @ambiguous 404\n"
directive = "\t\timport /etc/caddy/veyro-post-routes/*.caddy\n"
if content.count(marker) != 1:
    raise SystemExit("Review the post.veyro.dk route before installing.")
if directive not in content:
    content = content.replace(marker, marker + directive)
Path(sys.argv[2]).write_text(content)
PY
restore() {
    install -m 0644 "$tmp/old" "$conf"
    if [ -f "$tmp/old-site" ]; then install -m 0644 "$tmp/old-site" "$site"; else rm -f "$site"; fi
}
install -D -m 0644 mail-api.caddy "$site"
if ! caddy validate --adapter caddyfile --config "$tmp/Caddyfile"; then restore; exit 1; fi
install -m 0644 "$tmp/Caddyfile" "$conf"
if ! systemctl reload caddy; then restore; systemctl reload caddy; exit 1; fi
