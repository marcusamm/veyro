#!/usr/bin/env bash
set -euo pipefail
if (( $# > 1 )); then echo "Brug: bash install.sh [mailcow-mappe]" >&2; exit 2; fi
overlay_dir=$(cd -- "$(dirname -- "$0")" && pwd)
python3 - "$overlay_dir" "${1:-/opt/mailcow-dockerized}" <<'PY'
import fcntl
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

overlay, root = (Path(arg).resolve() for arg in sys.argv[1:])
web = root / "data/web"
sogo = root / "data/conf/sogo"
if not all(p.is_dir() for p in (web/"css/build", web/"js/build", sogo)) or not (root/"docker-compose.yml").is_file():
    sys.exit("Mailcow-installationen blev ikke fundet i " + str(root))

state = root / ".veyro-mail-overlay"
state.mkdir(mode=0o700, exist_ok=True)
lock = (state/"install.lock").open("a")
fcntl.flock(lock, fcntl.LOCK_EX)
config = re.sub(r"/\*.*?\*/|//[^\n]*", "", (sogo/"sogo.conf").read_text(), flags=re.S)
if not re.search(r'\bSOGoUIAdditionalJSFiles\s*=\s*\([^)]*\bjs/theme\.js\b', config):
    sys.exit("SOGoUIAdditionalJSFiles skal indeholde js/theme.js for at kunne indlæse designet.")

# mailcow mounts /etc/sogo from the host and serves the shared /sogo_web volume through Nginx.
compose = ["docker", "compose", "exec", "-T", "sogo-mailcow", "sh", "-eu", "-c"]
sync_assets = """
src=/etc/sogo/custom-theme.js
dst=/sogo_web/WebServerResources/js/theme.js
test -f "$src" && test -f "$dst"
if ! cmp -s "$src" "$dst"; then
  tmp=$(mktemp "${dst}.veyro.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  cp "$src" "$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$dst"
fi
"""
theme = sogo/"custom-theme.js"
shipped = subprocess.check_output(compose + ["cat /sogo_web/WebServerResources/js/theme.js"], cwd=root)

brand = overlay.parent / "assets"
sources = {"login.css": overlay/"login.css", "inbox.css": overlay/"inbox.css",
           "logo.svg": overlay/"logo.svg", "mark.svg": brand/"favicon.svg",
           "manrope.woff2": brand/"manrope.woff2", "Manrope-OFL.txt": brand/"Manrope-OFL.txt"}
if (overlay/"inbox.js").is_file():
    sources["inbox.js"] = overlay/"inbox.js"
assets = {name: file.read_bytes() for name, file in sources.items()}
login_js = (overlay/"login.js").read_bytes()
public = web / "veyro-mail"
wanted = {public/name: data for name, data in assets.items()}

def add_managed(path, body, initial=b""):
    original = path.read_bytes() if path.exists() else initial
    start, end = b"/* BEGIN Veyro Mail overlay */", b"/* END Veyro Mail overlay */"
    block = start + b"\n" + body.rstrip() + b"\n" + end
    if start in original or end in original:
        if original.count(start) != 1 or original.count(end) != 1 or original.index(end) < original.index(start):
            sys.exit("Ufuldstændig Veyro-markering i " + str(path))
        before, rest = original.split(start)
        wanted[path] = before + block + rest.split(end)[1]
    else:
        wanted[path] = original + (b"\n" if original else b"") + block + b"\n"

# Use full CSS in the bundle. A trailing @import after mailcow's own rules is invalid CSS.
add_managed(web/"css/build/0081-custom-mailcow.css", assets["login.css"])
add_managed(web/"js/build/0081-veyro-mail-login.js", login_js)

def versioned(name):
    return "/veyro-mail/" + name + "?v=" + hashlib.sha256(assets[name]).hexdigest()[:16]

loader = """
;(function () {
  if (window.top !== window.self) return;
  function applyTheme() {
    if (!document.querySelector('meta[name="description"][content="SOGo Web Interface"]') ||
        !document.body || !/^SOGo[.]/.test(document.body.getAttribute('ng-app') || '') ||
        document.getElementById('veyro-mail-inbox-style')) return;
    var link = document.createElement('link');
    link.id = 'veyro-mail-inbox-style';
    link.rel = 'stylesheet';
    link.href = '%s';
    document.head.appendChild(link);
""" % versioned("inbox.css")
if "inbox.js" in assets:
    loader += """
    var script = document.createElement('script');
    script.src = '%s';
    document.head.appendChild(script);
""" % versioned("inbox.js")
loader += """
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyTheme);
  else applyTheme();
})();"""
add_managed(theme, loader.encode(), initial=shipped)

# Preserve other customisations and keep recoverable originals outside the web root.
for path in wanted:
    if path.resolve() != path or (path.exists() and not path.is_file()):
        sys.exit("Uventet filtype i mailcow-installationen: " + str(path))
changed = [p for p, data in wanted.items() if not p.exists() or p.read_bytes() != data]
public.mkdir(mode=0o755, exist_ok=True)
backup = None

def replace(path, data, original=None):
    # Docker bind-mounts this single file. Keep its inode so SOGo also sees the edit
    # if its bootstrap script resyncs the web volume before container recreation.
    if path == theme and original:
        with path.open("r+b") as mounted:
            mounted.write(data)
            mounted.truncate()
            mounted.flush()
            os.fsync(mounted.fileno())
        return
    fd, tmp = tempfile.mkstemp(prefix=".veyro-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            if original:
                os.fchown(out.fileno(), original.st_uid, original.st_gid)
            os.fchmod(out.fileno(), original.st_mode & 0o777 if original else 0o644)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

if changed:
    backup = Path(tempfile.mkdtemp(prefix="before-", dir=state))
    for path in changed:
        if path.exists():
            dest = backup/path.relative_to(root)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)
    print("Sikkerhedskopi:", backup, flush=True)

applied = []
try:
    for path in changed:
        stat = path.stat() if path.exists() else None
        applied.append((path, stat))
        replace(path, wanted[path], stat)
    subprocess.run(compose + [sync_assets], cwd=root, check=True)
except BaseException:
    for path, stat in reversed(applied):
        if stat:
            replace(path, (backup/path.relative_to(root)).read_bytes(), stat)
        elif path.exists():
            path.unlink()
    if applied:
        subprocess.run(compose + [sync_assets], cwd=root, check=False)
    raise
print("Veyros maildesign er installeret." if changed else "Veyros maildesign er allerede installeret.")
PY
