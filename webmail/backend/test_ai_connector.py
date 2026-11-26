"""Exercise the delegated-access boundary without connecting to employee mail."""
import hashlib
import json
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlsplit

from cryptography.fernet import Fernet
from flask import Flask, g
import ai_connector as ai


class ConnectorTest(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        app.testing = True
        self.key = Fernet(Fernet.generate_key())
        self.address = "owner@example.test"
        self.version = "credential-version-one"
        self.cb = "https://claude.ai/api/mcp/auth_callback"
        self.verifier = "v" * 48
        self.provider = "claude"

        @app.before_request
        def fake_authenticated_gateway():
            g.ip = "127.0.0.1"
            g.session = SimpleNamespace(email=self.address, generation=self.version, secret=self.key.encrypt(b"fixture"))

        self.revoke_mailbox = ai.install(app, lambda address: self.version, lambda *args: None, self.key)
        self.http = app.test_client()
        self.sign = patch.object(ai, "signing_key", return_value=b"fixture-signing-key")
        self.sign.start()
        self.addCleanup(self.sign.stop)

    def register(self, callback=None, method="none"):
        return self.http.post("/api/ai/protocol/register", json={
            "redirect_uris": [callback or self.cb], "token_endpoint_auth_method": method})

    def params(self, cid, **overrides):
        return {"client_id": cid, "redirect_uri": self.cb, "state": "opaque state", "response_type": "code",
                "resource": ai.RESOURCE, "scope": "mail.read mail.draft", "code_challenge_method": "S256",
                "code_challenge": ai.encode(hashlib.sha256(self.verifier.encode()).digest()), **overrides}

    def start(self, params, scopes):
        response = self.http.post("/api/ai/authorize", json={"action":"allow", "params":params, "scopes":scopes})
        self.assertEqual(response.status_code, 200, response.json)
        url = urlsplit(response.json["redirect"])
        parsed = parse_qs(url.query)
        self.assertEqual(parsed["iss"], [ai.ISSUER])
        self.assertEqual(parsed["state"], [params["state"]])
        return parsed["code"][0]

    def exchange(self, cid, code, **overrides):
        data = dict(grant_type="authorization_code", code=code, client_id=cid, redirect_uri=self.cb,
                    code_verifier=self.verifier, resource=ai.RESOURCE)
        return self.http.post("/api/ai/protocol/token", data={**data, **overrides})

    def grant(self, scopes):
        cid = self.register().json["client_id"]
        return self.exchange(cid, self.start(self.params(cid), scopes)).json["access_token"]

    def rpc(self, token, method, params=None):
        return self.http.post("/api/ai/protocol/mcp", json=dict(jsonrpc="2.0", id=1, method=method, params=params or {}),
                              headers={"Authorization": "Bearer " + token})

    def test_registration_and_authorization_bind_exact_callback(self):
        for uri in ["https://claude.ai@other.test/api/mcp/auth_callback", self.cb + "?redirect=bad", "http://other.test/oauth/callback"]:
            self.assertEqual(self.register(uri).status_code, 400)
        for uri in [self.cb, "https://chatgpt.com/connector_platform_oauth_redirect",
                    "https://oauth-redirect.googleusercontent.com/r/fixture", "http://localhost:7365/oauth/callback"]:
            self.assertEqual(self.register(uri).status_code, 201)
        cid = self.register().json["client_id"]
        for overrides in [dict(redirect_uri="https://chatgpt.com/connector_platform_oauth_redirect"), dict(code_challenge_method="plain"),
                          dict(resource="https://other.test/mcp"), dict(scope="mail.send")]:
            res = self.http.post("/api/ai/authorize", json={"action":"review", "params":self.params(cid, **overrides)})
            self.assertEqual(res.status_code, 400)
        res = self.http.post("/api/ai/authorize", json={"action":"allow", "params":self.params(cid, scope=ai.READ), "scopes":[ai.DRAFT]})
        self.assertEqual(res.status_code, 400)

    def test_exchange_rejects_wrong_verifier_client_audience_replay(self):
        cid = self.register().json["client_id"]
        code = self.start(self.params(cid), [ai.READ])
        for client, p in [(self.register().json["client_id"],{}),(cid,{"code_verifier":"wrong"*12}),(cid,{"resource":"https://other.test/mcp"})]:
            self.assertEqual(self.exchange(client, code, **p).status_code, 400)
        access = self.exchange(cid, code)
        self.assertEqual(access.json["scope"], ai.READ)
        self.assertEqual(self.exchange(cid, code).status_code, 400)

    def test_disabling_mailbox_retires_issued_and_pending_grants(self):
        cid = self.register().json["client_id"]
        issued = self.exchange(cid, self.start(self.params(cid), [ai.READ])).json["access_token"]
        pending = self.start(self.params(cid), [ai.READ])
        self.revoke_mailbox(self.address)
        self.assertEqual(self.exchange(cid, pending).json["error"], "invalid_grant")
        self.assertEqual(self.rpc(issued, "tools/list").status_code, 401)

    def test_confidential_client_secret(self):
        client = self.register(method="client_secret_post").json
        cid = client["client_id"]
        code = self.start(self.params(cid), [ai.READ])
        self.assertEqual(self.exchange(cid, code, client_secret="wrong").status_code, 400)
        self.assertEqual(self.exchange(cid, code, client_secret=client["client_secret"]).status_code, 200)

    def test_chatgpt_registration_without_secret_then_discovery(self):
        self.cb = "https://chatgpt.com/connector_platform_oauth_redirect"
        registered = self.http.post("/api/ai/protocol/register", json={"redirect_uris":[self.cb]}).json
        self.assertNotIn("client_secret", registered)
        cid = registered["client_id"]
        code = self.start(self.params(cid), [ai.READ])
        token = self.exchange(cid, code).json["access_token"]
        for desc in self.rpc(token, "tools/list").json["result"]["tools"]:
            self.assertEqual(desc["_meta"]["securitySchemes"], [{"type":"oauth2", "scopes":[ai.READ]}])
        err = self.rpc(token, "tools/call", dict(name="save_draft", arguments={})).json["result"]
        self.assertIn('scope="mail.draft"', err["_meta"]["mcp/www_authenticate"][0])

    def test_mailbox_binding_revocation_and_password_change(self):
        owner = self.address
        token = self.grant([ai.READ])
        grant = self.http.get("/api/ai/connections").json["connections"][0]
        self.address = "other@example.test"
        self.assertFalse(self.http.get("/api/ai/connections").json["connections"])
        self.http.post("/api/ai/revoke", json=dict(id=grant["id"]))
        with patch.object(ai.mailstore, "connect") as connect, patch.object(ai.mailstore, "read_message") as read:
            read.return_value = dict(subject="fixture", date="", text="hello", cc="", to="", **{"from":""})
            result = self.rpc(token, "tools/call", {"name":"read_inbox_message","arguments":{"id":"1.2"}}).json["result"]
            self.assertEqual(json.loads(result["content"][0]["text"])["text"], "hello")
            connect.assert_called_once_with(owner, "fixture")
            read.assert_called_once_with(connect.return_value, "INBOX", "1.2", mark_seen=False)
        self.address = owner
        token2 = self.grant([ai.DRAFT])
        self.http.post("/api/ai/revoke", json=dict(id=grant["id"]))
        self.assertEqual(self.rpc(token, "tools/list").status_code, 401)
        self.assertEqual([t["name"] for t in self.rpc(token2, "tools/list").json["result"]["tools"]], ["save_draft"])
        self.version = "changed"
        self.assertEqual(self.rpc(token2, "tools/list").status_code, 401)

    def test_draft_only_does_not_send_and_a_retry_is_deduplicated(self):
        token = self.grant([ai.DRAFT])
        params = dict(name="save_draft", arguments=dict(request_id="stable-fixture-2000", to="to@example.test", subject="Fixture", text="Body"))
        client = MagicMock()
        client.search.side_effect = [[],[12]]
        with patch.object(ai.mailstore, "connect", return_value=client), patch.object(ai.mailstore,"folder_list", return_value=[dict(name="Drafts",role="drafts")]):
            self.assertTrue(self.rpc(token, "tools/call", {"name":"read_inbox_message","arguments":{"id":"1.2"}}).json["result"]["isError"])
            for _ in range(2):
                self.assertTrue(json.loads(self.rpc(token,"tools/call",params).json["result"]["content"][0]["text"])["saved"])
        client.append.assert_called_once()
        self.assertIn(b"\\Draft", client.append.call_args.kwargs["flags"])

    def test_access_expiry_and_mcp_discovery(self):
        token = self.grant([ai.READ])
        self.assertEqual(self.rpc(token, "initialize", dict(protocolVersion="2025-06-18")).json["result"]["protocolVersion"], "2025-06-18")
        with patch.object(ai.time, "time", return_value=ai.time.time()+ai.TTL+1):
            expired = self.rpc(token, "tools/list")
            self.assertEqual(expired.status_code, 401)
            self.assertIn("oauth-protected-resource/mcp", expired.headers["WWW-Authenticate"])


if __name__ == "__main__":
    unittest.main()
