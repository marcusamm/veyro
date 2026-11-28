"""Synthetic companies only; no broker network, mail delivery or production DB."""

import base64
from concurrent.futures import ThreadPoolExecutor
import io
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import uuid
import zipfile

from flask import Flask, g, jsonify, request

from mailstore import MailError
import team

os.environ.setdefault("WEBMAIL_ORIGIN", "https://mail.veyro.dk")
os.environ.setdefault("WEBMAIL_STAFF", "staff@example.test")
import app as webmail


class TeamTests(unittest.TestCase):
    alice = "alice@first.example"
    bob = "bob@first.example"
    admin = "manager@first.example"
    outsider = "owner@second.example"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.database = Path(self.temp.name) / "private" / "team.sqlite3"
        self.store = team.Store(self.database)
        self.patch(team, "STORE", self.store)
        self.members = {self.alice, self.bob, self.admin, self.outsider}
        self.managers = {self.admin, self.outsider}
        self.broker = self.patch(team.org_admin_client, "call", side_effect=self.directory)
        self.app = Flask(__name__)
        self.app.config["TESTING"] = True

        @self.app.before_request
        def auth():
            g.session = SimpleNamespace(email=request.headers.get("Test-Actor", self.alice))

        @self.app.errorhandler(MailError)
        def error(exc):
            return jsonify(error=exc.message), exc.status

        self.limits = []
        team.install(self.app, lambda *args: self.limits.append(args))
        self.client = self.app.test_client()

    def patch(self, obj, field, *args, **kwargs):
        p = patch.object(obj, field, *args, **kwargs)
        self.addCleanup(p.stop)
        return p.start()

    def directory(self, path, data, *, actor):
        self.assertEqual((path, data), ("/team/directory", {}))
        domain = actor.split("@")[1]
        if actor not in self.members:
            raise MailError("No longer active", 403)
        return dict(email=actor, domain=domain, companyName="Synthetic company",
                    canManage=actor in self.managers,
                    members=[dict(email=m, name=m.split("@")[0]) for m in sorted(self.members)
                             if m.split("@")[1] == domain])

    def get(self, path, actor=None):
        return self.client.get("/api/team" + path, headers={"Test-Actor": actor or self.alice})

    def post(self, path, data=None, actor=None):
        return self.client.post("/api/team" + path, json=data if data is not None else {},
                                headers={"Test-Actor": actor or self.alice})

    def general(self, actor=None):
        response = self.get("/bootstrap", actor)
        self.assertEqual(response.status_code, 200)
        return next(row for row in response.json["channels"] if row["name"] == "Generelt")["id"]

    def send(self, channel, text="Synthetic message", actor=None, client_id=None):
        return self.post("/messages", dict(channel=channel, text=text, clientId=client_id or str(uuid.uuid4())), actor)

    def upload(self, name="handbook.txt", data=b"Synthetic company handbook", content_type="text/plain", actor=None):
        return self.post("/files", dict(name=name, data=base64.b64encode(data).decode(), contentType=content_type), actor)

    def test_bootstrap_uses_only_authenticated_domain_and_persists_private_database(self):
        first = self.get("/bootstrap").json
        second = self.get("/bootstrap", self.outsider).json
        self.assertEqual(first["domain"], "first.example")
        self.assertFalse(first["canManage"])
        self.assertEqual({m["email"] for m in first["members"]}, {self.alice, self.bob, self.admin})
        self.assertNotEqual(first["channels"][0]["id"], second["channels"][0]["id"])
        team.STORE = team.Store(self.database)
        self.assertEqual(self.get("/bootstrap").json["channels"], first["channels"])
        self.assertEqual(self.database.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.database.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.limits[0], (("team", "read", self.alice), 240, 60))

    def test_every_request_rechecks_membership_and_rejects_poisoned_broker_directory(self):
        channel = self.general()
        self.members.remove(self.alice)
        self.assertEqual(self.get("/bootstrap").status_code, 403)
        self.assertEqual(self.send(channel).status_code, 403)
        self.members.add(self.alice)
        normal = self.directory("/team/directory", {}, actor=self.alice)
        for override in ({"domain": "second.example"}, {"email": self.bob}, {"canManage": "true"},
                         {"members": normal["members"] + [{"email": self.outsider, "name": "Outsider"}]}):
            with patch.object(team.org_admin_client, "call", return_value={**normal, **override}):
                self.assertEqual(self.get("/bootstrap").status_code, 503)

    def test_channels_and_direct_messages_are_tenant_and_participant_isolated(self):
        company = self.general()
        self.assertEqual(self.send(company, actor=self.outsider).status_code, 404)
        self.assertEqual(self.get("/messages?channel=" + company, self.outsider).status_code, 404)
        self.assertEqual(self.post("/channels", {"type": "channel", "name": "News"}).status_code, 403)
        created = self.post("/channels", {"type": "channel", "name": "News"}, self.admin)
        self.assertEqual(created.status_code, 201)
        self.assertEqual(self.post("/channels", {"type": "channel", "name": "news"}, self.admin).status_code, 409)
        self.assertEqual(self.post("/channels", {"type": "direct", "members": [self.outsider]}).status_code, 400)
        data = {"type": "direct", "members": [self.bob]}
        private = self.post("/channels", data).json["channel"]["id"]
        duplicate = self.post("/channels", {"type": "direct", "members": [self.alice]}, self.bob)
        self.assertEqual(duplicate.json["channel"]["id"], private)
        sent = self.send(private).json["message"]
        self.assertEqual(self.get("/messages?channel=" + private, self.bob).status_code, 200)
        self.assertNotIn(private, [r["id"] for r in self.get("/bootstrap", self.admin).json["channels"]])
        for actor in (self.admin, self.outsider):
            self.assertEqual(self.get("/messages?channel=" + private, actor).status_code, 404)
            self.assertEqual(self.send(private, actor=actor).status_code, 404)
            self.assertEqual(self.post("/messages/" + sent["id"] + "/delete", actor=actor).status_code, 404)
        self.members.remove(self.bob)
        self.assertEqual(self.get("/messages?channel=" + private, self.bob).status_code, 403)
        self.assertEqual(self.get("/messages?channel=" + private).status_code, 200)
        self.assertEqual(self.send(private).status_code, 409)

    def test_message_retry_is_idempotent_even_after_restart_and_conflicts_are_rejected(self):
        channel = self.general()
        client_id = str(uuid.uuid4())
        first = self.send(channel, client_id=client_id)
        team.STORE = team.Store(self.database)
        retry = self.send(channel, client_id=client_id)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(first.json, retry.json)
        self.assertEqual(len(self.get("/messages?channel=" + channel).json["messages"]), 1)
        self.assertEqual(self.send(channel, "Different", client_id=client_id).status_code, 409)
        self.assertEqual(self.send(channel, client_id="reused-browser-string").status_code, 400)

    def test_concurrent_retries_create_only_one_message(self):
        channel = self.general()
        client_id = str(uuid.uuid4())

        def send_one(_):
            with self.app.test_client() as client:
                return client.post("/api/team/messages", json=dict(channel=channel, text="Retry", clientId=client_id)).json

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(send_one, range(8)))
        self.assertEqual(len({item["message"]["id"] for item in results}), 1)
        self.assertEqual(len(self.get("/messages?channel=" + channel).json["messages"]), 1)

    def test_pagination_literal_search_and_monotonic_read_receipts(self):
        channel = self.general()
        ids = [self.send(channel, f"Message {i}" if i else "Literal 100%_\\ value").json["message"]["id"] for i in range(55)]
        page = self.get("/messages?channel=" + channel, self.bob).json
        self.assertEqual([m["id"] for m in page["messages"]], ids[5:])
        older = self.get("/messages?channel=" + channel + "&before=" + page["nextBefore"]).json
        self.assertEqual([m["id"] for m in older["messages"]], ids[:5])
        self.assertIsNone(older["nextBefore"])
        found = self.get("/messages?channel=" + channel + "&q=100%25_").json["messages"]
        self.assertEqual([m["id"] for m in found], ids[:1])
        self.assertEqual(self.get("/bootstrap", self.bob).json["channels"][0]["unread"], 55)
        self.assertEqual(self.post("/read", {"channel": channel, "lastId": ids[20]}, self.bob).status_code, 200)
        self.post("/read", {"channel": channel, "lastId": ids[10]}, self.bob)
        self.assertEqual(self.get("/bootstrap", self.bob).json["channels"][0]["unread"], 34)
        elsewhere = self.general(self.outsider)
        foreign_id = self.send(elsewhere, actor=self.outsider).json["message"]["id"]
        self.assertEqual(self.post("/read", {"channel": channel, "lastId": foreign_id}, self.bob).status_code, 404)
        self.assertEqual(self.get("/messages?channel=" + channel + "&before=" + foreign_id).status_code, 404)

    def test_message_deletion_is_audited_and_tombstoned(self):
        channel = self.general()
        client_id = str(uuid.uuid4())
        message = self.send(channel, "Private original", client_id=client_id).json["message"]
        path = "/messages/" + message["id"] + "/delete"
        self.assertEqual(self.post(path, actor=self.bob).status_code, 403)
        self.assertEqual(self.post(path, actor=self.admin).status_code, 200)
        saved = self.get("/messages?channel=" + channel).json["messages"][0]
        self.assertTrue(saved["deleted"])
        self.assertEqual(saved["text"], "")
        self.assertTrue(self.send(channel, "Private original", client_id=client_id).json["message"]["deleted"])
        with sqlite3.connect(self.database) as db:
            self.assertEqual(db.execute("SELECT actor,action FROM audit ORDER BY seq DESC LIMIT 1").fetchone(), (self.admin, "message.delete"))

    def test_post_ownership_pinning_conflict_and_foreign_attachment_rejection(self):
        file_id = self.upload().json["file"]["id"]
        data = dict(title="Company news", body="Synthetic announcement", attachments=[file_id])
        post = self.post("/posts", data).json["post"]
        self.assertEqual(post["version"], 1)
        self.assertEqual(post["attachments"][0]["id"], file_id)
        path = "/posts/" + post["id"] + "/update"
        update = {**data, "version": 1, "pinned": True}
        self.assertEqual(self.post(path, update).status_code, 403)
        self.assertEqual(self.post(path, update, self.bob).status_code, 403)
        self.assertEqual(self.post(path, update, self.outsider).status_code, 404)
        result = self.post(path, update, self.admin)
        self.assertEqual(result.json["post"]["version"], 2)
        self.assertEqual(self.post(path, {**data, "version": 1}).status_code, 409)
        self.assertEqual(self.post(path, {**data, "version": 2, "pinned": True}).status_code, 200)
        foreign_file = self.upload(actor=self.outsider).json["file"]["id"]
        self.assertEqual(self.post("/posts", {**data, "attachments": [foreign_file]}).status_code, 404)
        self.assertEqual(self.get("/posts", self.outsider).json["posts"], [])
        self.assertEqual(self.post("/posts/" + post["id"] + "/delete", {"version": 2}).status_code, 409)
        self.assertEqual(self.post("/posts/" + post["id"] + "/delete", {"version": 3}).status_code, 200)
        self.assertEqual(self.get("/posts").json["posts"], [])

    def test_file_download_authorization_headers_deletion_and_post_unlink(self):
        uploaded = self.upload(name="medarbejderhåndbog.txt").json["file"]
        file_id = uploaded["id"]
        post = self.post("/posts", dict(title="Read this", body="Handbook", attachments=[file_id])).json["post"]
        response = self.get("/files/" + file_id, self.bob)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"Synthetic company handbook")
        self.assertIn("attachment;", response.headers["Content-Disposition"])
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("sandbox", response.headers["Content-Security-Policy"])
        self.assertEqual(self.get("/files/" + file_id, self.outsider).status_code, 404)
        self.assertEqual(self.post("/files/" + file_id + "/delete", actor=self.bob).status_code, 403)
        self.members.remove(self.bob)
        self.assertEqual(self.get("/files/" + file_id, self.bob).status_code, 403)
        self.assertEqual(self.post("/files/" + file_id + "/delete", actor=self.admin).status_code, 200)
        self.assertEqual(self.get("/files/" + file_id).status_code, 404)
        self.assertEqual(self.get("/posts").json["posts"][0]["attachments"], [])
        with sqlite3.connect(self.database) as db:
            self.assertIsNone(db.execute("SELECT data FROM files WHERE id=?", (file_id,)).fetchone()[0])

    def test_pinned_posts_remain_first_across_pages_with_literal_search_and_tenant_cursors(self):
        pinned = self.post("/posts", dict(title="Pinned 100% guide", body="Synthetic", pinned=True), self.admin).json["post"]
        ordinary = [self.post("/posts", dict(title=f"New post {i}", body="Synthetic")).json["post"]["id"] for i in range(54)]
        page = self.get("/posts").json
        self.assertEqual([p["id"] for p in page["posts"]], [pinned["id"], *reversed(ordinary[5:])])
        older = self.get("/posts?before=" + page["nextBefore"]).json
        self.assertEqual([p["id"] for p in older["posts"]], list(reversed(ordinary[:5])))
        self.assertIsNone(older["nextBefore"])
        self.assertEqual([p["id"] for p in self.get("/posts?q=100%25").json["posts"]], [pinned["id"]])
        self.assertEqual(self.get("/posts?before=" + pinned["id"], self.outsider).status_code, 404)

    def test_file_allowlist_size_magic_and_unsafe_names(self):
        for name, binary, mime, code in [
            ("../../secret.txt", b"hello", "text/plain", 400),
            ("bad\nname.txt", b"hello", "text/plain", 400),
            ("script.html", b"<script>x</script>", "text/html", 415),
            ("vector.svg", b"<svg></svg>", "image/svg+xml", 415),
            ("fake.pdf", b"<!doctype html>", "application/pdf", 415),
            ("binary.txt", b"\0content", "text/plain", 415),
            ("image.png", b"\x89PNG\r\n\x1a\nfixture", "image/jpeg", 415),
            ("huge.txt", b"a" * (team.FILE_LIMIT + 1), "text/plain", 413),
        ]:
            with self.subTest(name=name):
                self.assertEqual(self.upload(name, binary, mime).status_code, code)
        self.assertEqual(self.upload("allowed.pdf", b"%PDF-1.7\nfixture", "application/pdf").status_code, 201)
        self.assertEqual(self.post("/files", {"name": "x.txt", "contentType": "text/plain", "data": "not base64"}).status_code, 400)
        for macro in (False, True):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as doc:
                doc.writestr("[Content_Types].xml", "<Types/>")
                doc.writestr("word/document.xml", "<document/>")
                if macro:
                    doc.writestr("word/vbaProject.bin", "macro")
            result = self.upload("document.docx", buffer.getvalue(), team.TYPES[".docx"])
            self.assertEqual(result.status_code, 415 if macro else 201)
        with patch.object(team, "TENANT_FILE_LIMIT", 1):
            self.assertEqual(self.upload().status_code, 409)

    def test_unknown_tenant_actor_fields_and_invalid_payloads_never_select_scope(self):
        channel = self.general()
        for field in ("tenant", "domain", "email", "actor", "canManage"):
            self.assertEqual(self.post("/messages", {"channel": channel, "text": "x", "clientId": str(uuid.uuid4()), field: self.outsider}).status_code, 400)
        self.assertEqual(self.get("/posts?tenant=second.example").status_code, 400)
        for kind in ([], {}, None, 7):
            self.assertEqual(self.post("/channels", {"type": kind}).status_code, 400)
        self.assertEqual(self.send(channel, "\x00not text").status_code, 400)
        self.assertEqual(self.send(channel, "x" * 8001).status_code, 400)


class TeamGatewayTests(unittest.TestCase):
    """Use the real gateway/session gate with fake credential/broker truth only."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.database = Path(self.temp.name) / "private" / "team.sqlite3"
        self.patch(team, "STORE", team.Store(self.database))
        self.actor = "alice@first.example"
        self.generation = "a" * 64
        self.session = webmail.Session(self.actor, "synthetic-password", None, self.generation)
        self.sid = "synthetic-session-token"
        self.patch(webmail, "SESSIONS", {self.sid: self.session})
        self.patch(webmail, "LIMITS", {})
        remembered = self.patch(webmail, "REMEMBERED", MagicMock())
        remembered.get.return_value = None
        self.credential = self.patch(webmail, "credential_version", return_value=self.generation)
        original_read = Path.read_text
        self.token = "o" * 80
        self.patch(Path, "read_text", autospec=True, side_effect=lambda path, *a, **kw:
                   self.token if path.name == "origin-token" else original_read(path, *a, **kw))
        self.broker = self.patch(team.org_admin_client, "call", return_value=dict(
            email=self.actor, domain="first.example", canManage=False,
            members=[dict(email=self.actor, name="Synthetic Alice")]))
        self.headers = {"X-Veyro-Origin-Token": self.token, "X-Veyro-Client-IP": "192.0.2.7"}
        self.client = webmail.app.test_client()
        self.client.set_cookie(webmail.COOKIE, self.sid, domain="mail.veyro.dk", secure=True, httponly=True)

    def patch(self, obj, field, *args, **kwargs):
        p = patch.object(obj, field, *args, **kwargs)
        self.addCleanup(p.stop)
        return p.start()

    def post(self, path, data, headers=None):
        return self.client.post(path, base_url=webmail.ORIGIN, json=data, headers={
            **self.headers, "Origin": webmail.ORIGIN, "X-CSRF-Token": self.session.csrf, **(headers or {})})

    def test_origin_csrf_edge_auth_and_anonymous_sessions_fail_before_directory_or_storage(self):
        anonymous = webmail.app.test_client()
        self.assertEqual(anonymous.get("/api/team/bootstrap", base_url=webmail.ORIGIN, headers=self.headers).status_code, 401)
        self.assertEqual(self.client.get("/api/team/bootstrap", base_url=webmail.ORIGIN).status_code, 403)
        for endpoint in ("/api/team/messages", "/api/team/posts", "/api/team/files", "/api/team/read", "/api/team/channels"):
            for headers in ({"Origin": "https://attacker.example"}, {"X-CSRF-Token": "forged"}):
                self.assertEqual(self.post(endpoint, {}, headers).status_code, 403)
        self.broker.assert_not_called()
        self.assertFalse(self.database.exists())

    def test_credential_disable_and_rotation_revoke_existing_team_sessions(self):
        for version in (None, "b" * 64):
            with self.subTest(version=version):
                webmail.SESSIONS[self.sid] = webmail.Session(self.actor, "synthetic-password", None, self.generation)
                self.credential.return_value = version
                response = self.client.get("/api/team/bootstrap", base_url=webmail.ORIGIN, headers=self.headers)
                self.assertEqual(response.status_code, 401)
                self.assertNotIn(self.sid, webmail.SESSIONS)
        self.broker.assert_not_called()
        self.assertFalse(self.database.exists())

    def test_only_document_upload_gets_larger_request_limit_and_all_downloads_require_login(self):
        data = dict(name="large.txt", contentType="text/plain", data=base64.b64encode(b"a" * team.FILE_LIMIT).decode())
        uploaded = self.post("/api/team/files", data)
        self.assertEqual(uploaded.status_code, 201)
        file_id = uploaded.json["file"]["id"]
        self.assertEqual(self.post("/api/team/posts", {"title": "Huge", "body": "a" * (300 * 1024)}).status_code, 413)
        over_json = {**data, "data": "a" * (team.UPLOAD_LIMIT + 1)}
        self.assertEqual(self.post("/api/team/files", over_json).status_code, 413)
        anonymous = webmail.app.test_client()
        self.assertEqual(anonymous.get("/api/team/files/" + file_id, base_url=webmail.ORIGIN, headers=self.headers).status_code, 401)
        self.credential.return_value = None
        self.assertEqual(self.client.get("/api/team/files/" + file_id, base_url=webmail.ORIGIN, headers=self.headers).status_code, 401)


if __name__ == "__main__":
    unittest.main()
