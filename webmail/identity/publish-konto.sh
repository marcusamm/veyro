#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
conf=/etc/caddy/Caddyfile
site=/etc/caddy/veyro-sites/konto.caddy
include='import /etc/caddy/veyro-sites/*.caddy'
[ "$(id -u)" = 0 ]
[ "$(hostname -f)" = post.veyro.dk ]
grep -qxF '# Veyro SOGo public endpoint' "$conf"
# Publish only after the configured issuer is live on the private backend.
issuer=https://konto.veyro.dk/application/o/veyro-mail/
curl -fsS -H 'Host: konto.veyro.dk' -H 'X-Forwarded-Proto: https' \
  http://127.0.0.1:18081/application/o/veyro-mail/.well-known/openid-configuration |
  python3 -c 'import json,sys; sys.exit(json.load(sys.stdin)["issuer"] != sys.argv[1])' "$issuer"
exec 9>/run/lock/veyro-sogo-publish.lock
flock 9
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
cp -p "$conf" "$tmp/prior"
[ ! -f "$site" ] || cp -p "$site" "$tmp/prior-site"
install -d -m 0755 /etc/caddy/veyro-sites
candidate="$tmp/Caddyfile"
cp -p "$conf" "$candidate"
grep -qxF "$include" "$candidate" || printf '\n%s\n' "$include" >> "$candidate"
install -m 0644 konto.caddy "$site"
restore() {
  install -m 0644 "$tmp/prior" "$conf"
  if [ -f "$tmp/prior-site" ]; then install -m 0644 "$tmp/prior-site" "$site"; else rm -f "$site"; fi
}
if ! caddy validate --adapter caddyfile --config "$candidate"; then restore; exit 1; fi
install -m 0644 "$candidate" "$conf"
if ! systemctl reload caddy; then restore; systemctl reload caddy; exit 1; fi
