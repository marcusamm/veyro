"""Mailcow user self-service, through the same HTTPS login and CSRF checks as its UI."""

import html
import http.client
from http.cookies import SimpleCookie
import json
import re
from urllib.parse import urlencode

from imapclient.exceptions import IMAPClientError

from mailstore import HOST, MailError, connect, verified_tls


class ChangeUnconfirmed(MailError):
    """The mutation left the process, but its final result could not be verified."""

    def __init__(self):
        super().__init__("Forbindelsen blev afbrudt under skiftet. Prøv at logge ind med den nye adgangskode.", 503)


class Portal:
    def __init__(self):
        self.sid = ""
        self.csrf = ""

    def request(self, path, form=None):
        # Mailcow binds its PHP session to the user agent captured at login.
        headers = {"Host": HOST, "User-Agent": "Veyro-Webmail/1"}
        if self.sid:
            headers["Cookie"] = "MCSESSID=" + self.sid
        body = None
        if form is not None:
            headers.update({"Content-Type": "application/x-www-form-urlencoded", "Origin": "https://" + HOST})
            body = urlencode({**form, "csrf_token": self.csrf})
        conn = http.client.HTTPSConnection(HOST, timeout=8, context=verified_tls())
        try:
            conn.request("GET" if form is None else "POST", path, body=body, headers=headers)
            response = conn.getresponse()
            for key, value in response.getheaders():
                if key.lower() == "set-cookie":
                    cookies = SimpleCookie(value)
                    if "MCSESSID" in cookies:
                        self.sid = cookies["MCSESSID"].value
            # Use only fixed local paths. Never replay a form at a redirect destination.
            location = response.getheader("Location", "")
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError("Oversized mailcow response")
            return response.status, location, raw.decode("utf-8")
        finally:
            conn.close()

    def identify(self, address, current):
        status, _, page = self.request("/")
        if status != 200 or not self.sid:
            raise ValueError("Mailcow login unavailable")
        self.csrf = csrf_token(page)
        status, location, page = self.request("/", {"login_user": address, "pass_user": current})
        if status == 200 and 'document.getElementById("ConfirmTFAModal")' in page:
            raise MailError("Mailkontoen kræver totrinsbekræftelse. Kontakt mailadministratoren for hjælp til adgangskodeskift.", 403)
        if status == 200:
            raise MailError("Den nuværende adgangskode blev ikke godkendt. Brug mailkontoens egen adgangskode.", 403)
        if location.startswith("https://" + HOST + "/"):
            location = location.removeprefix("https://" + HOST)
        if status not in (302, 303) or location not in ("/user", "/SOGo/so/", "/"):
            raise ValueError("Unexpected mailcow login result")
        pending = location == "/"
        status, _, page = self.request("/" if pending else "/user")
        if pending and 'changePWModal.show();' not in page:
            raise MailError("Færdiggør mailkontoens totrinsbekræftelse med mailadministratoren før adgangskodeskift.", 403)
        if pending:
            name = re.search(r"var username = '([^']+)';", page)
        else:
            name = re.search(r'<b class="username-lia">([^<]+)</b>', page)
        if status != 200 or not name or html.unescape(name[1]) != address or "var mailcow_cc_role = 'user';" not in page:
            raise ValueError("Mailbox identity was not confirmed")
        self.csrf = csrf_token(page)

    def policy_message(self):
        generic = "Den nye adgangskode opfylder ikke mailserverens krav."
        try:
            status, _, body = self.request("/api/v1/get/passwordpolicy")
            policy = json.loads(body)
            if status != 200 or not isinstance(policy, dict):
                return generic
            rules = []
            length = int(policy.get("length") or 0)
            if length:
                rules.append(f"mindst {length} tegn")
            for key, rule in (("chars", "et bogstav"), ("numbers", "et tal"), ("special_chars", "et specialtegn"), ("lowerupper", "både små og store bogstaver")):
                if str(policy.get(key)) == "1":
                    rules.append(rule)
            return "Adgangskoden skal indeholde " + ", ".join(rules) + "." if rules else generic
        except (OSError, http.client.HTTPException, TypeError, ValueError):
            return generic

    def change(self, address, current, new):
        self.identify(address, current)
        fields = {"user_old_pass": current, "user_new_pass": new, "user_new_pass2": new}
        try:
            status, _, body = self.request("/api/v1/edit/self", {"attr": json.dumps(fields)})
            entries = json.loads(body)
            if not isinstance(entries, list):
                raise ChangeUnconfirmed()
            for item in entries:
                if not isinstance(item, dict):
                    continue
                msg = item.get("msg")
                if item.get("type") == "danger" and msg == "password_complexity":
                    raise MailError(self.policy_message(), 422)
                if item.get("type") == "danger" and msg == "access_denied":
                    raise MailError("Mailkontoen godkendte ikke adgangskodeskiftet.", 403)
                if status == 200 and item.get("type") == "success" and msg == ["mailbox_modified", html.escape(address)]:
                    # Mailcow reports success even if its UPDATE matched no local mailbox.
                    # Confirm that the same mailbox now accepts the replacement secret.
                    confirmed = connect(address, new)
                    try:
                        confirmed.shutdown()
                    except OSError:
                        pass
                    return
            raise ChangeUnconfirmed()
        except (OSError, http.client.HTTPException, IMAPClientError, ValueError):
            raise ChangeUnconfirmed() from None


def csrf_token(page):
    match = re.search(r'''<input type="hidden" value="([A-Za-z0-9_-]{16,128})">.*?\.attr\('name', 'csrf_token'\)''', page)
    if not match:
        raise ValueError("Mailcow CSRF token unavailable")
    return match[1]


def change_password(address, current, new):
    portal = Portal()
    try:
        portal.change(address, current, new)
    finally:
        if portal.sid:
            try:
                portal.request("/", {"logout": "1"})
            except (OSError, http.client.HTTPException, ValueError):
                pass
