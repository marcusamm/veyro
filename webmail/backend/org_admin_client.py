"""Small client for the mail provisioning broker on a private Unix socket."""

import http.client
import json
import socket

from mailstore import MailError


class BrokerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/run/veyro-org-socket/admin.sock")


class DomainProofRequired(MailError):
    def __init__(self, message, challenge):
        super().__init__(message, 409)
        self.challenge = challenge


def call(path, data, *, actor):
    # Path is a constant supplied by the endpoint, never an URL from the browser.
    connection = BrokerConnection("localhost", timeout=25)
    try:
        connection.request("POST", path, json.dumps(data).encode(),
                           {"Content-Type": "application/json", "X-Veyro-Actor": actor})
        response = connection.getresponse()
        raw = response.read(2_097_153)
        if len(raw) > 2_097_152:
            raise ValueError("Oversized response")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError("Invalid response")
        if 200 <= response.status < 300:
            return result
        message = result.get("error")
        if response.status in {400, 403, 404, 409, 422, 429, 503} and isinstance(message, str):
            challenge = result.get("dnsChallenge")
            if response.status == 409 and isinstance(challenge, dict) and challenge.get("type") == "TXT":
                raise DomainProofRequired(message, {k: challenge[k] for k in ("type", "name", "value")})
            raise MailError(message, response.status)
        raise ValueError("Unexpected broker response")
    except (OSError, http.client.HTTPException, KeyError, ValueError):
        raise MailError("Administrationen kan ikke få forbindelse til mailserveren. Prøv igen.", 503) from None
    finally:
        connection.close()
