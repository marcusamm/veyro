#!/usr/bin/env python3
"""Verify, transfer and atomically promote a signed Veyro Mail desktop release."""
import base64
import binascii
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ARTIFACTS = {"darwin-arm64": "mac-arm64.dmg", "darwin-x64": "mac-x64.dmg", "win32-x64": "win-x64.exe"}
DEFAULT_ROOT = Path("/srv/veyro-mail-downloads")
REPO_KEY = Path(__file__).resolve().parents[1] / "desktop/assets/update-signing-key.pem"
INSTALLED_KEY = Path("/etc/veyro-mail-release/update-signing-key.pem")
VERSION = re.compile(r"(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-beta\.(0|[1-9][0-9]{0,5}))?")
MAX_MANIFEST = 16 * 1024


def rank(version):
    match = VERSION.fullmatch(version)
    if not match:
        raise ValueError("Invalid release version")
    major, minor, patch, beta = match.groups()
    return (int(major), int(minor), int(patch), beta is None, int(beta or 0))


def read_feed(data, public_key):
    if not 0 < len(data) <= MAX_MANIFEST:
        raise ValueError("Invalid release manifest size")
    try:
        envelope = json.loads(data)
        payload = base64.b64decode(envelope["payload"], validate=True)
        signature = base64.b64decode(envelope["signature"], validate=True)
        if len(signature) != 64 or set(envelope) != {"payload", "signature"}:
            raise ValueError("Invalid signed envelope")
        with tempfile.TemporaryDirectory() as tmp:
            contents, sig = Path(tmp) / "payload", Path(tmp) / "signature"
            contents.write_bytes(payload)
            sig.write_bytes(signature)
            verified = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(public_key),
                                       "-rawin", "-in", str(contents), "-sigfile", str(sig)], capture_output=True)
            if verified.returncode:
                raise ValueError("Release signature verification failed")
        doc = json.loads(payload)
        if type(doc["schema"]) is not int or doc["schema"] != 1 or set(doc["files"]) != set(ARTIFACTS):
            raise ValueError("Unknown schema or incomplete release")
        rank(doc["version"])
        for platform, suffix in ARTIFACTS.items():
            asset = doc["files"][platform]
            if (asset["name"] != f"Veyro-Mail-{doc['version']}-{suffix}" or
                    type(asset["size"]) is not int or not 1 <= asset["size"] <= 512 * 1024 * 1024 or
                    not re.fullmatch("[0-9a-f]{64}", asset["sha256"])):
                raise ValueError("Invalid installer " + platform)
        return doc
    except (binascii.Error, KeyError, TypeError, UnicodeError, json.JSONDecodeError):
        raise ValueError("Invalid signed release manifest") from None


def bounded_feed(filename):
    with filename.open("rb") as stream:
        return stream.read(MAX_MANIFEST + 1)


def copy_verified(stream, asset, output=None):
    h = hashlib.sha256()
    remaining = asset["size"]
    while remaining:
        block = stream.read(min(1024 * 1024, remaining))
        if not block:
            raise ValueError("Truncated installer: " + asset["name"])
        h.update(block)
        remaining -= len(block)
        if output is not None:
            output.write(block)
    if h.hexdigest() != asset["sha256"]:
        raise ValueError("Installer digest mismatch: " + asset["name"])


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish(root, envelope, public_key, folder):
    manifest = read_feed(envelope, public_key)
    version = manifest["version"]
    # Avoid a partial install or downgrade across concurrent publishers. The
    # HTTP server sees the manifest only after every immutable artifact exists.
    with (root / ".publish.lock").open("ab") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        feed = root / "update.json"
        if feed.exists():
            current = read_feed(bounded_feed(feed), public_key)
            if rank(current["version"]) > rank(version):
                raise ValueError("An already published release is newer")
            if current["version"] == version and current != manifest:
                raise ValueError("Cannot replace a published version")
        destination = root / version
        with tempfile.TemporaryDirectory(prefix=".promote-", dir=root) as temporary:
            tmp = Path(temporary)
            files = tmp / "files"
            files.mkdir()
            for platform in ARTIFACTS:
                asset = manifest["files"][platform]
                target = files / asset["name"]
                with (folder / asset["name"]).open("rb") as stream, target.open("xb") as output:
                    copy_verified(stream, asset, output)
                    if stream.read(1):
                        raise ValueError("Oversized installer: " + asset["name"])
                    output.flush()
                    os.fsync(output.fileno())
                    os.fchmod(output.fileno(), 0o644)
            if destination.exists():
                for asset in manifest["files"].values():
                    with (destination / asset["name"]).open("rb") as stream:
                        copy_verified(stream, asset)
                        if stream.read(1):
                            raise ValueError("Published file has unexpected length")
            else:
                files.chmod(0o755)
                sync_dir(files)
                files.rename(destination)
                sync_dir(root)
            with (tmp / "update.json").open("xb") as out:
                out.write(envelope)
                out.flush()
                os.fsync(out.fileno())
                os.fchmod(out.fileno(), 0o644)
            os.replace(tmp / "update.json", feed)
            sync_dir(root)
    return version


