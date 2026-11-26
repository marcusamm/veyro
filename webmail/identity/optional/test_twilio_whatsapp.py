import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs

from twilio_whatsapp import create_app


class DeliveryTest(unittest.TestCase):
    def setUp(self):
        with tempfile.TemporaryDirectory() as directory:
            secrets = {
                "twilio_account_sid": "AC" + "1" * 32,
                "whatsapp_auth_id": "SK" + "2" * 32,
                "whatsapp_auth_secret": "s" * 32,
                "whatsapp_internal_token": "a" * 64,
                "whatsapp_sender": "+12025550102",
                "whatsapp_content_sid": "HX" + "3" * 32,
            }
            for key, value in secrets.items():
                (Path(directory) / ("veyro_" + key)).write_text(value)
            self.app = create_app(Path(directory))
        self.https = self.enterContext(patch("twilio_whatsapp.http.client.HTTPSConnection"))
        self.connection = self.https.return_value
        self.response = self.connection.getresponse.return_value.__enter__.return_value

    def send(self, payload=None, **changes):
        raw = json.dumps(payload if payload is not None else {"to": "+12025550101", "code": "012345"}).encode()
        environ = {
            "REQUEST_METHOD": "POST", "PATH_INFO": "/send", "CONTENT_LENGTH": str(len(raw)),
            "CONTENT_TYPE": "application/json", "HTTP_AUTHORIZATION": "Bearer " + "a" * 64,
            "wsgi.input": io.BytesIO(raw), **changes,
        }
        status = []
        self.assertEqual(self.app(environ, lambda code, headers: status.append(code)), [])
        return int(status[0].split()[0])

    def test_only_authorized_six_digit_codes_are_sent(self):
        self.assertEqual(self.send(HTTP_AUTHORIZATION="Bearer wrong"), 403)
        self.assertEqual(self.send(PATH_INFO="/"), 404)
        self.assertEqual(self.send(QUERY_STRING="extra=1"), 404)
        self.assertEqual(self.send(REQUEST_METHOD="GET"), 405)
        self.assertEqual(self.send(CONTENT_TYPE="text/plain"), 415)
        self.assertEqual(self.send(CONTENT_LENGTH="257"), 413)
        self.assertEqual(self.send({"to": "local number", "code": "012345"}), 400)
        self.assertEqual(self.send({"to": "+12025550101", "code": 123456}), 400)
        self.assertEqual(self.send({"to": "+12025550101", "code": "012345", "body": "text"}), 400)
        self.https.assert_not_called()

    def test_approved_template_request(self):
        self.response.status = 201
        self.assertEqual(self.send(), 204)
        self.https.assert_called_once_with("api.twilio.com", timeout=6)
        method, path, body, headers = self.connection.request.call_args.args
        self.assertEqual((method, path), ("POST", "/2010-04-01/Accounts/AC" + "1" * 32 + "/Messages.json"))
        self.assertEqual(headers["Content-Type"], "application/x-www-form-urlencoded")
        userpass = base64.b64decode(headers["Authorization"].removeprefix("Basic ")).decode()
        self.assertEqual(userpass, "SK" + "2" * 32 + ":" + "s" * 32)
        self.assertEqual(parse_qs(body), {
            "To": ["whatsapp:+12025550101"], "From": ["whatsapp:+12025550102"],
            "ContentSid": ["HX" + "3" * 32], "ContentVariables": ['{"1": "012345"}'],
        })

    def test_upstream_failure_does_not_resend_or_redirect(self):
        for status in (302, 429):
            self.response.status = status
            self.assertEqual(self.send(), 502)
        self.connection.request.side_effect = TimeoutError
        self.assertEqual(self.send(), 502)
        self.assertEqual(self.connection.request.call_count, 3)


if __name__ == "__main__":
    unittest.main()
