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
        self.roles = {}
        self.broker = self.patch(webmail.org_admin_client, "call", side_effect=self.provisioning)
        self.imap = self.patch(webmail.mailstore, "connect", side_effect=self.dovecot)
        self.http = webmail.app.test_client()

    def provisioning(self, path, data, *, actor):
        if path != "/access":
            raise AssertionError("Unexpected provisioning operation: " + path)
        domain = self.roles.get(actor)
        return {"role": "organization" if domain else "none", "domain": domain}

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

    def test_only_named_operator_can_request_organization_data(self):
        native = self.patch(webmail.account, "Portal")
        endpoint = "/api/admin/organizations"
        def browse():
            return self.http.get(endpoint, base_url=webmail.ORIGIN, headers=self.edge)
        self.assertEqual(browse().status_code, 401)
        for address in (self.employee, self.owner):
            result = self.login(address).json
            self.assertFalse(result["canManageOrganizations"])
            self.assertEqual(browse().status_code, 403)
            self.assertEqual(self.post(endpoint, {}, csrf=result["csrfToken"]).status_code, 403)
        native.assert_not_called()
        self.assertTrue(all(args[0][0] == "/access" for args in self.broker.call_args_list))
        self.broker.reset_mock()
        self.versions[webmail.ORGANIZATION_ADMIN] = "4" * 64
        self.assertTrue(self.login(webmail.ORGANIZATION_ADMIN).json["canManageOrganizations"])
        identify = native.return_value.__enter__.return_value.identify
        identify.side_effect = webmail.MailError("Application password", 403)
        self.assertEqual(browse().status_code, 403)
        self.broker.assert_not_called()
        identify.side_effect = None
        self.broker.side_effect = None
        self.broker.return_value = {"organizations": []}
        self.assertEqual(browse().json, {"organizations": []})
        self.broker.assert_called_once_with("/organizations/list", {}, actor=webmail.ORGANIZATION_ADMIN)
        identify.assert_called_with(webmail.ORGANIZATION_ADMIN, "fixture", allow_password_change=False)

    def test_domain_proof_and_status_require_operator_password_and_csrf(self):
        admin = webmail.ORGANIZATION_ADMIN
        self.versions[admin] = "4" * 64
        customer = webmail.app.test_client()
        self.login(self.owner, customer)
        csrf = self.login(admin).json["csrfToken"]
        self.patch(webmail.account, "Portal")
        broker = self.patch(webmail.org_admin_client, "call")
        organizations = "/api/admin/organizations"
        data = {"domain": "first.example", "name": "Fixture", "currentPassword": "fixture"}
        self.assertEqual(self.post(organizations, data).status_code, 403)
        self.assertEqual(self.post(organizations, {**data, "currentPassword": "wrong"}, csrf=csrf).status_code, 403)
        broker.assert_not_called()
        challenge = {"name": "_veyro-mail.first.example", "type": "TXT", "value": "fixture-proof"}
        broker.side_effect = webmail.org_admin_client.DomainProofRequired("Bekræft domænet.", challenge)
        response = self.post(organizations, data, csrf=csrf)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json["dnsChallenge"], challenge)
        broker.assert_called_once_with("/organizations/create", {"domain": "first.example", "name": "Fixture"}, actor=admin)
        status = "/api/admin/mailboxes/status"
        access = {"domain": "first.example", "email": self.owner, "active": False, "currentPassword": "fixture"}
        self.assertEqual(self.post(status, {**access, "email": admin}, csrf=csrf).status_code, 422)
        self.assertEqual(self.post(status, {**access, "domain": "second.example"}, csrf=csrf).status_code, 422)
        broker.side_effect = None
        broker.return_value = {"mailbox": {"address": self.owner, "name": "Fixture", "active": False,
                                           "quotaMiB": 1024, "protected": False, "organizationAdmin": False}}
        revoke = self.patch(webmail, "revoke_ai_for_mailbox")
        self.assertEqual(self.post(status, access, csrf=csrf).json["mailbox"]["email"], self.owner)
        revoke.assert_called_once_with(self.owner)
        self.assertEqual(customer.get("/api/session", base_url=webmail.ORIGIN, headers=self.edge).status_code, 401)
        self.assertEqual(self.http.get("/api/session", base_url=webmail.ORIGIN, headers=self.edge).status_code, 200)

    def test_tenant_admin_scope_checked_on_each_request_and_no_owner_only_writes(self):
        dom = self.owner.split("@")[1]
        self.roles[self.owner] = dom
        session = self.login(self.owner).json
        self.assertEqual((session["administrationRole"], session["administrationDomain"]), ("organization", dom))
        csrf = session["csrfToken"]
        native = self.patch(webmail.account, "Portal")
        def get(path):
            return self.http.get("/api/admin/" + path, base_url=webmail.ORIGIN, headers=self.edge)
        self.assertEqual(get("mailboxes?domain=second.example").status_code, 403)
        self.assertEqual(get("dns?domain=" + dom).status_code, 403)
        for path, values in [("organizations", {"name": "H", "domain": dom}),
                             ("mailboxes/role", {"domain": dom, "email": self.owner, "admin": True}),
                             ("mailboxes/status", {"domain": dom, "email": "worker@" + dom, "active": True}),
                             ("mailboxes/password", {"domain": "second.example", "email": self.neighbour,
                                                     "newPassword": "another-pass"})]:
            self.assertEqual(self.post("/api/admin/" + path, {**values, "currentPassword": "fixture"}, csrf=csrf).status_code, 403)
        native.assert_not_called()
        self.assertTrue(all(args[0][0] == "/access" for args in self.broker.call_args_list))
        native.return_value.__enter__.return_value.identify.side_effect = webmail.MailError("app password", 403)
        self.assertEqual(get("organizations").status_code, 403)
        native.return_value.__enter__.return_value.identify.side_effect = None
        self.roles.clear()
        self.assertEqual(get("organizations").status_code, 403)
        self.assertFalse(self.http.get("/api/session", base_url=webmail.ORIGIN, headers=self.edge).json["canManageOrganizations"])

    def test_scoped_reset_requires_actor_password_and_only_retires_target(self):
        dom = self.owner.split("@")[1]
        self.roles[self.owner] = dom
        email = "worker@" + dom
        self.versions[email] = "e" * 64
        worker, neighbour = webmail.app.test_client(), webmail.app.test_client()
        self.login(email, worker)
        self.login(self.neighbour, neighbour)
        csrf = self.login(self.owner).json["csrfToken"]
        self.patch(webmail.account, "Portal")
        revoke = self.patch(webmail, "revoke_ai_for_mailbox")
        path = "/api/admin/mailboxes/password"
        data = {"domain": dom, "email": email, "newPassword": "new-fixture-secret", "currentPassword": "fixture"}
        self.assertEqual(self.post(path, data).status_code, 403)
        self.assertEqual(self.post(path, {**data,"actor":webmail.ORGANIZATION_ADMIN}, csrf=csrf).status_code, 422)
        self.assertEqual(self.post(path, {**data,"currentPassword":"wrong"}, csrf=csrf).status_code, 403)
        self.assertEqual(self.post(path, {**data,"email":self.owner}, csrf=csrf).status_code, 422)
        record = dict(address=email, name="Employee", active=True, protected=False, organizationAdmin=False, quotaMiB=1024)
        def reset(endpoint, fields, *, actor):
            if endpoint == "/access":
                return self.provisioning(endpoint, fields, actor=actor)
            self.assertEqual(actor, self.owner)
            self.assertEqual((endpoint, fields), ("/mailboxes/password", {"domain": dom, "email": email, "password": data["newPassword"]}))
            return {"mailbox": record}
        self.broker.side_effect = reset
        response = self.post(path, data, csrf=csrf)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(data["newPassword"], response.get_data(as_text=True))
        revoke.assert_called_once_with(email)
        self.assertEqual(worker.get("/api/session", base_url=webmail.ORIGIN, headers=self.edge).status_code, 401)
        self.assertEqual(neighbour.get("/api/session", base_url=webmail.ORIGIN, headers=self.edge).status_code, 200)

    def test_role_change_requires_operator_and_recipient_signs_back_in(self):
        admin = webmail.ORGANIZATION_ADMIN
        self.versions[admin] = "4" * 64
        target = webmail.app.test_client()
        self.login(self.owner, target)
        csrf = self.login(admin).json["csrfToken"]
        self.patch(webmail.account, "Portal")
        data = dict(domain="first.example", email=self.owner, admin=True, currentPassword="fixture")
        path = "/api/admin/mailboxes/role"
        record = dict(address=self.owner, name="User", active=True, protected=False, organizationAdmin=True, quotaMiB=1024)
        self.broker.side_effect = None
        self.broker.return_value = {"mailbox": record}
        self.assertEqual(self.post(path, data, csrf=csrf).status_code, 200)
        self.broker.assert_called_with("/mailboxes/role", dict(domain=data["domain"],email=self.owner,admin=True), actor=admin)
        self.assertEqual(target.get("/api/session", base_url=webmail.ORIGIN, headers=self.edge).status_code, 401)
        self.login(self.owner, target)
        self.broker.side_effect = webmail.MailError("Rollen er gemt, men svaret gik tabt.", 503)
        self.assertEqual(self.post(path, data, csrf=csrf).status_code, 503)
        self.assertEqual(target.get("/api/session", base_url=webmail.ORIGIN, headers=self.edge).status_code, 401)

    def test_employee_mail_stays_available_during_broker_interruption(self):
        self.broker.side_effect = webmail.MailError("Provisioning service offline", 503)
        result = self.login(self.owner)
        self.assertEqual(result.status_code, 200)
        self.assertFalse(result.json["canManageOrganizations"])
        self.assertEqual(self.http.get("/api/admin/organizations", base_url=webmail.ORIGIN, headers=self.edge).status_code, 503)

    def test_uncertain_reset_only_retires_access_after_credential_changes(self):
        dom = self.owner.split("@")[1]
        self.roles[self.owner] = dom
        email = "employee@" + dom
        self.versions[email] = "e" * 64
        employee = webmail.app.test_client()
        self.login(email, employee)
        csrf = self.login(self.owner).json["csrfToken"]
        self.patch(webmail.account, "Portal")
        revoke = self.patch(webmail, "revoke_ai_for_mailbox")
        data = dict(domain=dom, email=email, newPassword="changed-fixture", currentPassword="fixture")
        committed = False
        def interrupted(path, fields, *, actor):
            if path == "/access":
                return self.provisioning(path, fields, actor=actor)
            if committed:
                self.versions[email] = "c" * 64
            raise webmail.MailError("Uafklaret svar.", 503)
        self.broker.side_effect = interrupted
        self.assertEqual(self.post("/api/admin/mailboxes/password", data, csrf=csrf).status_code, 503)
        revoke.assert_not_called()
        self.assertEqual(employee.get("/api/session", base_url=webmail.ORIGIN, headers=self.edge).status_code, 200)
        committed = True
        self.assertEqual(self.post("/api/admin/mailboxes/password", data, csrf=csrf).status_code, 503)
        revoke.assert_called_once_with(email)
        self.assertEqual(employee.get("/api/session", base_url=webmail.ORIGIN, headers=self.edge).status_code, 401)

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
