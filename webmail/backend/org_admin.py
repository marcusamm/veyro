"""Tenant provisioning operations used exclusively by the private admin broker."""

import base64
import binascii
import hashlib
import hmac
import http.client
import json
import re
import threading
import time
import unicodedata
from pathlib import Path
from urllib.parse import quote, urlencode

import pymysql
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, load_der_public_key

from mailstore import HOST, MailError, verified_tls


API_KEY = Path("/run/veyro-broker/mailcow-key")
DNS_KEY = Path("/run/veyro-broker/dns-key")
ROLE_CONFIG = Path("/run/veyro-broker/org-roles.json")
HOME_DOMAIN = "veyro.dk"
TENANT_TAG = "veyro-mail-organization"
RESERVED_SUFFIXES = ("test", "invalid", "example", "localhost", "local", "internal",
                     "arpa", "onion", "example.com", "example.net", "example.org")
PROTECTED_LOCALS = {"admin", "postmaster", "abuse", "hostmaster", "mailer-daemon", "root"}
LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
LOCAL = re.compile(r"[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*")
MAIL_ATOM = r"[a-z0-9!#$%&'*+/=?^_\x60{|}~-]+"
EXISTING_LOCAL = re.compile(MAIL_ATOM + r"(?:\." + MAIL_ATOM + r")*")
MIB = 1024 ** 2
# Mailcow checks remaining domain quota before inserting a mailbox. Serialize the
# management panel's writers so concurrent operators cannot race that check.
WRITE_LOCK = threading.RLock()


class DomainProofRequired(MailError):
    def __init__(self, challenge):
        super().__init__("Tilføj TXT-posten hos domænets DNS-udbyder, og prøv igen.", 409)
        self.challenge = challenge


def _unavailable():
    return MailError("Mailadministrationen svarede ikke som forventet. Opdatér oversigten, før du prøver igen.", 503)


def _native(path, data=None):
    """Only fixed operations below construct this path; callers supply field values."""
    try:
        key = API_KEY.read_text("ascii").strip()
        if not re.fullmatch(r"[A-Za-z0-9-]{16,160}", key):
            raise ValueError("Mailcow key is unavailable")
        conn = http.client.HTTPSConnection(HOST, timeout=7, context=verified_tls())
        try:
            body = json.dumps(data).encode("utf-8") if data is not None else None
            conn.request("POST" if body is not None else "GET", "/api/v1/" + path, body,
                         {"X-API-Key": key, "Content-Type": "application/json", "Accept": "application/json"})
            response = conn.getresponse()
            raw = response.read(4 * 1024 * 1024 + 1)
            if response.status != 200 or len(raw) > 4 * 1024 * 1024:
                raise ValueError("Unexpected Mailcow response")
            return json.loads(raw)
        finally:
            conn.close()
    except (OSError, http.client.HTTPException, ValueError):
        raise _unavailable() from None


def _write(path, data, success, identity):
    entries = _native(path, data)
    if not isinstance(entries, list) or not all(isinstance(e, dict) for e in entries):
        raise _unavailable()
    for entry in entries:
        if entry.get("type") in ("danger", "error"):
            msg = entry.get("msg")
            code = msg[0] if isinstance(msg, list) and msg else msg
            if code in ("object_exists", "is_alias", "is_spam_alias", "domain_exists"):
                raise MailError("Adressen eller domænet er allerede i brug. Opdatér oversigten.", 409)
            if code == "password_complexity":
                raise MailError("Startadgangskoden opfylder ikke Mailcows adgangskodekrav.", 422)
            if isinstance(code, str) and ("quota" in code or code in ("max_mailbox_exceeded", "max_mailboxes_exceeded")):
                raise MailError("Organisationens grænse for plads eller antal postkasser er nået.", 422)
            raise _unavailable()
    if not any(e.get("type") == "success" and e.get("msg") == [success, identity] for e in entries):
        raise _unavailable()


def _domain(value):
    if not isinstance(value, str) or not value.isascii():
        raise MailError("Angiv et gyldigt maildomæne.", 400)
    name = value.strip().lower()
    labels = name.split(".")
    if (len(name) > 253 or len(labels) < 2 or not name.isascii()
            or not all(LABEL.fullmatch(label) for label in labels)
            or not re.fullmatch(r"(?:[a-z]{2,63}|xn--[a-z0-9-]+)", labels[-1])):
        raise MailError("Angiv domænenavnet uden https://. Brug punycode til internationale domæner.", 400)
    if (name.endswith("." + HOME_DOMAIN)
            or any(name == suffix or name.endswith("." + suffix) for suffix in RESERVED_SUFFIXES)):
        raise MailError("Domænet er reserveret.", 400)
    return name


def _name(value):
    if not isinstance(value, str):
        raise MailError("Angiv et navn på mellem 1 og 100 tegn.", 400)
    name = value.strip()
    if not 1 <= len(name) <= 100 or any(unicodedata.category(c).startswith("C") or c in "<>" for c in name):
        raise MailError("Angiv et navn på mellem 1 og 100 tegn uden kontroltegn eller vinkelparenteser.", 400)
    return name


def _local(value):
    if (not isinstance(value, str) or not value.isascii()
            or not LOCAL.fullmatch(value.strip().lower()) or len(value.strip()) > 64):
        raise MailError("Angiv den del af mailadressen, der står før @.", 400)
    return value.strip().lower()


def _protected(address):
    return address == "marcus@" + HOME_DOMAIN or address.split("@", 1)[0] in PROTECTED_LOCALS


def forbidden():
    return MailError("Du har ikke adgang til denne handling.", 403)


def _role_query(statement, value):
    """Only the broker can read the credentials for the mailbox-role table."""
    try:
        cfg = json.loads(ROLE_CONFIG.read_text("utf-8"))
        if (not isinstance(cfg, dict) or cfg.get("host") != "127.0.0.1"
                or cfg.get("user") != "veyro_org_roles" or type(cfg.get("port")) is not int
                or not 1 <= cfg["port"] <= 65535 or not isinstance(cfg.get("password"), str)
                or not cfg["password"] or not re.fullmatch(r"[a-zA-Z0-9_]+", cfg.get("database", ""))):
            raise ValueError()
        with pymysql.connect(host=cfg["host"], port=cfg["port"], database=cfg["database"],
                             user=cfg["user"], password=cfg["password"], charset="utf8mb4",
                             connect_timeout=3, read_timeout=4, write_timeout=4, autocommit=True) as db:
            with db.cursor() as cursor:
                cursor.execute(statement, (value,))
                return cursor.fetchall() if cursor.description else []
    except pymysql.MySQLError as exc:
        if statement.startswith("INSERT") and exc.args and exc.args[0] == 1062:
            return []
        if statement.startswith("INSERT") and exc.args and exc.args[0] in (1452, 1644):
            raise MailError("Postkassen kan ikke tildeles administratoradgang.", 409) from None
        raise _unavailable() from None
    except (ValueError, OSError, TypeError):
        raise _unavailable() from None


def has_role(address):
    rows = _role_query("SELECT mailbox FROM veyro_organization_admins WHERE mailbox=%s", address)
    return any(row[0] == address for row in rows)


def domain_roles(domain):
    rows = _role_query("SELECT mailbox FROM veyro_organization_admins WHERE SUBSTRING_INDEX(mailbox,'@',-1)=%s", domain)
    return {row[0] for row in rows}


def _change_role(address, grant):
    if grant:
        _role_query("INSERT INTO veyro_organization_admins (mailbox) VALUES (%s)", address)
    else:
        _role_query("DELETE FROM veyro_organization_admins WHERE mailbox=%s", address)
    if has_role(address) is not grant:
        raise _unavailable()


def _eligible_manager(box, row):
    attrs = row["attributes"]
    return (box["active"] and not box["protected"] and row.get("kind", "") == ""
            and attrs.get("imap_access", "1") in (1, "1") and attrs.get("sogo_access", "1") in (1, "1")
            and attrs.get("force_pw_update", "0") in (0, "0") and attrs.get("force_tfa", "0") in (0, "0"))


def access(actor):
    if not isinstance(actor, str) or not actor.isascii() or actor != actor.lower() or actor.count("@") != 1:
        raise forbidden()
    local, domain = actor.split("@")
    if len(actor) > 254 or not EXISTING_LOCAL.fullmatch(local) or len(local) > 64 or not domain:
        raise forbidden()
    if actor == "marcus@" + HOME_DOMAIN:
        return {"role": "platform", "domain": None}
    none = {"role": "none", "domain": None}
    if _protected(actor) or not has_role(actor):
        return none
    try:
        if _domain(domain) != domain or not _get_org(domain)["active"]:
            return none
        box, row = _get_mailbox(domain, actor)
    except MailError as exc:
        if exc.status in (400, 404):
            return none
        raise
    if not _eligible_manager(box, row) or actor in _admin_addresses():
        return none
    return {"role": "organization", "domain": domain}


def authorized_domain(scope, domain):
    domain = _domain(domain)
    if scope["role"] != "platform" and domain != scope["domain"]:
        raise forbidden()
    return domain


def scoped_organizations(scope):
    return organizations() if scope["role"] == "platform" else [_get_org(scope["domain"])]


def mailbox_role(box, assigned, scope):
    return {**box, "organizationAdmin": assigned,
            "protected": box["protected"] or (assigned and scope["role"] == "organization")}


def _admin_addresses():
    addresses = set()
    for path in ("get/admin/all", "get/domain-admin/all"):
        for row in _rows(_native(path)):
            if not isinstance(row.get("username"), str):
                raise _unavailable()
            addresses.add(row["username"].lower())
    return addresses


def _active(row):
    value = row.get("active_int", row.get("active"))
    if value not in (0, 1, "0", "1"):
        raise _unavailable()
    return value in (1, "1")


def _organization(row):
    if not isinstance(row, dict):
        raise _unavailable()
    domain = row.get("domain_name")
    tags = row.get("tags")
    if domain != HOME_DOMAIN and (not isinstance(tags, list) or TENANT_TAG not in tags):
        return None
    try:
        if _domain(domain) != domain:
            return None
    except MailError:
        return None
    if any(row.get(flag + "_int", row.get(flag)) not in (0, "0")
           for flag in ("backupmx", "relay_all_recipients", "relay_unknown_only")):
        return None
    return {"domain": domain, "name": str(row.get("description") or domain), "active": _active(row)}


def _rows(value):
    if value == {}:
        return []
    if not isinstance(value, list) or not all(isinstance(x, dict) for x in value):
        raise _unavailable()
    return value


def organizations():
    rows = _rows(_native("get/domain/all"))
    tenants = [org for row in rows if (org := _organization(row)) is not None]
    return sorted(tenants, key=lambda org: (org["domain"] != HOME_DOMAIN, org["domain"]))


def _get_org(domain, writable=False):
    row = _native("get/domain/" + domain)
    org = _organization(row) if row else None
    # Mailcow resolves an alias domain to its target; an exact match is required here.
    if not org or org["domain"] != domain:
        raise MailError("Organisationen blev ikke fundet.", 404)
    if writable and not org["active"]:
        raise MailError("Organisationens maildomæne er deaktiveret.", 409)
    return org


def domain_dns(domain):
    domain = _domain(domain)
    _get_org(domain)
    result = {"mx": {"name": domain, "value": HOST, "priority": 10}, "dkim": None}
    try:
        row = _native("get/dkim/" + domain)
        if not isinstance(row, dict):
            return result
        selector, public = row.get("dkim_selector"), row.get("pubkey")
        if (not isinstance(selector, str) or len(selector + "._domainkey." + domain) > 253
                or not all(LABEL.fullmatch(part) for part in selector.lower().split("."))
                or not isinstance(public, str) or len(public) > 4096):
            return result
        key = load_der_public_key(base64.b64decode(public, validate=True))
        if isinstance(key, RSAPublicKey):
            # Native DKIM output optionally includes the private key and formatted
            # TXT; construct the public record exclusively from the verified RSA public key.
            wire = key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
            result["dkim"] = {"name": selector + "._domainkey." + domain,
                              "value": "v=DKIM1;k=rsa;t=s;s=email;p=" + base64.b64encode(wire).decode("ascii")}
    except (MailError, ValueError, binascii.Error, UnsupportedAlgorithm):
        pass
    return result


def _proof(domain, day):
    try:
        key = DNS_KEY.read_bytes().strip()
        if len(key) < 32:
            raise ValueError()
    except (ValueError, OSError):
        raise _unavailable() from None
    text = f"veyro-mail-domain-v1\n{day}\n{domain}".encode("ascii")
    return "veyro-mail-verification=" + hmac.new(key, text, hashlib.sha256).hexdigest()


def dns_challenge(domain):
    domain = _domain(domain)
    if len("_veyro-mail." + domain) > 253:
        raise MailError("Domænenavnet er for langt til DNS-verificering.", 400)
    return {"type": "TXT", "name": "_veyro-mail." + domain, "value": _proof(domain, int(time.time() // 86400))}


def _dns_values(owner):
    # The only external endpoint is this fixed recursive resolver. A submitted
    # domain is a DNS query parameter; it can never select the connection host.
    conn = http.client.HTTPSConnection("cloudflare-dns.com", timeout=5)
    try:
        conn.request("GET", "/dns-query?" + urlencode({"name": owner, "type": "TXT"}),
                     headers={"Accept": "application/dns-json"})
        response = conn.getresponse()
        raw = response.read(65537)
        if response.status != 200 or len(raw) > 65536:
            raise ValueError()
        body = json.loads(raw)
        if not isinstance(body, dict) or body.get("Status") not in (0, 3) or body.get("TC"):
            raise ValueError()
        if body["Status"] == 3:
            return set()
        rows = body.get("Answer", [])
        if not isinstance(rows, list):
            raise ValueError()
        return {r["data"] for r in rows if isinstance(r, dict) and r.get("type") == 16
                and str(r.get("name", "")).rstrip(".").lower() == owner and isinstance(r.get("data"), str)}
    except (ValueError, OSError, http.client.HTTPException):
        raise MailError("DNS-opslaget kunne ikke gennemføres. Prøv igen om lidt.", 503) from None
    finally:
        conn.close()


def create_organization(domain, name):
    domain, name = _domain(domain), _name(name)
    if domain == HOME_DOMAIN:
        raise MailError("Veyros eget domæne er allerede oprettet.", 409)
    with WRITE_LOCK:
        existing = _native("get/domain/" + domain)
        if existing:
            org = _organization(existing)
            if org and org["domain"] == domain and org["name"] == name:
                return org
            raise MailError("Domænet er allerede tilknyttet en anden konfiguration.", 409)
        challenge = dns_challenge(domain)
        values = _dns_values(challenge["name"])
        yesterday = _proof(domain, int(time.time() // 86400) - 1)
        if not values.intersection({json.dumps(challenge["value"]), json.dumps(yesterday)}):
            raise DomainProofRequired(challenge)
        _write("add/domain", {
            "domain": domain, "description": name, "tags": [TENANT_TAG], "active": 1,
            "backupmx": 0, "relay_all_recipients": 0, "relay_unknown_only": 0, "restart_sogo": 0,
            "key_size": 2048, "dkim_selector": "dkim",
        }, "domain_added", domain)
        return _get_org(domain)


def _mailbox(row, domain):
    address = row.get("username")
    if (row.get("domain") != domain or not isinstance(address, str) or address.count("@") != 1
            or not address.endswith("@" + domain)):
        raise _unavailable()
    attrs = row.get("attributes")
    if not isinstance(attrs, dict):
        raise _unavailable()
    if row.get("authsource") != "mailcow" or row.get("kind", "") != "" or attrs.get("shared", "0") not in (0, "0"):
        return None
    try:
        quota = int(row["quota"]) // MIB
    except (ValueError, TypeError, KeyError):
        raise _unavailable() from None
    return {"address": address, "name": str(row.get("name") or address), "active": _active(row),
            "quotaMiB": quota, "protected": _protected(address)}


def mailboxes(domain):
    domain = _domain(domain)
    _get_org(domain)
    # Upstream can fall back to *all domains* when the requested domain is
    # missing. Check every returned row as well as the domain preflight above.
    admins = _admin_addresses()
    rows = _rows(_native("get/mailbox/reduced/" + domain))
    boxes = [mailbox for row in rows if (mailbox := _mailbox(row, domain)) is not None]
    return sorted((box for box in boxes if box["address"].lower() not in admins), key=lambda box: box["address"])


def _get_mailbox(domain, address):
    row = _native("get/mailbox/" + quote(address, safe="@"))
    if not isinstance(row, dict):
        raise _unavailable()
    if not row or row.get("username") != address:
        raise MailError("Postkassen blev ikke fundet.", 404)
    box = _mailbox(row, domain)
    if not box:
        raise MailError("Postkassen kan ikke administreres her.", 404)
    return box, row


def _validate_password(password):
    if not isinstance(password, str):
        raise MailError("Angiv en adgangskode på højst 72 bytes.", 400)
    try:
        length = len(password.encode("utf-8"))
    except UnicodeEncodeError:
        raise MailError("Adgangskoden indeholder et ugyldigt tegn.", 422) from None
    if (not 1 <= length <= 72 or password == "0" or re.match(r"^\{[A-Za-z0-9-]+\}", password)
            or any(c in password for c in "\x00\r\n")):
        raise MailError("Angiv en understøttet adgangskode på højst 72 bytes.", 422)


def create_mailbox(domain, local_part, name, password, quota_mib=1024):
    domain, local, name = _domain(domain), _local(local_part), _name(name)
    address = local + "@" + domain
    if len(address) > 254 or _protected(address):
        raise MailError("Mailadressen er reserveret eller for lang.", 400)
    _validate_password(password)
    if type(quota_mib) is not int or not 1 <= quota_mib <= 1048576:
        raise MailError("Angiv en gyldig kvote i MiB.", 400)
    with WRITE_LOCK:
        _get_org(domain, writable=True)
        if address in _admin_addresses():
            raise MailError("Mailadressen er reserveret.", 409)
        _write("add/mailbox", {
            "domain": domain, "local_part": local, "name": name, "quota": quota_mib,
            "password": password, "password2": password, "active": 1, "authsource": "mailcow",
            "imap_access": 1, "sogo_access": 1, "smtp_access": 1, "shared": 0,
        }, "mailbox_added", address)
        return _get_mailbox(domain, address)[0]


def check_address(domain, address):
    if (not isinstance(address, str) or not address.isascii() or address.count("@") != 1 or len(address) > 254
            or address.rsplit("@", 1)[1] != domain or len(address.split("@", 1)[0]) > 64
            or not EXISTING_LOCAL.fullmatch(address.split("@", 1)[0])):
        raise MailError("Postkassens adresse skal høre til den valgte organisation.", 400)


def _check_target(domain, address):
    check_address(domain, address)
    if _protected(address) or address in _admin_addresses():
        raise MailError("Denne postkasse er beskyttet.", 403)


def set_mailbox_active(domain, address, active):
    domain = _domain(domain)
    if type(active) is not bool:
        raise MailError("Vælg en gyldig postkassestatus.", 400)
    with WRITE_LOCK:
        _check_target(domain, address)
        _get_org(domain, writable=True)
        before, row = _get_mailbox(domain, address)
        if before["active"] == active:
            return before
        # Native edit/mailbox resets attribute_hash when omitted. Preserve it
        # to avoid disturbing template-managed accounts during a status change.
        _write("edit/mailbox", {"items": [address], "attr": {
            "active": int(active), "attribute_hash": row["attributes"].get("attribute_hash", ""),
        }}, "mailbox_modified", address)
        after = _get_mailbox(domain, address)[0]
        if after["active"] != active:
            raise _unavailable()
        return after


def set_role(domain, address, enabled):
    if type(enabled) is not bool:
        raise MailError("Vælg en gyldig administratorrolle.", 400)
    _check_target(domain, address)
    _get_org(domain, writable=enabled)
    box, row = _get_mailbox(domain, address)
    if enabled and not _eligible_manager(box, row):
        raise MailError("Kun en aktiv, almindelig brugerpostkasse kan blive administrator.", 409)
    _change_role(address, enabled)
    return box


def reset_password(domain, address, password):
    _check_target(domain, address)
    _validate_password(password)
    _get_org(domain, writable=True)
    box, row = _get_mailbox(domain, address)
    if not box["active"]:
        raise MailError("Postkassen er deaktiveret.", 409)
    _write("edit/mailbox", {"items": [address], "attr": {
        "password": password, "password2": password, "attribute_hash": row["attributes"].get("attribute_hash", ""),
    }}, "mailbox_modified", address)
    return _get_mailbox(domain, address)[0]
