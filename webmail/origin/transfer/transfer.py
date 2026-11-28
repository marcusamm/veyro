#!/usr/bin/env python3
"""One-release transfer directly to a short-lived listener behind Veyro's HTTPS origin."""

import argparse
import hashlib
import hmac
import http.client
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST = "post.veyro.dk"
PREFIX = "/webmail-release-upload/"
PORT = 18146
CHUNK = 8 * 1024 * 1024
FILES = {
    "mac-apple": ("Veyro-Mail-0.1.0-beta.2-mac-arm64.dmg", 121885608, "240d647c1bd9cba0a4bd1b5e2a199d8a3410f14770b4a66a137e3d00d519799e"),
    "mac-intel": ("Veyro-Mail-0.1.0-beta.2-mac-x64.dmg", 129180662, "63c620a405e0d905edfee80889bbeed4459d351473bacdf294e0729734202086"),
    "windows": ("Veyro-Mail-0.1.0-beta.2-win-x64.exe", 122980375, "2c89adf78284399504087d5442dbce506b50feb695c3831b8cb70aaf5ae3f86c"),
}

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

class Stage:
    def __init__(self, root, files):
        root.mkdir(mode=0o700, parents=False, exist_ok=True)
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("Use a private staging directory owned by this user (0700).")
        self.root = root
        self.files = files
        for name, size, checksum in files.values():
            path = root / name
            if path.exists() and (path.stat().st_size != size or digest(path) != checksum):
                raise ValueError("Existing staged file does not match manifest: " + name)

    def offset(self, key):
        name, size, _ = self.files[key]
        if (self.root / name).is_file():
            return size
        part = self.root / (name + ".partial")
        if not part.exists():
            return 0
        # Recover after an interrupted write by discarding the incomplete chunk.
        offset = part.stat().st_size
        if offset == size:
            self.finish(key)
            return size
        if offset > size:
            raise ValueError("Invalid partial size")
        committed = offset - offset % CHUNK
        if committed != offset:
            with part.open("r+b") as stream:
                stream.truncate(committed)
        return committed

    def write(self, key, offset, data):
        name, size, _ = self.files[key]
        part = self.root / (name + ".partial")
        with part.open("ab") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if offset + len(data) == size:
            self.finish(key)

    def finish(self, key):
        name, _, expected = self.files[key]
        part = self.root / (name + ".partial")
        if digest(part) != expected:
            part.unlink()
            raise ValueError("File checksum mismatch")
        os.replace(part, self.root / name)
        print("Verified", name, flush=True)

class Receiver(BaseHTTPRequestHandler):
    timeout = 45
    def log_message(self, *args):
        pass

    def reply(self, status, offset=None):
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("Content-Length", "0")
        if offset is not None:
            self.send_header("Upload-Offset", str(offset))
        self.end_headers()

    def receive(self):
        headers = self.headers.get_all("Authorization", [])
        token = re.fullmatch(r"Bearer ([0-9a-f]{64})", headers[0]) if len(headers) == 1 else None
        if not token or not hmac.compare_digest(hashlib.sha256(token[1].encode("ascii")).hexdigest(), self.server.token_hash):
            return self.reply(403)
        stage = self.server.stage
        key = self.path[len(PREFIX):] if self.path.startswith(PREFIX) else ""
        if key not in stage.files:
            return self.reply(404)
        size = stage.files[key][1]
        try:
            offset = stage.offset(key)
            if self.command == "HEAD":
                return self.reply(200, offset)
            if self.headers.get_all("Upload-Offset", []) != [str(offset)] or offset == size:
                return self.reply(409, offset)
            length = min(CHUNK, size - offset)
            if self.headers.get("Transfer-Encoding") or self.headers.get_all("Content-Length", []) != [str(length)]:
                return self.reply(400)
            data = self.rfile.read(length)
            if len(data) != length:
                return self.reply(400)
            stage.write(key, offset, data)
            return self.reply(204, offset + length)
        except ValueError:
            return self.reply(422)
        except (OSError, socket.timeout):
            return self.reply(500)

    do_PUT = do_HEAD = receive

def serve(root, token_hash):
    if not re.fullmatch(r"[0-9a-f]{64}", token_hash):
        raise ValueError("Expected SHA256 of the transfer token")
    os.umask(0o077)
    with HTTPServer(("127.0.0.1", PORT), Receiver) as server:
        server.stage = Stage(root, FILES)
        server.token_hash = token_hash
        server.timeout = 1
        print("Release staging ready on loopback port", PORT, flush=True)
        deadline = time.monotonic() + 45 * 60
        while time.monotonic() < deadline:
            server.handle_request()

def request(method, key, token, offset=None, data=None):
    headers = {"Authorization": "Bearer " + token, "Cache-Control": "no-store"}
    if offset is not None:
        headers["Upload-Offset"] = str(offset)
    connection = http.client.HTTPSConnection(HOST, timeout=90)
    try:
        connection.request(method, PREFIX + key, body=data, headers=headers)
        response = connection.getresponse()
        if response.status not in (200, 204):
            if response.status in (408, 409, 429, 500, 502, 503, 504):
                raise OSError("Transient HTTP " + str(response.status))
            raise ValueError("Upload refused: HTTP " + str(response.status))
        return int(response.getheader("Upload-Offset"))
    finally:
        connection.close()

def send(token_file, folder):
    if not stat.S_ISREG(token_file.lstat().st_mode) or token_file.stat().st_mode & 0o077:
        raise ValueError("Expected a private token file (0600).")
    token = token_file.read_text().strip()
    if not re.fullmatch(r"[0-9a-f]{64}", token):
        raise ValueError("Token file is invalid")
    for name, size, checksum in FILES.values():
        path = folder / name
        if path.stat().st_size != size or digest(path) != checksum:
            raise ValueError("Local installer differs from manifest: " + name)
    for key, (name, size, _) in FILES.items():
        failures = 0
        with (folder / name).open("rb") as stream:
            while True:
                try:
                    offset = request("HEAD", key, token)
                    if offset == size:
                        print("Uploaded and verified", name, flush=True)
                        break
                    if not 0 <= offset < size or offset % CHUNK:
                        raise ValueError("Invalid offset from origin")
                    stream.seek(offset)
                    data = stream.read(min(CHUNK, size - offset))
                    if request("PUT", key, token, offset, data) != offset + len(data):
                        raise ValueError("Unexpected acknowledgement")
                    failures = 0
                except (OSError, http.client.HTTPException) as error:
                    failures += 1
                    if failures >= 5:
                        raise RuntimeError("Could not reach the release origin after 5 retries") from error
                    time.sleep(failures * 2)

def prepare(token_file):
    value = secrets.token_hex(32)
    with os.fdopen(os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
        f.write(value + "\n")
    print(hashlib.sha256(value.encode("ascii")).hexdigest())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("prepare").add_argument("token_file", type=Path)
    receiver = commands.add_parser("serve")
    receiver.add_argument("stage", type=Path)
    receiver.add_argument("token_hash")
    sender = commands.add_parser("send")
    sender.add_argument("token_file", type=Path)
    sender.add_argument("folder", type=Path)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.token_file)
    elif args.command == "serve":
        serve(args.stage, args.token_hash)
    else:
        send(args.token_file, args.folder)

if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, TypeError) as err:
        sys.exit(str(err))
