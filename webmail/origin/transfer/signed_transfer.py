#!/usr/bin/env python3
"""Publish a verified desktop release over the canonical Veyro HTTPS endpoint."""
import argparse
import hashlib
import http.client
import threading
import time
from collections import OrderedDict
import os
from pathlib import Path
import re
import shutil
import stat
import sys
from http.server import ThreadingHTTPServer

import transfer
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import desktop_release as releases

PREFIX = "/webmail-release-upload/v1/"
PLATFORMS = {"mac-apple":"darwin-arm64", "mac-intel":"darwin-x64", "windows":"win32-x64"}


class Publisher:
    def __init__(self, staging, public, key):
        self.staging, self.public, self.key = staging, public, key
        self.stage = None
        self.envelope = b""
        self.active = self.staging / ".active.json"
        self.lock = threading.Lock()

    def restore(self):
        if self.active.exists():
            saved = releases.bounded_feed(self.active)
            if self.begin(saved):
                self.active.unlink(missing_ok=True)

    def begin(self, envelope):
        manifest = releases.read_feed(envelope, self.key)
        version = manifest["version"]
        current_path = self.public / "update.json"
        if current_path.exists():
            current = releases.read_feed(releases.bounded_feed(current_path), self.key)
            if releases.rank(current["version"]) > releases.rank(version):
                raise ValueError("Newer release is already live")
            if current["version"] == version:
                if current != manifest:
                    raise ValueError("Version collision")
                releases.verify_directory(self.public / version, manifest)
                # A restart may happen after the atomic feed replacement but
                # before the private staging directory was removed.
                leftover = self.staging / version
                if leftover.exists():
                    shutil.rmtree(leftover)
                return True
        if self.envelope and self.envelope != envelope:
            other = releases.read_feed(self.envelope, self.key)
            if releases.rank(other["version"]) >= releases.rank(version):
                raise ValueError("Conflicting release is in progress")
        previous = self.stage.root if self.stage is not None else None
        files = {}
        for name, platform in PLATFORMS.items():
            asset = manifest["files"][platform]
            files[name] = (asset["name"], asset["size"], asset["sha256"])
        self.stage = transfer.Stage(self.staging / version, files)
        temporary = self.staging / ".active.tmp"
        temporary.write_bytes(envelope)
        os.replace(temporary, self.active)
        self.envelope = envelope
        if previous is not None and previous != self.stage.root and previous.exists():
            shutil.rmtree(previous)
        return False

    def commit(self):
        if not self.stage:
            raise ValueError("Open release before uploading")
        version = releases.publish(self.public, self.envelope, self.key, self.stage.root)
        completed = self.stage.root
        self.stage = None
        self.envelope = b""
        self.active.unlink(missing_ok=True)
        shutil.rmtree(completed)
        print("Published Veyro Mail", version, flush=True)


class ReleaseServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 12

    def __init__(self, address, receiver):
        super().__init__(address, receiver)
        self.slots = threading.BoundedSemaphore(8)
        self.failures = OrderedDict()
        self.failures_lock = threading.Lock()

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def rejection(self, ip):
        now = time.monotonic()
        with self.failures_lock:
            since, count = self.failures.pop(ip, (now, 0))
            if now - since >= 60:
                since, count = now, 0
            self.failures[ip] = since, count + 1
            if len(self.failures) > 1024:
                self.failures.popitem(last=False)
        return 429 if count >= 10 else 403


class Receiver(transfer.Receiver):
    timeout = 30
    def receive(self):
        if not self.authorized():
            return self.reply(self.server.rejection(self.headers.get("X-Veyro-Release-IP", "")[:64]))
        # The release digest and offset apply to a single active version.
        with self.server.manager.lock:
            return self.receive_authorized()

    def receive_authorized(self):
        key = self.path[len(PREFIX):] if self.path.startswith(PREFIX) else ""
        manager = self.server.manager
        if key == "begin" and self.command == "POST":
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not re.fullmatch(r"[1-9][0-9]{0,4}", lengths[0]) or self.headers.get("Transfer-Encoding"):
                return self.reply(400)
            length = int(lengths[0])
            if length > releases.MAX_MANIFEST:
                return self.reply(413)
            try:
                envelope = self.rfile.read(length)
                if len(envelope) != length:
                    return self.reply(400)
                live = manager.begin(envelope)
                return self.reply(200, int(live))
            except (OSError, ValueError):
                return self.reply(422)
        if not manager.stage or self.headers.get_all("X-Veyro-Release", []) != [hashlib.sha256(manager.envelope).hexdigest()]:
            return self.reply(409)
        if key == "publish" and self.command == "POST":
            if self.headers.get("Transfer-Encoding") or self.headers.get_all("Content-Length", []) != ["0"]:
                return self.reply(400)
            try:
                manager.commit()
                return self.reply(204, 0)
            except (OSError, ValueError):
                return self.reply(422)
        if key not in PLATFORMS or self.command not in {"HEAD", "PUT"}:
            return self.reply(404)
        return self.receive_file(manager.stage, key)

    do_HEAD = do_PUT = do_POST = receive


def publish(token_file, folder):
    token = transfer.read_token(token_file)
    envelope = releases.bounded_feed(folder / "update.json")
    manifest = releases.read_feed(envelope, releases.REPO_KEY)
    files = {}
    for name, platform in PLATFORMS.items():
        entry = manifest["files"][platform]
        files[name] = (entry["name"], entry["size"], entry["sha256"])
    transfer.verify_files(folder, files)
    headers = {"X-Veyro-Release": hashlib.sha256(envelope).hexdigest()}
    def request(method, name, token, offset=None, data=None):
        return transfer.request(method, name, token, offset, data, prefix=PREFIX, extra=headers, timeout=180)
    if request("POST", "begin", token, data=envelope) == 0:
        transfer.upload_files(token, folder, files, request)
        request("POST", "publish", token, data=b"")
    print("Veyro Mail", manifest["version"], "is published.")


def serve(token_digest, staging, public, public_key):
    digest = token_digest.read_text().strip()
    if not re.fullmatch("[0-9a-f]{64}", digest):
        raise ValueError("Invalid release token digest")
    for directory in (staging, public):
        if not directory.is_dir():
            raise ValueError("Release directories must exist")
    info = staging.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Use a private publisher-owned staging directory")
    os.umask(0o077)
    with ReleaseServer(("127.0.0.1", 18147), Receiver) as server:
        server.token_hash = digest
        server.manager = Publisher(staging, public, public_key)
        server.manager.restore()
        server.serve_forever()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    send = sub.add_parser("publish")
    send.add_argument("token_file", type=Path)
    send.add_argument("dist", type=Path)
    server = sub.add_parser("serve")
    server.add_argument("token_digest", type=Path)
    server.add_argument("staging", type=Path)
    server.add_argument("public", type=Path)
    server.add_argument("public_key", type=Path)
    args = p.parse_args()
    if args.cmd == "serve":
        serve(args.token_digest, args.staging, args.public, args.public_key)
    else:
        publish(args.token_file, args.dist)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, http.client.HTTPException, RuntimeError) as error:
        sys.exit(str(error))
