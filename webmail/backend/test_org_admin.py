import base64
import json
import unittest
from unittest.mock import Mock, patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

import org_admin as admin
from mailstore import MailError


def org(domain, name="Client", tags=None, active="1", **fields):
    return {"domain_name": domain, "description": name, "active_int": active, "backupmx_int": 0,
            "relay_all_recipients_int": 0, "relay_unknown_only_int": 0,
            "tags": [admin.TENANT_TAG] if tags is None else tags, **fields}


def box(address, active="1", **fields):
    return {"username": address, "domain": address.split("@")[1], "name": "Contact", "quota": admin.MIB,
            "active_int": active, "authsource": "mailcow", "attributes": {"shared": "0"}, **fields}


class TenantManagement(unittest.TestCase):
    domain = "first-customer.dk"
    second = "second-customer.dk"

    def setUp(self):
        self.db = {
            "get/domain/" + self.domain: org(self.domain),
            "get/domain/" + self.second: org(self.second),
            "get/admin/all": [{"username": "admin"}], "get/domain-admin/all": {},
        }
        self.writes = []
        self.native = self.use_patch(admin, "_native", side_effect=self.request)
        self.txt = self.use_patch(admin, "_dns_values", return_value=set())
        key = Mock()
        key.read_bytes.return_value = b"k" * 48
        self.use_patch(admin, "DNS_KEY", new=key)

    def use_patch(self, obj, name, **options):
        p = patch.object(obj, name, **options)
        self.addCleanup(p.stop)
        return p.start()

    def request(self, path, data=None):
        if path.startswith("get/"):
            return self.db.get(path, {})
        self.writes.append((path, data))
        if path == "add/domain":
            domain = data["domain"]
            self.db["get/domain/" + domain] = org(domain, name=data["description"], tags=data["tags"])
            return [{"type": "success", "msg": ["dkim_added", domain]},
                    {"type": "success", "msg": ["domain_added", domain]}]
        if path == "add/mailbox":
            addr = data["local_part"] + "@" + data["domain"]
            if "get/mailbox/" + addr in self.db:
                return [{"type": "danger", "msg": ["object_exists", addr]}]
            self.db["get/mailbox/" + addr] = box(addr, quota=data["quota"] * admin.MIB)
            return [{"type": "success", "msg": ["mailbox_added", addr]}]
        if path == "edit/mailbox":
            addr = data["items"][0]
            if "active" in data["attr"]:
                self.db["get/mailbox/" + addr]["active_int"] = data["attr"]["active"]
            return [{"type": "success", "msg": ["mailbox_modified", addr]}]
        self.fail("Unexpected native path")

    def test_only_explicitly_managed_local_domains_and_existing_veyro(self):
        self.db["get/domain/all"] = [
            org(self.domain), org("veyro.dk", "Veyro", tags=[]), org("backup.dk", backupmx_int="1"),
            org("hidden.dk", tags=[]), org("review.test"), org("relay.dk", relay_unknown_only_int=1),
            org(self.second, active="0"), org("broken.dk", tags=admin.TENANT_TAG),
        ]
        self.assertEqual([item["domain"] for item in admin.organizations()], ["veyro.dk", self.domain, self.second])
        self.assertFalse(admin.organizations()[-1]["active"])

    def test_domain_proof_is_time_and_domain_bound_then_creation_retries_without_mutation(self):
        domain = "new-customer.dk"
        with patch.object(admin.time, "time", return_value=86400 * 50):
            challenge = admin.dns_challenge(domain)
            wrong_domain = admin.dns_challenge(self.domain)
        self.assertEqual(challenge["name"], "_veyro-mail.new-customer.dk")
        with patch.object(admin.time, "time", return_value=86400 * 51):
            self.txt.return_value = {json.dumps(wrong_domain["value"])}
            with self.assertRaises(admin.DomainProofRequired) as fail:
                admin.create_organization(domain, "Customer")
            self.assertEqual(fail.exception.challenge["type"], "TXT")
            self.assertFalse(self.writes)
            self.txt.return_value = {json.dumps(challenge["value"])}
            made = admin.create_organization(domain, "Customer")
            self.assertEqual(made, {"domain": domain, "name": "Customer", "active": True})
            self.assertEqual(self.writes[0][1]["dkim_selector"], "dkim")
            self.assertEqual(self.writes[0][1]["key_size"], 2048)
            self.txt.return_value = set()
            self.assertEqual(admin.create_organization(domain, "Customer"), made)
            self.assertEqual(len(self.writes), 1)
        self.db.pop("get/domain/" + domain)
        with patch.object(admin.time, "time", return_value=86400 * 53):
            self.txt.return_value = {json.dumps(challenge["value"])}
            with self.assertRaises(admin.DomainProofRequired):
                admin.create_organization(domain, "Customer")

    def test_alias_domains_and_other_tenant_fallback_never_expose_mailboxes(self):
        self.db["get/domain/alias.dk"] = org(self.domain)
        with self.assertRaises(MailError) as denied:
            admin.mailboxes("alias.dk")
        self.assertEqual(denied.exception.status, 404)
        self.db["get/mailbox/reduced/" + self.domain] = [box("a@" + self.domain), box("secret@" + self.second)]
        with self.assertRaises(MailError) as denied:
            admin.mailboxes(self.domain)
        self.assertEqual(denied.exception.status, 503)

    def test_backend_returns_only_management_fields_for_ordinary_mailboxes(self):
        domain = "veyro.dk"
        self.db["get/domain/" + domain] = org(domain, tags=[])
        self.db["get/domain-admin/all"] = [{"username": "native@" + domain}]
        self.db["get/mailbox/reduced/" + domain] = [box("marcus@" + domain, name="Marcus", password="hidden"),
            box("native@" + domain), box("efe@" + domain, active=0), box("shared@" + domain, attributes={"shared": "1"}),
            box("remote@" + domain, authsource="ldap")]
        efe, marcus = admin.mailboxes(domain)
        self.assertFalse(efe["active"])
        self.assertEqual(marcus, {"address": "marcus@veyro.dk", "name": "Marcus", "active": True,
                                  "quotaMiB": 1, "protected": True})

    def test_unsafe_writes_rejected(self):
        self.db["get/domain-admin/all"] = [{"username": "domain-admin@" + self.domain}]
        for domain in ["gmail.com/a", "b.example", "replay.test", "mail.veyro.dk", "unknown.dk", "Kunde.dk"]:
            with self.subTest(domain=domain), self.assertRaises(MailError):
                admin.create_mailbox(domain, "box", "User", "temporary")
        for value in ["{SHA512}hashed", "line\nbreak", "0", "x"*73, "\ud800", "x\0", "x\ry"]:
            with self.assertRaises(MailError):
                admin.create_mailbox(self.domain, "box", "User", value)
        for local in ["postmaster", "domain-admin", "@other.dk", "x..x", "Kim"]:
            with self.assertRaises(MailError):
                admin.create_mailbox(self.domain, local, "Name", "temporary")
        with self.assertRaises(MailError):
            admin.set_mailbox_active(self.domain, "a@" + self.second, False)
        with self.assertRaises(MailError):
            admin.set_mailbox_active("veyro.dk", "MARCUS@veyro.dk", False)
        with self.assertRaises(MailError):
            admin.set_mailbox_active(self.domain, "domain-admin@" + self.domain, False)
        self.assertFalse(self.writes)

    def test_create_and_pause_one_mailbox_with_readback_and_retry(self):
        address = "contact@" + self.domain
        made = admin.create_mailbox(self.domain, "contact", "Contact", "unique-secret!", 128)
        self.assertEqual(made["quotaMiB"], 128)
        self.assertNotIn("secret", repr(made))
        with self.assertRaises(MailError) as conflict:
            admin.create_mailbox(self.domain, "contact", "Other", "replacement")
        self.assertEqual(conflict.exception.status, 409)
        row = self.db["get/mailbox/" + address]
        row["attributes"]["attribute_hash"] = "template-hash"
        self.assertFalse(admin.set_mailbox_active(self.domain, address, False)["active"])
        self.assertEqual(self.writes[-1][1], {"items": [address], "attr": {"active": 0, "attribute_hash": "template-hash"}})
        calls = len(self.writes)
        self.assertFalse(admin.set_mailbox_active(self.domain, address, False)["active"])
        self.assertEqual(len(self.writes), calls)
        self.assertTrue(admin.set_mailbox_active(self.domain, address, True)["active"])
        self.db["get/domain/" + self.domain]["active_int"] = "0"
        with self.assertRaises(MailError):
            admin.create_mailbox(self.domain, "paused", "Paused", "temporary")

    def test_dns_onboarding_reports_only_valid_public_key_and_selected_domain(self):
        path = "get/dkim/" + self.domain
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public_bytes = key.public_key().public_bytes(serialization.Encoding.DER,
                                                     serialization.PublicFormat.SubjectPublicKeyInfo)
        public = base64.b64encode(public_bytes).decode("ascii")
        self.db[path] = {"dkim_selector": "dkim", "pubkey": public, "privkey": "secret", "dkim_txt": "untrusted"}
        records = admin.domain_dns(self.domain)
        self.assertEqual(records["dkim"], {"name": "dkim._domainkey." + self.domain,
                                           "value": "v=DKIM1;k=rsa;t=s;s=email;p=" + public})
        self.assertEqual(records["mx"], {"name": self.domain, "priority": 10, "value": "post.veyro.dk"})
        self.assertNotIn("secret", str(records))
        secret = key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
                                   serialization.NoEncryption())
        self.db[path]["pubkey"] = base64.b64encode(secret).decode()
        self.assertIsNone(admin.domain_dns(self.domain)["dkim"])
        self.db["get/domain/aliased.dk"] = org(self.domain)
        with self.assertRaises(MailError):
            admin.domain_dns("aliased.dk")

    def test_password_reset_preserves_native_fields_and_accepts_existing_punctuation(self):
        address = "accounts!payable@" + self.domain
        self.db["get/mailbox/" + address.replace("!", "%21")] = box(address, attributes={"attribute_hash": "saved"})
        result = admin.reset_password(self.domain, address, "initial-test-value")
        self.assertEqual(result["address"], address)
        self.assertEqual(self.writes, [("edit/mailbox", {"items": [address], "attr": {
            "password": "initial-test-value", "password2": "initial-test-value", "attribute_hash": "saved",
        }})])
        self.assertNotIn("initial-test-value", str(result))
        for value in ["{SHA512}hash", "line\nbreak", "0", "x"*73, "\ud800", "x\0", "x\ry"]:
            with self.subTest(value=value), self.assertRaises(MailError):
                admin.reset_password(self.domain, address, value)
        self.assertEqual(len(self.writes), 1)


class GrantRegistry(unittest.TestCase):
    def setUp(self):
        self.config = {"host": "127.0.0.1", "port": 13306, "user": "veyro_org_roles",
                       "database": "mailcow", "password": "private-db-value"}
        secret = Mock()
        secret.read_text.side_effect = lambda *_: json.dumps(self.config)
        patcher = patch.object(admin, "ROLE_CONFIG", new=secret)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(admin.pymysql, "connect")
        self.connect = patcher.start()
        self.addCleanup(patcher.stop)
        self.cursor = self.connect.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value

    def test_exact_row_identity_and_parameterized_lookup(self):
        address = "real+staff@client.dk"
        self.cursor.description = ("mailbox",)
        self.cursor.fetchall.return_value = (("other@client.dk",),)
        self.assertFalse(admin.has_role(address))
        query, args = self.cursor.execute.call_args.args
        self.assertNotIn(address, query)
        self.assertEqual(args, (address,))
        self.cursor.fetchall.return_value = ((address,),)
        self.assertTrue(admin.has_role(address))

    def test_readback_required_and_only_duplicate_insert_is_retryable(self):
        address = "retry@client.dk"
        self.cursor.description = ("mailbox",)
        self.cursor.fetchall.return_value = ((address,),)
        self.cursor.execute.side_effect = [admin.pymysql.IntegrityError(1062, "duplicate"), None]
        admin._change_role(address, True)
        self.cursor.execute.side_effect = admin.pymysql.OperationalError(1644, "private trigger message")
        with self.assertRaises(MailError) as rejected:
            admin._change_role(address, True)
        self.assertEqual(rejected.exception.status, 409)
        self.assertNotIn("private trigger message", rejected.exception.message)
        self.cursor.execute.side_effect = None
        with self.assertRaises(MailError) as stale:
            admin._change_role(address, False)
        self.assertEqual(stale.exception.status, 503)

    def test_nonlocal_or_alternate_principal_cannot_open_a_connection(self):
        for field, value in [("host", "external.dk"), ("user", "root"), ("port", "3306")]:
            with self.subTest(field=field), patch.dict(self.config, {field: value}), self.assertRaises(MailError):
                admin.has_role("user@client.dk")
        self.connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
