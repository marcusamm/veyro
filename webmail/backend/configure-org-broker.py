"""Provision a local-only native Mailcow key for the isolated organization broker."""

import fcntl
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import subprocess
import tempfile


STACK = Path("/opt/mailcow-dockerized")
STATE = Path("/etc/veyro-mail-admin")
KEY_NAME = "Veyro Mail organization broker"
HOST = "post.veyro.dk"


class LocalMailcow(http.client.HTTPSConnection):
    def connect(self):
        raw = socket.create_connection(("127.0.0.1", self.port), self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=HOST)


def admin_request(context, bootstrap, path, data=None):
    conn = LocalMailcow(HOST, timeout=10, context=context)
    try:
        body = None if data is None else json.dumps(data)
        conn.request("GET" if data is None else "POST", "/api/v1/" + path, body,
                     {"X-API-Key": bootstrap, "Content-Type": "application/json"})
        response = conn.getresponse()
        raw = response.read(1024 * 1024 + 1)
        if response.status != 200 or len(raw) > 1024 * 1024:
            raise RuntimeError("Native key operation failed")
        return json.loads(raw)
    finally:
        conn.close()


def local_gateway():
    container = subprocess.check_output(["docker", "compose", "ps", "-q", "nginx-mailcow"],
                                        cwd=STACK, text=True).strip()
    if not re.fullmatch("[0-9a-f]{12,64}", container):
        raise RuntimeError("Expected a running Mailcow gateway")
    result = subprocess.check_output(
        ["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", container], text=True)
    addresses = {net.get("Gateway") for net in json.loads(result).values() if net.get("Gateway")}
    if len(addresses) != 1:
        raise RuntimeError("Expected a single local Mailcow bridge gateway")
    address = ipaddress.IPv4Address(addresses.pop())
    if not address.is_private:
        raise RuntimeError("Expected a private Mailcow bridge gateway")
    return str(address)


def native_key():
    config = (STACK / "mailcow.conf").read_text()
    match = re.search(r"^API_KEY=([A-Za-z0-9-]{16,255})$", config, re.MULTILINE)
    if not match:
        raise RuntimeError("The guest's local Mailcow bootstrap key is unavailable")
    bootstrap = match.group(1)
    context = ssl.create_default_context(cafile=str(STACK / "data/assets/ssl/cert.pem"))
    context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    allowed = {"127.0.0.1", local_gateway()}

    def matching_keys():
        rows = admin_request(context, bootstrap, "get/api-key/all")
        if not isinstance(rows, list):
            raise RuntimeError("Native key list unavailable")
        return [row for row in rows if row["description"] == KEY_NAME]

    matches = matching_keys()
    if not matches:
        result = admin_request(context, bootstrap, "add/api-key", {
            "description": KEY_NAME, "access": "rw", "allow_from": ",".join(sorted(allowed)),
            "active": 1, "skip_ip_check": 0,
        })
        if not isinstance(result, list) or not result or any(row.get("type") != "success" for row in result):
            raise RuntimeError("Native broker key creation failed")
        matches = matching_keys()
    if len(matches) != 1:
        raise RuntimeError("Expected exactly one dedicated broker key")
    row = matches[0]
    if (row["access"] != "rw" or int(row["active"]) != 1 or int(row["skip_ip_check"]) != 0
            or int(row["service"]) != 0 or set(row["allow_from"]) != allowed
            or not re.fullmatch(r"[A-Za-z0-9-]{16,255}", row["api_key"])):
        raise RuntimeError("Existing broker key has unexpected restrictions")
    return row["api_key"]


def store(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        try:
            os.fchown(stream.fileno(), 0, 65531)
            os.fchmod(stream.fileno(), 0o440)
            stream.write(value.encode("ascii") + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(stream.name, path)
        finally:
            Path(stream.name).unlink(missing_ok=True)


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run inside the mail guest as root")
    os.umask(0o077)
    STATE.mkdir(mode=0o700, exist_ok=True)
    with (STATE / "provision.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        private, run = STATE / "private", STATE / "run"
        for directory, owner, group, mode in [(private, 0, 65531, 0o750), (run, 65531, 65532, 0o2750)]:
            directory.mkdir(exist_ok=True)
            os.chown(directory, owner, group)
            os.chmod(directory, mode)
        key_path = private / "dns-key"
        if key_path.exists():
            if not re.fullmatch("[0-9a-f]{64}", key_path.read_text().strip()):
                raise RuntimeError("Existing DNS challenge key is malformed")
        else:
            store(key_path, secrets.token_hex(32))
        store(private / "mailcow-key", native_key())
    print("Provisioned the local organization broker")


if __name__ == "__main__":
    main()
