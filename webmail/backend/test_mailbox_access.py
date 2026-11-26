"""Verify tenant isolation across the real webmail gateway using synthetic accounts."""
import json
import os
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("WEBMAIL_ORIGIN", "https://mail.veyro.dk")
os.environ.setdefault("WEBMAIL_STAFF", "staff@example.test")
import app as webmail
read_file = webmail.Path.read_text


class MailboxAccessTest(unittest.TestCase):
    owner = "person@first.example"
    neighbour = "person@second.example"
    employee = "staff@example.test"

    def setUp(self):
        self.versions = {self.owner: "1" * 64, self.neighbour: "2" * 64, self.employee: "3" * 64}
        self.origin_token = "t" * 80
        self.edge = {"X-Veyro-Origin-Token": self.origin_token, "X-Veyro-Client-IP": "192.0.2.1"}
        self.config = dict(host="127.0.0.1", port=3306, user="fixture", password="fixture", database="fixture")
        self.patch(webmail.Path, "read_text", autospec=True, side_effect=self.fixture_file)
        self.patch(webmail, "STAFF", {self.employee})
        self.patch(webmail, "LIMITS", {})
        self.patch(webmail, "SESSIONS", {})
        self.patch(webmail.pymysql, "connect", side_effect=self.database)
        self.imap = self.patch(webmail.mailstore, "connect", side_effect=self.dovecot)
        self.http = webmail.app.test_client()

    def patch(self, obj, field, *args, **kwargs):
        p = patch.object(obj, field, *args, **kwargs)
        self.addCleanup(p.stop)
        return p.start()

    def fixture_file(self, path, *args, **kwargs):
        if path.name == "origin-token":
            return self.origin_token
        if path.name == "credential-version.json":
            return json.dumps(self.config)
        return read_file(path, *args, **kwargs)

    def database(self, **kwargs):
        db = MagicMock()
        cursor = db.__enter__.return_value.cursor.return_value.__enter__.return_value
        def select(sql, bind):
            self.assertIn("WHERE username=%s", sql)
            self.assertEqual(len(bind), 1)
            name = bind[0]
            cursor.fetchone.return_value = (name, self.versions[name]) if name in self.versions else None
            if name == "mismatch@example.test":
                cursor.fetchone.return_value = (self.owner, self.versions[self.owner])
        cursor.execute.side_effect = select
        return db

    def dovecot(self, name, password):
        if password != "fixture":
            raise webmail.LoginError("fixture rejection")
        client = MagicMock()
        client.fixture_name = name
        return client

    def post(self, path, data, http=None, csrf=""):
        return (http or self.http).post(path, json=data, base_url=webmail.ORIGIN,
                             headers={**self.edge, "Origin":webmail.ORIGIN, "X-CSRF-Token":csrf})

    def login(self, name, http=None, password="fixture"):
        return self.post("/api/login", dict(email=name, password=password), http)

    def test_active_customer_and_staff_have_distinct_capabilities(self):
        owner = self.login(self.owner.upper())
        self.assertEqual(owner.status_code, 200)
        self.assertEqual(owner.json["email"], self.owner)
        self.assertFalse(owner.json["canManageRecovery"])
        self.assertTrue(self.login(self.employee).json["canManageRecovery"])

    def test_rejected_password_and_ineligible_mailbox_share_response(self):
        bad = self.login(self.owner, password="incorrect")
        self.assertEqual(bad.status_code, 401)
        for address in ["notprovisioned@example.test", "native-mfa@example.test",
                        "disabled-domain@example.test", "mismatch@example.test", "user@example.test\r\nBAD"]:
            response = self.login(address)
            self.assertEqual(response.status_code, bad.status_code)
            self.assertEqual(response.json, bad.json)
            self.assertNotIn("Set-Cookie", response.headers)
        self.assertFalse(webmail.SESSIONS)
        self.assertEqual(len(webmail.ACCOUNT_LOCKS), 128)

    def test_folder_and_session_revocation_are_per_principal(self):
        neighbour = webmail.app.test_client()
        self.login(self.owner)
        self.login(self.neighbour, neighbour)
        fake_list = self.patch(webmail.mailstore, "folder_list", side_effect=lambda client: [client.fixture_name])
        result = self.http.get("/api/folders?email="+self.neighbour, base_url=webmail.ORIGIN, headers=self.edge)
        self.assertEqual(result.json["folders"], [self.owner])
        self.assertEqual(fake_list.call_count, 1)
        del self.versions[self.owner]
        self.assertEqual(self.http.get("/api/session",base_url=webmail.ORIGIN,headers=self.edge).status_code,401)
        self.assertEqual(neighbour.get("/api/session",base_url=webmail.ORIGIN,headers=self.edge).json["email"],self.neighbour)

    def test_recovery_stays_staff_only_and_public_response_is_uniform(self):
        csrf = self.login(self.owner).json["csrfToken"]
        portal = self.patch(webmail.account,"Portal")
        for slug, extra in [("start",{}),("confirm",dict(code="ABCDEF123456"))]:
            resp = self.post("/api/recovery/enroll/"+slug, dict(email="fallback@third.example",currentPassword="fixture",**extra),csrf=csrf)
            self.assertEqual(resp.status_code,403)
        portal.assert_not_called()
        queue = self.patch(webmail,"RECOVERY_REQUESTS")
        for mailbox in [self.owner,self.employee,"unknown@elsewhere.example"]:
            result = self.post("/api/recovery/request",dict(email=mailbox))
            self.assertEqual(result.status_code,202)
            self.assertEqual(result.json,{"ok":True})
        queue.put_nowait.assert_called_once_with(self.employee)

    def test_password_change_uses_native_authenticated_mailbox_and_revokes_its_sessions(self):
        second = webmail.app.test_client()
        neighbour = webmail.app.test_client()
        csrf = self.login(self.owner).json["csrfToken"]
        self.login(self.owner, second)
        self.login(self.neighbour, neighbour)
        native = self.patch(webmail.account,"change_password")
        result = self.post("/api/password",dict(currentPassword="fixture",newPassword="new-pass"),csrf=csrf)
        self.assertEqual(result.status_code,200)
        native.assert_called_once_with(self.owner,"fixture","new-pass")
        self.assertEqual(second.get("/api/session",base_url=webmail.ORIGIN,headers=self.edge).status_code,401)
        self.assertEqual(neighbour.get("/api/session",base_url=webmail.ORIGIN,headers=self.edge).status_code,200)


if __name__ == "__main__":
    unittest.main()
