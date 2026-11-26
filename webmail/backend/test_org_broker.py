import unittest
from unittest.mock import patch

import org_broker


class BrokerBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.client = org_broker.app.test_client()

    def test_arbitrary_native_paths_and_extra_fields_are_rejected(self):
        self.assertEqual(self.client.post("/api/v1/get/api-key/all", json={}).status_code, 404)
        with patch.object(org_broker.org_admin, "organizations") as fetch:
            response = self.client.post("/organizations/list", json={"path": "/api/v1/get/api-key/all"})
            self.assertEqual(response.status_code, 400)
            fetch.assert_not_called()

    def test_status_only_forwards_the_selected_mailbox_and_requested_state(self):
        data = {"domain": "customer.example", "email": "support@customer.example", "active": False}
        with patch.object(org_broker.org_admin, "set_mailbox_active", return_value=data) as update:
            response = self.client.post("/mailboxes/status", json=data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["mailbox"], data)
        update.assert_called_once_with(data["domain"], data["email"], False)

    def test_upstream_exceptions_do_not_disclose_their_message(self):
        exception = RuntimeError("private-mailbox-password")
        with patch.object(org_broker.org_admin, "mailboxes", side_effect=exception):
            response = self.client.post("/mailboxes/list", json={"domain": "customer.example"})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(str(exception), response.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()
