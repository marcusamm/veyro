"""Private Authentik delivery endpoint for Twilio WhatsApp authentication templates."""

import base64
import hmac
import http.client
import json
import re
from contextlib import closing
from pathlib import Path
from urllib.parse import urlencode


PHONE = re.compile(r"\+[1-9][0-9]{1,14}")


def read_secret(directory, name, pattern):
    value = (directory / ("veyro_" + name)).read_text(encoding="ascii").strip()
    if not re.fullmatch(pattern, value):
        raise ValueError(f"Invalid configuration for {name}")
    return value


def create_app(secret_dir=Path("/run/secrets")):
    internal = read_secret(secret_dir, "whatsapp_internal_token", r"[0-9a-fA-F]{64}")
    account = read_secret(secret_dir, "twilio_account_sid", r"AC[0-9a-fA-F]{32}")
    auth_id = read_secret(secret_dir, "whatsapp_auth_id", r"(?:SK|AC)[0-9a-fA-F]{32}")
    if auth_id.startswith("AC") and auth_id != account:
        raise ValueError("Account authentication requires the configured account SID")
    secret = read_secret(secret_dir, "whatsapp_auth_secret", r"[!-~]{16,256}")
    sender = read_secret(secret_dir, "whatsapp_sender", PHONE)
    template = read_secret(secret_dir, "whatsapp_content_sid", r"HX[0-9a-fA-F]{32}")
    auth = base64.b64encode(f"{auth_id}:{secret}".encode("ascii")).decode("ascii")
    expected = ("Bearer " + internal).encode("ascii")

    def respond(start_response, status):
        start_response(status, [("Content-Length", "0"), ("Cache-Control", "no-store")])
        return []

    def application(environ, start_response):
        if environ.get("PATH_INFO") != "/send" or environ.get("QUERY_STRING"):
            return respond(start_response, "404 Not Found")
        if environ["REQUEST_METHOD"] != "POST":
            return respond(start_response, "405 Method Not Allowed")
        supplied = environ.get("HTTP_AUTHORIZATION", "").encode("latin-1")
        if not hmac.compare_digest(supplied, expected):
            return respond(start_response, "403 Forbidden")
        if environ.get("CONTENT_TYPE", "").partition(";")[0].strip().lower() != "application/json":
            return respond(start_response, "415 Unsupported Media Type")
        length = environ.get("CONTENT_LENGTH") or ""
        if not re.fullmatch(r"[1-9][0-9]{0,2}", length) or int(length) > 256:
            return respond(start_response, "413 Content Too Large")
        try:
            payload = json.loads(environ["wsgi.input"].read(int(length)))
        except (ValueError, UnicodeError):
            return respond(start_response, "400 Bad Request")
        if not isinstance(payload, dict) or set(payload) != {"to", "code"}:
            return respond(start_response, "400 Bad Request")
        number, code = payload["to"], payload["code"]
        if not isinstance(number, str) or not PHONE.fullmatch(number):
            return respond(start_response, "400 Bad Request")
        if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
            return respond(start_response, "400 Bad Request")

        form = urlencode({
            "To": "whatsapp:" + number,
            "From": "whatsapp:" + sender,
            "ContentSid": template,
            "ContentVariables": json.dumps({"1": code}),
        })
        try:
            # A fixed TLS destination and a single request also avoid redirects
            # or automatic retries exposing credentials or sending a second OTP.
            with closing(http.client.HTTPSConnection("api.twilio.com", timeout=6)) as connection:
                connection.request("POST", f"/2010-04-01/Accounts/{account}/Messages.json", form, {
                    "Authorization": "Basic " + auth,
                    "Content-Type": "application/x-www-form-urlencoded",
                })
                with connection.getresponse() as result:
                    if result.status != 201:
                        return respond(start_response, "502 Bad Gateway")
        except (OSError, http.client.HTTPException):
            return respond(start_response, "502 Bad Gateway")
        return respond(start_response, "204 No Content")

    return application
