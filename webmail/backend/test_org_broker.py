import unittest
from unittest.mock import patch
from urllib.parse import unquote

import org_broker
import org_admin
import org_admin_client
from mailstore import MailError
from test_org_admin import org, box


class BrokerBoundaryTests(unittest.TestCase):
    owner = "marcus@veyro.dk"
    tenant = "first-company.dk"
    other = "different-company.dk"

    def setUp(self):
        self.client = org_broker.app.test_client()
        self.manager = "manager@" + self.tenant
        self.colleague = "finance!dept@" + self.tenant
        self.employee = "staff@" + self.tenant
        self.outsider = "manager@" + self.other
        self.role_set = {self.manager, self.colleague, self.outsider}
        self.org_rows = {domain: org(domain) for domain in (self.tenant, self.other, "veyro.dk")}
        self.box_rows = {address: box(address) for address in self.role_set | {self.employee, self.owner}}
        self.native_admins = []
        self.mutations = []
        self.use_patch("has_role", side_effect=lambda address: address in self.role_set)
        self.use_patch("domain_roles", side_effect=lambda domain: {a for a in self.role_set if a.endswith("@" + domain)})
        self.use_patch("_change_role", side_effect=lambda address, enabled:
                       self.role_set.add(address) if enabled else self.role_set.discard(address))
        self.native = self.use_patch("_native", side_effect=self.native_request)

    def use_patch(self, name, **kwargs):
        p = patch.object(org_admin, name, **kwargs)
        self.addCleanup(p.stop)
        return p.start()

    def native_request(self, path, data=None):
        if path == "get/domain/all":
            return list(self.org_rows.values())
        if path.startswith("get/domain/"):
            return self.org_rows.get(path.split("/")[-1], {})
        if path in ("get/admin/all", "get/domain-admin/all"):
            return [{"username": address} for address in self.native_admins]
        if path.startswith("get/mailbox/reduced/"):
            return [value for value in self.box_rows.values() if value["domain"] == path.split("/")[-1]]
        if path.startswith("get/mailbox/"):
            return self.box_rows.get(unquote(path.split("/")[-1]), {})
        if path == "add/mailbox":
            address = data["local_part"] + "@" + data["domain"]
            self.mutations.append((path, address))
            self.box_rows[address] = box(address)
            return [{"type": "success", "msg": ["mailbox_added", address]}]
        if path == "edit/mailbox":
            address = data["items"][0]
            self.mutations.append((path, address))
            if "active" in data["attr"]:
                self.box_rows[address]["active_int"] = data["attr"]["active"]
                if not data["attr"]["active"]:
                    # Native role registry trigger on mailbox deactivation.
                    self.role_set.discard(address)
            return [{"type": "success", "msg": ["mailbox_modified", address]}]
        self.fail("Unexpected native call " + path)

    def post(self, actor, path, **data):
        return self.client.post(path, json=data, headers={"X-Veyro-Actor": actor} if actor else {})

    def test_arbitrary_native_paths_and_extra_fields_are_rejected(self):
        self.assertEqual(self.client.post("/api/v1/get/api-key/all", json={}).status_code, 404)
        with patch.object(org_broker.org_admin, "organizations") as fetch:
            response = self.post(self.owner, "/organizations/list", path_override="/api/v1/get/api-key/all")
            self.assertEqual(response.status_code, 400)
            fetch.assert_not_called()

    def test_status_only_forwards_the_selected_mailbox_and_requested_state(self):
        response = self.post(self.owner, "/mailboxes/status", domain=self.tenant, email=self.employee, active=False)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["mailbox"]["address"], self.employee)
        self.assertFalse(response.json["mailbox"]["active"])
        self.assertEqual(self.mutations, [("edit/mailbox", self.employee)])

    def test_upstream_exceptions_do_not_disclose_their_message(self):
        exception = RuntimeError("private-mailbox-password")
        with patch.object(org_broker.org_admin, "mailboxes", side_effect=exception):
            response = self.post(self.owner, "/mailboxes/list", domain=self.tenant)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(str(exception), response.get_data(as_text=True))

    def test_nonadmins_and_forged_actor_fields_have_no_access(self):
        self.assertEqual(self.post(None, "/organizations/list").status_code, 403)
        self.assertEqual(self.post(self.employee, "/access").json, {"role": "none", "domain": None})
        self.assertEqual(self.post(self.employee, "/organizations/list").status_code, 403)
        self.assertEqual(self.post(self.employee, "/organizations/list", actorEmail=self.owner).status_code, 400)
        self.assertFalse(self.mutations)

    def test_customer_sees_only_own_org_and_roles_and_only_ordinary_staff_are_editable(self):
        result = self.post(self.manager, "/organizations/list")
        self.assertEqual([row["domain"] for row in result.json["organizations"]], [self.tenant])
        self.assertNotIn(("get/domain/all",), [args for args, kwargs in self.native.call_args_list])
        self.assertEqual(self.post(self.colleague, "/access").json, {"role": "organization", "domain": self.tenant})
        rows = self.post(self.manager, "/mailboxes/list", domain=self.tenant).json["mailboxes"]
        self.assertEqual([(row["address"], row["protected"], row["organizationAdmin"]) for row in rows],
                         [(self.colleague, True, True), (self.manager, True, True), (self.employee, False, False)])
        response = self.post(self.manager, "/mailboxes/create", domain=self.tenant, localPart="sales",
                             name="Sales", password="initial-test-value")
        self.assertEqual(response.json["mailbox"]["address"], "sales@" + self.tenant)
        self.assertEqual(self.post(self.manager, "/mailboxes/password", domain=self.tenant, email=self.employee,
                                   password="another-test-value").status_code, 200)
        self.assertEqual(self.post(self.manager, "/mailboxes/status", domain=self.tenant, email=self.employee,
                                   active=False).status_code, 200)

    def test_customer_cannot_escape_domain_or_manage_other_admins_even_if_ineligible(self):
        self.box_rows[self.colleague]["attributes"]["imap_access"] = 0
        for path, data in [
            ("/mailboxes/list", {"domain": self.other}),
            ("/mailboxes/create", {"domain": self.other, "localPart": "x", "name": "X", "password": "x"}),
            ("/organizations/create", {"domain": self.tenant, "name": "x"}),
            ("/organizations/dns", {"domain": self.tenant}),
            ("/mailboxes/role", {"domain": self.tenant, "email": self.employee, "admin": True}),
            ("/mailboxes/status", {"domain": self.tenant, "email": self.employee, "active": True}),
            ("/mailboxes/status", {"domain": self.tenant, "email": self.manager, "active": False}),
            ("/mailboxes/password", {"domain": self.tenant, "email": self.colleague, "password": "new"}),
            ("/mailboxes/password", {"domain": self.other, "email": self.outsider, "password": "new"}),
            ("/mailboxes/password", {"domain": self.tenant, "email": self.outsider, "password": "new"}),
            ("/mailboxes/status", {"domain": self.tenant, "email": "postmaster@" + self.tenant, "active": False}),
        ]:
            with self.subTest(path=path, data=data):
                self.assertIn(self.post(self.manager, path, **data).status_code, (400, 403))
        self.assertFalse(self.mutations)

    def test_platform_grant_revoke_and_native_deactivation(self):
        for address, domain in [(self.employee, self.tenant), ("efe@veyro.dk", "veyro.dk")]:
            self.box_rows[address] = box(address)
            grant = {"domain": domain, "email": address, "admin": True}
            for _ in range(2):
                self.assertTrue(self.post(self.owner, "/mailboxes/role", **grant).json["mailbox"]["organizationAdmin"])
            self.assertEqual(self.post(address, "/access").json, {"role": "organization", "domain": domain})
            self.assertFalse(self.post(self.owner, "/mailboxes/role", **{**grant,"admin":False}).json["mailbox"]["organizationAdmin"])
            self.assertEqual(self.post(address, "/organizations/list").status_code, 403)
        self.post(self.owner, "/mailboxes/status", domain=self.tenant, email=self.manager, active=False)
        self.post(self.owner, "/mailboxes/status", domain=self.tenant, email=self.manager, active=True)
        self.assertEqual(self.post(self.manager, "/organizations/list").status_code, 403)
        self.assertEqual(self.post(self.owner, "/mailboxes/role", domain="veyro.dk", email=self.owner, admin=True).status_code, 403)

    def test_actor_and_target_must_still_be_active_ordinary_hosted_mailboxes(self):
        self.box_rows[self.manager]["attributes"]["force_tfa"] = "1"
        self.assertEqual(self.post(self.manager, "/access").json["role"], "none")
        self.box_rows[self.manager] = box(self.manager)
        self.org_rows[self.tenant]["backupmx_int"] = 1
        self.assertEqual(self.post(self.manager, "/access").json["role"], "none")
        self.org_rows[self.tenant] = org(self.tenant)
        for fields in ({"active_int": 0}, {"kind": "location"}, {"authsource": "ldap"},
                       {"attributes": {"shared": "1"}}, {"attributes": {"sogo_access": "0"}}):
            self.box_rows[self.employee] = box(self.employee, **fields)
            response = self.post(self.owner, "/mailboxes/role", domain=self.tenant, email=self.employee, admin=True)
            self.assertIn(response.status_code, (404, 409))
            self.assertNotIn(self.employee, self.role_set)
        self.native_admins.append(self.manager)
        self.assertEqual(self.post(self.manager, "/access").json["role"], "none")

    def test_role_registry_failure_blocks_customer_writes(self):
        with patch.object(org_admin, "has_role", side_effect=MailError("Unavailable", 503)):
            result = self.post(self.manager, "/mailboxes/password", domain=self.tenant, email=self.employee, password="secret")
        self.assertEqual(result.status_code, 503)
        self.assertFalse(self.mutations)

    def test_private_client_sends_actor_in_trusted_header_only(self):
        with patch.object(org_admin_client, "BrokerConnection") as connection:
            response = connection.return_value.getresponse.return_value
            response.status = 200
            response.read.return_value = b'{"role":"none","domain":null}'
            org_admin_client.call("/access", {}, actor=self.employee)
            method, path, body, headers = connection.return_value.request.call_args.args
            self.assertEqual((method, path, body), ("POST", "/access", b"{}"))
            self.assertEqual(headers["X-Veyro-Actor"], self.employee)

    def test_team_directory_is_live_minimal_and_actor_scoped_even_for_platform_owner(self):
        result = self.post(self.employee, "/team/directory")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json["domain"], self.tenant)
        self.assertFalse(result.json["canManage"])
        self.assertEqual({m["email"] for m in result.json["members"]}, {self.manager, self.colleague, self.employee})
        self.assertTrue(all(set(m) == {"email", "name"} for m in result.json["members"]))
        self.assertTrue(self.post(self.manager, "/team/directory").json["canManage"])
        owner = self.post(self.owner, "/team/directory").json
        self.assertEqual(owner["domain"], "veyro.dk")
        self.assertEqual(owner["members"], [{"email": self.owner, "name": "Contact"}])
        self.assertEqual(self.post(self.owner, "/team/directory", domain=self.tenant).status_code, 400)
        self.box_rows[self.employee]["active_int"] = 0
        self.assertEqual(self.post(self.employee, "/team/directory").status_code, 403)
        self.assertNotIn(self.employee, {m["email"] for m in self.post(self.manager, "/team/directory").json["members"]})

    def test_team_directory_rejects_disabled_domain_and_upstream_cross_domain_fallback(self):
        self.org_rows[self.tenant]["active_int"] = 0
        self.assertEqual(self.post(self.employee, "/team/directory").status_code, 403)
        self.org_rows[self.tenant]["active_int"] = 1
        self.box_rows[self.employee]["attributes"]["force_pw_update"] = "1"
        self.assertEqual(self.post(self.employee, "/team/directory").status_code, 403)
        self.box_rows[self.employee] = box(self.employee)
        original = self.native_request
        self.native.side_effect = lambda path, data=None: [box(self.outsider)] if path == "get/mailbox/reduced/" + self.tenant else original(path, data)
        self.assertEqual(self.post(self.employee, "/team/directory").status_code, 503)


if __name__ == "__main__":
    unittest.main()
