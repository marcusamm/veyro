"""Exercise the real Caddy snippet against a disposable loopback HTTP server.

Run with CADDY_BIN=/path/to/caddy python3 webmail/origin/test_body_limits.py.
No production service, mailbox or external HTTP endpoint is contacted.
"""

import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import uuid


class BodyLimits(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = os.environ.get("CADDY_BIN") or shutil.which("caddy")
        if not cls.binary:
            raise unittest.SkipTest("Set CADDY_BIN or install Caddy to run the real proxy checks.")
        cls.temp = tempfile.TemporaryDirectory(prefix="veyro-caddy-body-test-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.calls = []
        cls.started = []

        class Upstream(BaseHTTPRequestHandler):
            def consume(self):
                cls.started.append((self.command, self.path))
                count = 0
                try:
                    if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                        while True:
                            length = int(self.rfile.readline().split(b";", 1)[0].strip(), 16)
                            if not length:
                                self.rfile.readline()
                                break
                            chunk = self.rfile.read(length)
                            count += len(chunk)
                            if len(chunk) != length:
                                return
                            self.rfile.read(2)
                    else:
                        remaining = int(self.headers.get("Content-Length", "0"))
                        while remaining:
                            chunk = self.rfile.read(min(remaining, 65536))
                            if not chunk:
                                return
                            count += len(chunk)
                            remaining -= len(chunk)
                except (OSError, ValueError):
                    return
                cls.calls.append((self.command, self.path, count, dict(self.headers)))
                body = json.dumps({"path": self.path, "bytes": count}).encode()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (OSError, BrokenPipeError):
                    pass

            do_POST = do_GET = do_PUT = consume

            def log_message(self, *args):
                pass

        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        cls.addClassCleanup(cls.upstream.server_close)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.addClassCleanup(cls.upstream.shutdown)
        with socket.socket() as selected:
            selected.bind(("127.0.0.1", 0))
            cls.port = selected.getsockname()[1]
        snippet = Path(__file__).with_name("mail-api.caddy").read_text()
        snippet = snippet.replace("127.0.0.1:18082", "127.0.0.1:" + str(cls.upstream.server_port))
        downloads = Path(cls.temp.name) / "downloads"
        for version in ("0.1.0-beta.1", "0.1.0-beta.2"):
            release = downloads / version
            release.mkdir(parents=True)
            for platform in ("win-x64.exe", "mac-arm64.dmg", "mac-x64.dmg"):
                (release / f"Veyro-Mail-{version}-{platform}").write_text(f"{version} {platform}")
            (release / "private.txt").write_text("synthetic private file")
        snippet = snippet.replace("/srv/veyro-mail-downloads", str(downloads))
        config = Path(cls.temp.name) / "Caddyfile"
        config.write_text("{\n admin off\n auto_https off\n}\nhttp://127.0.0.1:" + str(cls.port) + " {\n" + snippet + "\n}\n")
        cls.environment = {**os.environ, "XDG_DATA_HOME": cls.temp.name, "XDG_CONFIG_HOME": cls.temp.name}
        adapted = subprocess.run([cls.binary, "adapt", "--adapter", "caddyfile", "--config", str(config), "--validate"],
                                 text=True, capture_output=True, timeout=30, env=cls.environment)
        if adapted.returncode:
            raise AssertionError(adapted.stderr)
        json.loads(adapted.stdout)
        cls.log = open(Path(cls.temp.name) / "caddy.log", "w+")
        cls.addClassCleanup(cls.log.close)
        cls.process = subprocess.Popen([cls.binary, "run", "--adapter", "caddyfile", "--config", str(config)],
                                       stdout=cls.log, stderr=cls.log, env=cls.environment)

        def stop():
            cls.process.terminate()
            try:
                cls.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.process.kill()
                cls.process.wait(timeout=5)

        cls.addClassCleanup(stop)
        for _ in range(100):
            try:
                with socket.create_connection(("127.0.0.1", cls.port), timeout=0.1):
                    break
            except OSError:
                if cls.process.poll() is not None:
                    cls.log.flush()
                    cls.log.seek(0)
                    raise AssertionError(cls.log.read())
                time.sleep(0.05)
        else:
            raise AssertionError("Caddy did not start on loopback")

    def request(self, method, path, size, *, chunked=False):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "application/json", "Authorization": "synthetic-stripped",
                   "X-Original-URL": "/synthetic-stripped", "X-Rewrite-URL": "/synthetic-stripped"}
        try:
            try:
                if chunked:
                    body = (b"x" * min(65536, size - i) for i in range(0, size, 65536))
                    connection.request(method, path, body=body, headers=headers, encode_chunked=True)
                else:
                    connection.request(method, path, body=b"x" * size, headers=headers)
            except BrokenPipeError:
                # Early 413 can close the upload while the client is still
                # writing. The HTTP response below must still confirm 413.
                pass
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_download_is_resumable_and_only_named_installers_are_served(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            for version in ("0.1.0-beta.1", "0.1.0-beta.2"):
                for platform in ("win-x64.exe", "mac-arm64.dmg", "mac-x64.dmg"):
                    with self.subTest(version=version, platform=platform):
                        filename = f"Veyro-Mail-{version}-{platform}"
                        expected = f"{version} {platform}".encode()
                        path = "/webmail-downloads/" + filename
                        connection.request("GET", path, headers={"Range": "bytes=0-11"})
                        response = connection.getresponse()
                        self.assertEqual(response.status, 206)
                        self.assertEqual(response.read(), expected[:12])
                        self.assertEqual(response.getheader("Content-Disposition"), 'attachment; filename="' + filename + '"')
                        self.assertEqual(response.getheader("Content-Type"), "application/octet-stream")
                        connection.request("HEAD", path)
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(int(response.getheader("Content-Length")), len(expected))
                        self.assertEqual(response.read(), b"")
        finally:
            connection.close()
        for method, target in [("POST", path), ("GET", "/webmail-downloads/"),
                               ("GET", "/webmail-downloads/private.txt"),
                               ("GET", "/webmail-downloads/Veyro-Mail-0.1.0-beta.3-win-x64.exe")]:
            with self.subTest(method=method, target=target):
                self.assertEqual(self.request(method, target, 0)[0], 404)

    def test_upload_accepts_exact_7mib_and_strips_proxy_path_and_untrusted_headers(self):
        # The exact path matcher must keep its upload allowance when a query
        # marker is present, and stripping the proxy prefix must retain it.
        for query in ("", "?body-limit-probe=" + uuid.uuid4().hex):
            with self.subTest(query=query):
                path = "/webmail-api/api/team/files" + query
                upstream_path = path.removeprefix("/webmail-api")
                status, body = self.request("POST", path, 7 * 1024 * 1024)
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body), {"path": upstream_path, "bytes": 7 * 1024 * 1024})
                call = next(item for item in reversed(self.calls) if item[:2] == ("POST", upstream_path))
                headers = {key.lower(): value for key, value in call[3].items()}
                for name in ("authorization", "x-original-url", "x-rewrite-url"):
                    self.assertNotIn(name, headers)

    def test_oversize_content_length_is_rejected_before_reading_or_contacting_upstream(self):
        # Send headers only: this must not wait for a body or open an upstream
        # request. Caddy 2.6 otherwise turns a later proxy read failure into 502.
        for path, limit in [("/webmail-api/api/team/files", 7 * 1024 * 1024),
                            ("/webmail-api/api/team/posts", 256 * 1024)]:
            with self.subTest(path=path):
                # Other tests can leave an aborted upload reaching the upstream
                # asynchronously. Assert against this unique request, not the
                # global count of all requests handled by the shared server.
                target = path + "?body-limit-probe=" + uuid.uuid4().hex
                upstream_request = ("POST", target.removeprefix("/webmail-api"))
                connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
                try:
                    connection.putrequest("POST", target)
                    connection.putheader("Content-Type", "application/json")
                    connection.putheader("Content-Length", str(limit + 1))
                    connection.endheaders()
                    response = connection.getresponse()
                    self.assertEqual(response.status, 413)
                    response.read()
                    self.assertNotIn(upstream_request, self.started)
                finally:
                    connection.close()

    def test_headerless_get_and_small_post_still_proxy(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            connection.request("GET", "/webmail-api/api/team/bootstrap")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()), {"path": "/api/team/bootstrap", "bytes": 0})
        finally:
            connection.close()
        self.assertEqual(self.request("POST", "/webmail-api/api/team/posts", 2)[0], 200)

    def test_upload_rejects_larger_declared_and_chunked_bodies(self):
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                self.assertEqual(self.request("POST", "/webmail-api/api/team/files", 7 * 1024 * 1024 + 1, chunked=chunked)[0], 413)

    def test_ordinary_routes_keep_exact_256kib_limit_for_declared_and_chunked_bodies(self):
        self.assertEqual(self.request("POST", "/webmail-api/api/team/posts", 256 * 1024)[0], 200)
        for chunked in (False, True):
            for method, path in [("POST", "/webmail-api/api/team/posts"),
                                 ("POST", "/webmail-api/api/send"),
                                 ("GET", "/webmail-api/api/team/files"),
                                 ("PUT", "/webmail-api/api/team/files"),
                                 ("POST", "/webmail-api/api/team/files/"),
                                 ("POST", "/webmail-api/api/team/files/00000000-0000-0000-0000-000000000000/delete")]:
                with self.subTest(method=method, path=path, chunked=chunked):
                    self.assertEqual(self.request(method, path, 256 * 1024 + 1, chunked=chunked)[0], 413)


if __name__ == "__main__":
    unittest.main(verbosity=2)
