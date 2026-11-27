"""Synthetic login fixtures: no live mailbox, real SQLite and Fernet storage."""
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from cryptography.fernet import Fernet

os.environ.setdefault("WEBMAIL_ORIGIN", "https://mail.veyro.dk")
os.environ.setdefault("WEBMAIL_STAFF", "staff@example.test")
import app as webmail
import remembered_sessions as persistence


class RememberedSessionsTest(unittest.TestCase):
    address = "remembered@example.test"
    password = "synthetic-mailbox-password"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.key = Path(self.tmp.name) / "key"
        self.key.write_bytes(Fernet.generate_key())
        self.db = Path(self.tmp.name) / "sessions.sqlite3"
        self.now = int(time.time())
        self.store = persistence.Store(self.db, self.key, clock=lambda: self.now)
        self.patch(webmail, "REMEMBERED", self.store)
        self.patch(webmail, "SESSIONS", {})
        self.patch(webmail, "KEY", Fernet(Fernet.generate_key()))
        self.patch(webmail, "LIMITS", {})
        self.versions = {self.address: "a" * 64, webmail.ORGANIZATION_ADMIN: "b" * 64}
        self.patch(webmail, "credential_version", side_effect=self.versions.get)
        self.patch(webmail, "administration_scope", side_effect=lambda address: ("platform", None)
                   if address == webmail.ORGANIZATION_ADMIN else ("none", None))
        self.imap = self.patch(webmail.mailstore, "connect", side_effect=lambda *a: MagicMock())
        original_read = Path.read_text
        self.token = "t" * 80
        self.patch(Path, "read_text", autospec=True, side_effect=lambda p, *a, **kw:
                   self.token if p.name == "origin-token" else original_read(p, *a, **kw))
        self.edge = {"X-Veyro-Origin-Token": self.token, "X-Veyro-Client-IP": "192.0.2.4"}
        self.http = webmail.app.test_client()

    def patch(self, obj, field, *args, **kwargs):
        p = patch.object(obj, field, *args, **kwargs)
        self.addCleanup(p.stop)
        return p.start()

    def post(self, path, data, csrf="", http=None):
        return (http or self.http).post(path, json=data, base_url=webmail.ORIGIN,
            headers={**self.edge, "Origin": webmail.ORIGIN, "X-CSRF-Token": csrf})

    def get(self, path="/api/session", http=None):
        return (http or self.http).get(path, base_url=webmail.ORIGIN, headers=self.edge)

    def login(self, remember=True, http=None, address=None):
        return self.post("/api/login", dict(email=address or self.address, password=self.password,
                                            rememberMe=remember), http=http)

    def sid(self, http=None):
        return (http or self.http).get_cookie(webmail.COOKIE, domain="mail.veyro.dk").value

    def replay(self, token):
        client = webmail.app.test_client()
        client.set_cookie(webmail.COOKIE, token, domain="mail.veyro.dk", secure=True, httponly=True)
        return client

    def restart(self):
        for session in webmail.SESSIONS.values():
            session.close()
        webmail.SESSIONS.clear()
        webmail.KEY = Fernet(Fernet.generate_key())
        webmail.REMEMBERED = persistence.Store(self.db, self.key, clock=lambda: self.now)

    def test_opt_in_has_secure_fixed_cookie_and_default_is_ephemeral(self):
        response = self.post("/api/login", dict(email=self.address, password=self.password))
        self.assertEqual(response.status_code, 200)
        cookie = response.headers["Set-Cookie"]
        self.assertNotIn("Max-Age", cookie)
        self.assertNotIn("Expires", cookie)
        self.assertFalse(self.db.exists())
        ordinary = self.sid()
        response = self.login()
        self.assertEqual(response.status_code, 200)
        cookie = response.headers["Set-Cookie"]
        for value in ("Max-Age=2592000", "HttpOnly", "Secure", "SameSite=Lax", "Path=/"):
            self.assertIn(value, cookie)
        self.assertNotIn("Domain=", cookie)
        self.assertEqual(self.get(http=self.replay(ordinary)).status_code, 401)
        record = self.store.get(self.sid())
        self.assertEqual(record["expires"] - record["issued"], persistence.LIFETIME)
        self.now += 24 * 3600
        self.assertNotIn("Set-Cookie", self.get().headers)
        self.assertEqual(self.store.get(self.sid())["expires"], record["expires"])

    def test_recreated_store_and_new_process_key_restore_cookie_and_csrf(self):
        response = self.login()
        token, csrf = self.sid(), response.json["csrfToken"]
        self.restart()
        self.imap.reset_mock()
        self.assertEqual(self.get().json["csrfToken"], csrf)
        self.assertEqual(webmail.SESSIONS[token].password(), self.password)
        self.imap.assert_not_called()  # Lazily connect for actual mailbox work.
        self.assertEqual(self.post("/api/logout", {}, csrf="forged").status_code, 403)
        self.assertIsNotNone(self.store.get(token))
        self.assertEqual(self.post("/api/logout", {}, csrf=csrf).status_code, 200)
        self.restart()
        self.assertEqual(self.get(http=self.replay(token)).status_code, 401)

    def test_new_python_process_restores_an_existing_browser_session(self):
        csrf = self.login().json["csrfToken"]
        fixture = dict(database=str(self.db), key=str(self.key), token=self.sid(),
                       email=self.address, generation=self.versions[self.address])
        code = '''
import json, sys
from pathlib import Path
from unittest.mock import patch
import app, remembered_sessions
f=json.load(sys.stdin)
app.REMEMBERED=remembered_sessions.Store(f['database'],f['key'])
client=app.app.test_client()
client.set_cookie(app.COOKIE,f['token'],domain='mail.veyro.dk',secure=True,httponly=True)
with patch.object(Path,'read_text',return_value='t'*80), patch.object(app,'credential_version',return_value=f['generation']), patch.object(app,'administration_scope',return_value=('none',None)):
 r=client.get('/api/session',base_url=app.ORIGIN,headers={'X-Veyro-Origin-Token':'t'*80,'X-Veyro-Client-IP':'192.0.2.4'})
 print(json.dumps({'status':r.status_code,'csrf':r.json.get('csrfToken')}))
'''
        result = subprocess.run([sys.executable, "-c", code], input=json.dumps(fixture),
                                text=True, capture_output=True, check=True, cwd=Path(__file__).parent,
                                timeout=15)
        self.assertEqual(json.loads(result.stdout), dict(status=200, csrf=csrf))

    def test_unchecked_login_does_not_survive_restart_or_idle_timeout(self):
        self.login(False)
        webmail.SESSIONS[self.sid()].touched -= webmail.IDLE + 1
        self.assertEqual(self.get().status_code, 401)
        self.login(False)
        self.restart()
        self.assertEqual(self.get().status_code, 401)
        self.assertFalse(self.db.exists())

    def test_fixed_expiry_and_idle_eviction_releases_imap_without_revoking(self):
        self.login()
        token = self.sid()
        current = webmail.SESSIONS[token]
        client = current.client
        current.touched -= webmail.IDLE + 1
        webmail.purge()
        client.shutdown.assert_called_once()
        self.assertEqual(current.secret, b"")
        self.assertNotIn(token, webmail.SESSIONS)
        self.assertEqual(self.get().status_code, 200)
        self.now += persistence.LIFETIME
        self.assertEqual(self.get().status_code, 401)
        self.assertIsNone(self.store.get(token))

    def test_stolen_forged_or_revoked_cookie_cannot_bypass_csrf(self):
        csrf = self.login().json["csrfToken"]
        token = self.sid()
        self.restart()
        self.assertEqual(self.post("/api/logout", {}).status_code, 403)
        self.assertEqual(self.get(http=self.replay(secrets.token_urlsafe(36))).status_code, 401)
        self.assertEqual(self.get(http=self.replay("not-a-token")).status_code, 401)
        self.assertEqual(self.post("/api/logout", {}, csrf=csrf).status_code, 200)
        self.assertEqual(self.get(http=self.replay(token)).status_code, 401)

    def test_replacement_with_unchecked_login_retires_durable_cookie(self):
        self.login()
        old = self.sid()
        self.assertEqual(self.login(False).status_code, 200)
        self.assertIsNone(self.store.get(old))
        self.restart()
        self.assertEqual(self.get(http=self.replay(old)).status_code, 401)

    def test_external_password_change_and_deactivation_revoke_persisted_sessions(self):
        for active in (True, False):
            with self.subTest(active=active):
                self.versions[self.address] = "a" * 64
                self.login()
                token = self.sid()
                self.restart()
                self.versions[self.address] = "c" * 64 if active else None
                self.assertEqual(self.get().status_code, 401)
                self.assertIsNone(self.store.get(token))

    def test_password_endpoint_retires_all_devices(self):
        other = webmail.app.test_client()
        self.login(http=other)
        other_token = self.sid(other)
        csrf = self.login().json["csrfToken"]
        self.patch(webmail.account, "change_password")
        response = self.post("/api/password", dict(currentPassword=self.password, newPassword="new-fixture-secret"), csrf)
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(self.store.get(other_token))
        self.restart()
        self.assertEqual(self.get(http=other).status_code, 401)

    def test_account_retirement_clears_remembered_and_ordinary_sessions(self):
        other = webmail.app.test_client()
        self.login(http=other)
        token = self.sid(other)
        self.login(False)
        self.patch(webmail, "revoke_ai_for_mailbox")
        webmail.retire_mailbox_access(self.address)
        self.assertEqual(webmail.SESSIONS, {})
        self.assertIsNone(self.store.get(token))
        self.assertEqual(self.get(http=other).status_code, 401)

    def test_database_contains_no_plaintext_token_password_email_or_csrf(self):
        csrf = self.login().json["csrfToken"]
        token = self.sid()
        raw = self.db.read_bytes()
        for secret in (token, self.password, self.address, csrf):
            self.assertNotIn(secret.encode(), raw)
        with sqlite3.connect(self.db) as db:
            digest, payload = db.execute("SELECT token_hash,payload FROM remembered_sessions").fetchone()
        self.assertEqual(digest, persistence.Store.token_hash(token))
        self.assertNotIn(self.password.encode(), payload)
        self.assertEqual(self.db.stat().st_mode & 0o777, 0o600)

    def test_strict_boolean_rejects_truthy_and_falsy_non_booleans(self):
        for value in (None, "false", "true", 0, 1, [], {}):
            with self.subTest(value=value):
                self.assertEqual(self.login(value).status_code, 422)
        self.imap.assert_not_called()

    def test_missing_invalid_and_unreadable_key_fail_closed(self):
        for mode in ("missing", "invalid", "unreadable"):
            with self.subTest(mode=mode):
                self.key.write_bytes(Fernet.generate_key())
                if mode == "missing":
                    self.key.unlink()
                if mode == "invalid":
                    self.key.write_bytes(b"invalid")
                if mode == "unreadable":
                    with patch.object(Path, "read_bytes", side_effect=PermissionError):
                        self.assertEqual(self.login().status_code, 503)
                else:
                    self.assertEqual(self.login().status_code, 503)
                self.assertEqual(webmail.SESSIONS, {})
                self.assertEqual(self.login(False).status_code, 200)
                webmail.SESSIONS.clear()

    def test_missing_key_blocks_even_cached_remembered_login(self):
        self.login()
        self.key.unlink()
        self.assertEqual(self.get().status_code, 503)

    def test_missing_key_does_not_block_unknown_or_expired_ordinary_cookie(self):
        self.login()  # A durable database already exists for another browser.
        other = webmail.app.test_client()
        self.login(False, http=other)
        self.restart()
        self.key.unlink()
        self.assertEqual(self.get(http=other).status_code, 401)
        self.assertEqual(self.get(http=self.replay(secrets.token_urlsafe(36))).status_code, 401)
        self.assertEqual(self.login(False, http=other).status_code, 200)

    def test_purge_cannot_retire_session_while_authentication_refreshes_it(self):
        self.login()
        token = self.sid()
        session = webmail.SESSIONS[token]
        session.touched -= webmail.IDLE + 1
        reading, release, purged = threading.Event(), threading.Event(), threading.Event()
        outcomes = []
        original_get = self.store.get

        def blocked_get(value):
            reading.set()
            if not release.wait(3):
                raise RuntimeError("Authentication fixture timed out")
            return original_get(value)

        def authenticate():
            outcomes.append(self.get(http=self.replay(token)).status_code)

        def cleanup():
            webmail.purge()
            purged.set()

        with patch.object(self.store, "get", side_effect=blocked_get):
            auth = threading.Thread(target=authenticate)
            auth.start()
            self.assertTrue(reading.wait(2))
            janitor = threading.Thread(target=cleanup)
            janitor.start()
            try:
                self.assertFalse(purged.wait(0.05))
            finally:
                release.set()
                auth.join(3)
                janitor.join(3)
        self.assertFalse(auth.is_alive() or janitor.is_alive())
        self.assertEqual(outcomes, [200])
        self.assertIs(webmail.SESSIONS.get(token), session)
        self.assertTrue(session.secret)

    def test_imap_rejection_revokes_the_durable_token(self):
        self.login()
        token = self.sid()
        self.restart()
        self.imap.side_effect = webmail.LoginError("synthetic rejected credential")
        self.assertEqual(self.get("/api/folders").status_code, 401)
        self.assertIsNone(self.store.get(token))
        self.assertEqual(webmail.SESSIONS, {})

    def test_restore_rechecks_row_after_concurrent_account_revocation(self):
        self.login()
        token = self.sid()
        self.restart()
        read, release = threading.Event(), threading.Event()
        outcomes = []
        original_get = self.store.get
        calls = 0

        def stale_hint(value):
            nonlocal calls
            record = original_get(value)
            calls += 1
            if calls == 1:
                read.set()
                if not release.wait(3):
                    raise RuntimeError("Restore fixture timed out")
            return record

        def authenticate():
            outcomes.append(self.get(http=self.replay(token)).status_code)

        with patch.object(webmail.REMEMBERED, "get", side_effect=stale_hint):
            auth = threading.Thread(target=authenticate)
            auth.start()
            self.assertTrue(read.wait(2))
            try:
                webmail.close_mailbox_sessions(self.address)
            finally:
                release.set()
                auth.join(3)
        self.assertFalse(auth.is_alive())
        self.assertEqual(outcomes, [401])
        self.assertEqual(webmail.SESSIONS, {})
        self.assertIsNone(self.store.get(token))

    def test_tampered_expiry_cannot_extend_the_authenticated_payload(self):
        self.login()
        token = self.sid()
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE remembered_sessions SET expires=expires+3600")
        self.restart()
        self.assertEqual(self.get().status_code, 401)
        self.assertIsNone(self.store.get(token))

    def test_bounded_records_and_expired_cleanup(self):
        with patch.object(persistence, "MAX_PER_ACCOUNT", 1):
            self.login()
            old = self.sid()
            # Replacing this browser does not consume another slot.
            self.assertEqual(self.login().status_code, 200)
            self.assertIsNone(self.store.get(old))
            self.assertEqual(self.login(http=webmail.app.test_client()).status_code, 503)
        with patch.object(persistence, "MAX_SESSIONS", 1):
            self.assertEqual(self.login(http=webmail.app.test_client(), address=webmail.ORGANIZATION_ADMIN).status_code, 503)
        self.now += persistence.LIFETIME
        self.store.purge()
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM remembered_sessions").fetchone()[0], 0)

    def test_storage_failure_still_retires_ram_and_prevents_role_mutation(self):
        customer = self.http
        remembered = webmail.app.test_client()
        self.login(http=remembered)
        remembered_session = webmail.SESSIONS[self.sid(remembered)]
        self.login(False)
        current = webmail.SESSIONS[self.sid()]
        admin = webmail.app.test_client()
        csrf = self.login(False, http=admin, address=webmail.ORGANIZATION_ADMIN).json["csrfToken"]
        self.patch(webmail.account, "Portal")
        broker = self.patch(webmail.org_admin_client, "call")
        with patch.object(self.store, "delete_account", side_effect=persistence.Unavailable):
            response = self.post("/api/admin/mailboxes/role", dict(domain="example.test", email=self.address,
                admin=True, currentPassword=self.password), csrf, admin)
        self.assertEqual(response.status_code, 503)
        broker.assert_not_called()
        self.assertEqual(current.secret, b"")
        self.assertEqual(remembered_session.secret, b"")
        self.assertEqual(self.get(http=customer).status_code, 401)
        # Storage recovery cannot grant this still-persisted login a new role:
        # the role mutation never happened when durable revocation failed.
        self.assertEqual(self.get(http=remembered).json["administrationRole"], "none")

    def test_logout_storage_failure_does_not_keep_password_in_ram(self):
        csrf = self.login().json["csrfToken"]
        current = webmail.SESSIONS[self.sid()]
        with patch.object(self.store, "delete", side_effect=persistence.Unavailable):
            self.assertEqual(self.post("/api/logout", {}, csrf).status_code, 503)
        self.assertEqual(webmail.SESSIONS, {})
        self.assertEqual(current.secret, b"")


if __name__ == "__main__":
    unittest.main()
