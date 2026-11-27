import hmac
import hashlib
import http.client
import io
import ipaddress
import json
import logging
import os
import re
import secrets
import smtplib
import threading
import time
from collections import deque
from contextlib import ExitStack, contextmanager
from pathlib import Path
from queue import Full, Queue

from cryptography.fernet import Fernet
from flask import Flask, g, jsonify, request, send_file
from imapclient.exceptions import IMAPClientAbortError, LoginError
import pymysql
from werkzeug.exceptions import HTTPException

import account
import ai_connector
import mailstore
import org_admin_client
import snooze
from mailstore import MailError

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024
ORIGIN = os.environ["WEBMAIL_ORIGIN"]
STAFF = {address.strip().lower() for address in os.environ["WEBMAIL_STAFF"].split(",") if address.strip()}
ORGANIZATION_ADMIN = "marcus@veyro.dk"
# Serialize competing operations on the same mailbox without retaining every
# address supplied to the public login endpoint. Python's string hash is salted.
ACCOUNT_LOCKS = tuple(threading.Lock() for _ in range(128))
RECOVERY_REQUESTS = Queue(maxsize=16)
RECOVERY_KEY = secrets.token_bytes(32)
COOKIE = "__Host-veyro_session"
KEY = Fernet(Fernet.generate_key())
SESSIONS = {}
LIMITS = {}
DELIVERIES = {}
TABLE = threading.Lock()
IDLE = 1800
LIFETIME = 8 * 3600
log = logging.getLogger("gunicorn.error")


class Session:
    def __init__(self, address, password, client, generation):
        self.email = address
        self.secret = KEY.encrypt(password.encode())
        self.csrf = secrets.token_urlsafe(32)
        self.created = self.touched = self.connected = time.monotonic()
        self.client = client
        self.lock = threading.Lock()
        self.folders = None
        self.folder_time = 0
        self.generation = generation
        self.recovery = None
        self.admin_verified_at = None

    def close(self):
        if self.client:
            try:
                self.client.shutdown()
            except OSError:
                pass
        self.client = None

    def password(self):
        return KEY.decrypt(self.secret).decode()

    def imap(self):
        if self.client and time.monotonic() - self.connected > 180:
            self.close()
        if self.client is None:
            self.client = mailstore.connect(self.email, self.password())
            self.connected = time.monotonic()
        return self.client

    def cached_folders(self, client):
        if self.folders is None or time.monotonic() - self.folder_time > 12:
            self.folders = mailstore.folder_list(client)
            self.folder_time = time.monotonic()
        return self.folders


def purge():
    now = time.monotonic()
    with TABLE:
        old = [(k, s) for k, s in SESSIONS.items() if now-s.touched >= IDLE or now-s.created >= LIFETIME]
        for k, s in old:
            if s.lock.acquire(blocking=False):
                try:
                    SESSIONS.pop(k, None)
                    s.close()
                    s.secret = b""
                finally:
                    s.lock.release()
        for k in list(LIMITS):
            if now - LIMITS[k][-1] >= 3600:
                del LIMITS[k]
        for k, entry in list(DELIVERIES.items()):
            if now - entry["at"] >= 3600:
                del DELIVERIES[k]


def janitor():
    while True:
        time.sleep(60)
        purge()


threading.Thread(target=janitor, daemon=True).start()


def throttle(key, maximum, seconds):
    now = time.monotonic()
    with TABLE:
        if key not in LIMITS and len(LIMITS) >= 4096:
            raise MailError("For mange forsøg. Prøv igen senere.", 429)
        recent = LIMITS.setdefault(key, deque())
        while recent and now-recent[0] >= seconds:
            recent.popleft()
        if len(recent) >= maximum:
            raise MailError("For mange forsøg. Prøv igen senere.", 429)
        recent.append(now)


def safe_equal(a, b):
    if not isinstance(a, str) or not isinstance(b, str):
        return False
    try:
        return hmac.compare_digest(a.encode(), b.encode())
    except UnicodeEncodeError:
        return False


def account_lock(address):
    return ACCOUNT_LOCKS[hash(address) % len(ACCOUNT_LOCKS)]


def credential_version(address):
    # The dedicated SQL user has SELECT on one restricted generation view only.
    try:
        config = json.loads(Path("/run/veyro/credential-version.json").read_text())
        if config["host"] != "127.0.0.1":
            raise ValueError("Expected loopback database")
        with pymysql.connect(host=config["host"], port=int(config["port"]), user=config["user"],
                             password=config["password"], database=config["database"],
                             connect_timeout=3, read_timeout=3, write_timeout=3) as db:
            with db.cursor() as cursor:
                cursor.execute("SELECT username, version FROM veyro_webmail_credential_version WHERE username=%s", (address,))
                row = cursor.fetchone()
        # SQL collation alone is insufficient to bind an authenticated IMAP name.
        if row is None or row[0] != address:
            return None
        if not isinstance(row[1], str) or not re.fullmatch(r"[0-9a-fA-F]{64}", row[1]):
            raise ValueError("Invalid credential version")
        return row[1]
    except (pymysql.MySQLError, OSError, ValueError, KeyError, TypeError):
        raise MailError("Mailserveren kunne ikke kontrollere din konto. Prøv igen.", 503) from None


@app.before_request
def gateway():
    token = Path("/run/veyro/origin-token").read_text().strip()
    if len(token) < 48 or not safe_equal(request.headers.get("X-Veyro-Origin-Token"), token):
        raise MailError("Adgang afvist.", 403)
    try:
        g.ip = str(ipaddress.ip_address(request.headers.get("X-Veyro-Client-IP", "")))
    except ValueError:
        raise MailError("Adgang afvist.", 403) from None
    if request.path in {"/api/ai/protocol/register", "/api/ai/protocol/token",
                        "/api/ai/protocol/revoke", "/api/ai/protocol/mcp"}:
        # The origin proxy strips public Authorization. The Worker alone supplies
        # this header after checking the protocol endpoint and credential type.
        credential = request.headers.get("X-Veyro-AI-Authorization")
        if credential:
            request.environ["HTTP_AUTHORIZATION"] = credential
        return
    if request.method == "POST":
        if request.headers.get("Origin") != ORIGIN:
            raise MailError("Adgang afvist.", 403)
        if not request.is_json:
            raise MailError("Der kræves JSON.", 415)
    if request.path in {"/api/login", "/api/recovery/request"}:
        return
    sid = request.cookies.get(COOKIE, "")
    now = time.monotonic()
    with TABLE:
        current = SESSIONS.get(sid)
        if not current or now-current.touched >= IDLE or now-current.created >= LIFETIME:
            raise MailError("Log ind for at fortsætte.", 401)
        if request.method == "POST" and not safe_equal(request.headers.get("X-CSRF-Token"), current.csrf):
            raise MailError("Sikkerhedskontrollen mislykkedes.", 403)
        current.touched = now
    if current.generation != credential_version(current.email):
        with TABLE:
            SESSIONS.pop(sid, None)
        with current.lock:
            current.close()
            current.secret = b""
            current.recovery = None
        raise MailError("Adgangskoden er ændret. Log ind igen.", 401)
    g.session = current
    g.sid = sid


revoke_ai_for_mailbox = ai_connector.install(app, credential_version, throttle, KEY)


@app.after_request
def privacy(response):
    response.headers["Cache-Control"] = "no-store, private"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.errorhandler(MailError)
def handled(exc):
    return jsonify(error=exc.message), exc.status


@app.errorhandler(HTTPException)
def http_error(exc):
    return jsonify(error="Forespørgslen kunne ikke behandles."), exc.code


@app.errorhandler(Exception)
def unexpected(exc):
    # Provider and parsing exceptions can contain message text or account data.
    log.error("Mail request failed (%s)", type(exc).__name__)
    return jsonify(error="Mailserveren kunne ikke besvare forespørgslen."), 502


def payload():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise MailError("Ugyldige data.")
    return data


def administration_scope(address):
    if address == ORGANIZATION_ADMIN:
        return "platform", None
    result = org_admin_client.call("/access", {}, actor=address)
    if result.get("role") == "organization" and result.get("domain") == address.rpartition("@")[2]:
        return "organization", result["domain"]
    return "none", None


def public_session(s):
    try:
        role, domain = administration_scope(s.email)
    except MailError:
        # A provisioning outage must not prevent employees from using their mail.
        role, domain = "none", None
    return dict(email=s.email, csrfToken=s.csrf, canManageRecovery=s.email in STAFF,
                canManageOrganizations=role != "none", administrationRole=role, administrationDomain=domain)


def recovery_address(value):
    if not isinstance(value, str):
        raise MailError("Skriv en gyldig mailadresse.", 422)
    value = value.strip()
    local, separator, domain = value.rpartition("@")
    atom = r"[A-Za-z0-9!#$%&'*+/=?^_\x60{|}~-]+"
    label = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    if (not separator or len(value) > 254 or len(local) > 64 or
            not re.fullmatch(atom + r"(?:\." + atom + ")*", local) or
            not re.fullmatch(label + r"(?:\." + label + ")+", domain)):
        raise MailError("Skriv en gyldig mailadresse.", 422)
    return local + "@" + domain.lower()


def dispatch_resets():
    while True:
        address = RECOVERY_REQUESTS.get()
        try:
            account.request_reset(address)
        except Exception as exc:
            log.error("Mailcow recovery request unavailable (%s)", type(exc).__name__)
        finally:
            RECOVERY_REQUESTS.task_done()


threading.Thread(target=dispatch_resets, daemon=True).start()


@app.post("/api/recovery/request")
def request_recovery():
    throttle(("recovery-request-ip", g.ip), 10, 900)
    data = payload()
    if set(data) != {"email"}:
        raise MailError("Skriv din Veyro-mailadresse.")
    address = recovery_address(data["email"]).lower()
    if address in STAFF:
        # The public reply must also be identical when an address has no recovery
        # address or its per-account limit has been reached. SMTP runs off-request.
        try:
            throttle(("recovery-request", address), 3, 900)
            RECOVERY_REQUESTS.put_nowait(address)
        except (MailError, Full):
            pass
    return jsonify(ok=True), 202


@contextmanager
def enrollment(data):
    session = g.session
    if session.email not in STAFF:
        raise MailError("Kontakt din mailadministrator om gendannelse af kontoen.", 403)
    destination = recovery_address(data.get("email"))
    if destination.rpartition("@")[2] in {address.rpartition("@")[2] for address in STAFF}:
        raise MailError("Brug en ekstern mailadresse, som du også kan åbne uden adgang til Veyro Mail.", 422)
    password = data.get("currentPassword")
    if not isinstance(password, str) or not 1 <= len(password) <= 1024 or any(c in password for c in "\0\r\n"):
        raise MailError("Indtast din nuværende adgangskode.", 403)
    try:
        password.encode("utf-8")
    except UnicodeEncodeError:
        raise MailError("Adgangskoden kunne ikke læses.", 422) from None
    with account_lock(session.email), session.lock:
        with TABLE:
            if SESSIONS.get(g.sid) is not session:
                raise MailError("Log ind igen.", 401)
        if not safe_equal(password, session.password()):
            raise MailError("Den nuværende adgangskode er forkert.", 403)
        yield session, destination, password


def recovery_digest(sid, destination, code):
    return hmac.digest(RECOVERY_KEY, "\0".join((sid, destination, code)).encode(), "sha256")


def clear_enrollments(address):
    # Called under this account's lock, which also protects its pending proofs.
    with TABLE:
        for session in SESSIONS.values():
            if session.email == address:
                session.recovery = None


@app.post("/api/recovery/enroll/start")
def start_recovery_enrollment():
    throttle(("recovery-start", g.session.email), 5, 900)
    throttle(("recovery-start-ip", g.ip), 10, 900)
    data = payload()
    if set(data) != {"email", "currentPassword"}:
        raise MailError("Skriv din eksterne mailadresse og nuværende adgangskode.")
    with enrollment(data) as (session, destination, password):
        with account.Portal() as portal:
            page = portal.identify(session.email, password)
            if 'href="#pwRecoveryEmailModal"' not in page:
                raise MailError("Gendannelsesmail er ikke tilgængelig for denne konto. Kontakt administratoren.", 403)
        code = secrets.token_hex(6).upper()
        try:
            account.send_recovery_code(session.email, password, destination, code)
        except (OSError, smtplib.SMTPException):
            raise MailError("Bekræftelsesmailen kunne ikke afsendes. Kontrollér adressen, og prøv igen.", 502) from None
        clear_enrollments(session.email)
        session.recovery = {"digest": recovery_digest(g.sid, destination, code),
                            "expires": time.monotonic() + 600, "attempts": 5}
    return jsonify(ok=True)


@app.post("/api/recovery/enroll/confirm")
def confirm_recovery_enrollment():
    throttle(("recovery-confirm-ip", g.ip), 24, 900)
    throttle(("recovery-confirm", g.session.email), 15, 900)
    data = payload()
    if set(data) != {"email", "currentPassword", "code"} or not isinstance(data.get("code"), str):
        raise MailError("Skriv bekræftelseskoden fra din mail.")
    code = re.sub(r"[\s-]", "", data["code"]).upper()
    with enrollment(data) as (session, destination, password):
        challenge = session.recovery
        if not challenge or challenge["expires"] <= time.monotonic():
            session.recovery = None
            raise MailError("Koden er udløbet, eller der er ingen aktiv kode. Bed om en ny.", 422)
        challenge["attempts"] -= 1
        if not re.fullmatch(r"[0-9A-F]{12}", code) or not hmac.compare_digest(
                challenge["digest"], recovery_digest(g.sid, destination, code)):
            if not challenge["attempts"]:
                session.recovery = None
            raise MailError("Koden er forkert. Kontrollér koden, eller bed om en ny.", 422)
        # Consume the proof even if Mailcow commits the change and the response is lost.
        session.recovery = None
        with account.Portal() as portal:
            portal.identify(session.email, password)
            portal.set_recovery_address(session.email, password, destination)
        clear_enrollments(session.email)
    return jsonify(ok=True)


@app.post("/api/login")
def login():
    throttle(("ip", g.ip), 12, 300)
    data = payload()
    address, password = data.get("email"), data.get("password")
    if not isinstance(address, str) or not isinstance(password, str):
        raise MailError("Mailadresse eller adgangskode er forkert.", 401)
    if not 1 <= len(password) <= 1024 or any(c in password for c in "\0\r\n"):
        raise MailError("Mailadresse eller adgangskode er forkert.", 401)
    try:
        address = recovery_address(address).lower()
        password.encode("utf-8")
    except (MailError, UnicodeEncodeError):
        raise MailError("Mailadresse eller adgangskode er forkert.", 401) from None
    # Bound the login-specific limiter even when many nonexistent names are tried.
    throttle(("mailbox", hash(address) % 1024), 15, 300)
    # Serialize primary credential changes with admission of IMAP-backed sessions.
    with account_lock(address):
        return start_session(address, password)


def start_session(address, password):
    generation = credential_version(address)
    # Dovecot performs the same credential check for every valid mailbox name.
    # IMAP acceptance alone does not grant webmail or allow skipping native MFA.
    try:
        client = mailstore.connect(address, password)
    except LoginError:
        raise MailError("Mailadresse eller adgangskode er forkert.", 401) from None
    try:
        if not generation:
            raise MailError("Mailadresse eller adgangskode er forkert.", 401)
        if generation != credential_version(address):
            raise MailError("Adgangskoden er ændret. Log ind igen.", 401)
    except Exception:
        client.shutdown()
        raise
    current = Session(address, password, client, generation)
    sid = secrets.token_urlsafe(36)
    purge()
    with TABLE:
        if len(SESSIONS) >= 128:
            current.close()
            raise MailError("For mange aktive sessioner. Prøv igen senere.", 503)
        old = SESSIONS.pop(request.cookies.get(COOKIE, ""), None)
        SESSIONS[sid] = current
    if old:
        with old.lock:
            old.close()
            old.secret = b""
    response = jsonify(public_session(current))
    response.set_cookie(COOKIE, sid, secure=True, httponly=True, samesite="Lax", path="/")
    return response


@app.post("/api/password")
def password_change():
    data = payload()
    current, new = data.get("currentPassword"), data.get("newPassword")
    if set(data) != {"currentPassword", "newPassword"} or not isinstance(current, str) or not isinstance(new, str):
        raise MailError("Indtast den nuværende og den nye adgangskode.")
    if not current or len(current) > 1024 or any(c in current for c in "\0\r\n"):
        raise MailError("Den nuværende adgangskode er forkert.", 403)
    try:
        length = len(new.encode("utf-8"))
        current.encode("utf-8")
    except UnicodeEncodeError:
        raise MailError("Adgangskoden indeholder et ugyldigt tegn.", 422) from None
    if not length or length > 72:
        raise MailError("Den nye adgangskode skal udfyldes og må højst fylde 72 byte. Æ, ø og å fylder to byte hver.", 422)
    if new == "0" or re.match(r"^\{[A-Za-z0-9-]+\}", new) or any(c in new for c in "\0\r\n"):
        raise MailError("Vælg en anden adgangskode. Formatet understøttes ikke.", 422)
    if safe_equal(current, new):
        raise MailError("Vælg en anden adgangskode end den nuværende.", 422)
    session = g.session
    throttle(("change-account", session.email), 6, 300)
    throttle(("change-ip", g.ip), 12, 300)
    failure = None
    with account_lock(session.email):
        with session.lock:
            with TABLE:
                if SESSIONS.get(g.sid) is not session:
                    raise MailError("Log ind igen.", 401)
            if not safe_equal(current, session.password()):
                raise MailError("Den nuværende adgangskode er forkert. Log ind med mailkontoens egen adgangskode for at skifte den.", 403)
            try:
                account.change_password(session.email, current, new)
            except account.ChangeUnconfirmed as exc:
                failure = exc
            with TABLE:
                revoked = [SESSIONS.pop(k) for k, s in list(SESSIONS.items()) if s.email == session.email]
        for other in revoked:
            with other.lock:
                other.close()
                other.secret = b""
    response = jsonify(error=failure.message, loginRequired=True) if failure else jsonify(ok=True)
    if failure:
        response.status_code = failure.status
    response.delete_cookie(COOKIE, path="/", secure=True, httponly=True, samesite="Lax")
    return response


@app.get("/api/session")
def session():
    return jsonify(public_session(g.session))


@contextmanager
def organization_access(*fields, platform_only=False):
    current = g.session
    role, domain = administration_scope(current.email)
    if role == "none" or (platform_only and role != "platform"):
        raise MailError("Du har ikke adgang til mailadministrationen.", 403)
    write = request.method == "POST"
    if write:
        throttle(("organization-write", current.email), 30, 300)
        data = payload().copy()
        supplied = data.pop("currentPassword", None)
        if request.args or set(data) != set(fields):
            raise MailError("Ugyldige felter til mailadministration.", 422)
    else:
        data = request.args.to_dict()
        if set(data) != set(fields) or any(len(request.args.getlist(k)) != 1 for k in data):
            raise MailError("Ugyldige felter til mailadministration.", 422)
    if role == "organization" and "domain" in data and data["domain"] != domain:
        raise MailError("Du kan kun administrere din egen virksomhed.", 403)
    if "active" in data:
        if type(data["active"]) is not bool:
            raise MailError("Vælg en gyldig postkassestatus.", 422)
        if data["active"] and role == "organization":
            raise MailError("Kun Veyro kan genaktivere en postkasse.", 403)
    if "admin" in data and type(data["admin"]) is not bool:
        raise MailError("Vælg en gyldig administratorrolle.", 422)
    addresses = [current.email]
    if "email" in data:
        address = recovery_address(data["email"]).lower()
        if address in (current.email, ORGANIZATION_ADMIN) or address.rpartition("@")[2] != data["domain"]:
            raise MailError("Denne postkasse kan ikke ændres her.", 422)
        data["email"] = address
        addresses.append(address)
    with ExitStack() as locks:
        # All targeted operations use the same ordering, including colliding lock stripes.
        for index in sorted({hash(address) % len(ACCOUNT_LOCKS) for address in addresses}):
            locks.enter_context(ACCOUNT_LOCKS[index])
        locks.enter_context(current.lock)
        with TABLE:
            if SESSIONS.get(g.sid) is not current or not current.secret:
                raise MailError("Log ind igen.", 401)
        password = current.password()
        if write and not safe_equal(supplied, password):
            throttle(("organization-password", current.email), 6, 300)
            raise MailError("Indtast din egen nuværende adgangskode for at godkende ændringen.", 403)
        if write or current.admin_verified_at is None or time.monotonic() - current.admin_verified_at > 300:
            throttle(("organization-native", current.email), 45, 300)
            # Staff can use an IMAP app password for ordinary mail. Administration
            # requires the primary credential, with the native security checks complete.
            try:
                with account.Portal() as portal:
                    portal.identify(current.email, password, allow_password_change=False)
            except MailError:
                raise MailError("Log ind med mailkontoens egen adgangskode, og fuldfør Mailcows sikkerhedskontrol for at administrere.", 403) from None
            except (OSError, ValueError, http.client.HTTPException):
                raise MailError("Mailserveren kunne ikke bekræfte din administratoradgang. Prøv igen.", 503) from None
            current.admin_verified_at = time.monotonic()
        yield data


def public_mailbox(record):
    return dict(email=record["address"], name=record["name"], active=record["active"],
                quotaMiB=record["quotaMiB"], protected=record["protected"],
                organizationAdmin=record["organizationAdmin"])


def broker(path, data):
    return org_admin_client.call(path, data, actor=g.session.email)


def update_mailbox(path, data):
    record = broker(path, data).get("mailbox")
    if not isinstance(record, dict) or record.get("address") != data["email"]:
        raise MailError("Kontrollér postkassen, før du prøver igen.", 503)
    return record


@app.get("/api/admin/organizations")
def admin_organizations():
    with organization_access():
        return jsonify(organizations=broker("/organizations/list", {})["organizations"])


@app.post("/api/admin/organizations")
def admin_organization_create():
    with organization_access("domain", "name", platform_only=True) as data:
        try:
            record = broker("/organizations/create", data)["organization"]
        except org_admin_client.DomainProofRequired as exc:
            return jsonify(error=exc.message, dnsChallenge=exc.challenge), 409
        log.info("Mail administration: organization provisioned by %s: %s", g.session.email, record["domain"])
        return jsonify(organization=record)


@app.get("/api/admin/mailboxes")
def admin_mailboxes():
    with organization_access("domain") as data:
        records = broker("/mailboxes/list", data)["mailboxes"]
        return jsonify(mailboxes=[public_mailbox(row) for row in records])


@app.get("/api/admin/dns")
def admin_domain_dns():
    with organization_access("domain", platform_only=True) as data:
        return jsonify(dns=broker("/organizations/dns", data)["dns"])


@app.post("/api/admin/mailboxes")
def admin_mailbox_create():
    with organization_access("domain", "localPart", "name", "password") as data:
        record = broker("/mailboxes/create", data)["mailbox"]
        log.info("Mail administration: mailbox provisioned by %s: %s", g.session.email, record["address"])
        return jsonify(mailbox=public_mailbox(record))


@app.post("/api/admin/mailboxes/status")
def admin_mailbox_status():
    with organization_access("domain", "email", "active") as data:
        address = data["email"]
        previous = credential_version(address) if not data["active"] else None
        try:
            record = update_mailbox("/mailboxes/status", data)
            if record.get("active") is not data["active"]:
                raise MailError("Kontrollér postkassens status før du prøver igen.", 503)
        except MailError as exc:
            if exc.status == 503 and previous is not None and credential_version(address) != previous:
                retire_mailbox_access(address)
            raise
        else:
            if not record["active"]:
                retire_mailbox_access(address)
        log.info("Mail administration: status set by %s: %s active=%s", g.session.email, address, record["active"])
        return jsonify(mailbox=public_mailbox(record))


@app.post("/api/admin/mailboxes/password")
def admin_mailbox_password():
    with organization_access("domain", "email", "newPassword") as data:
        address = data["email"]
        previous = credential_version(address)
        try:
            record = update_mailbox("/mailboxes/password", {"domain": data["domain"], "email": address,
                                                            "password": data["newPassword"]})
        except MailError as exc:
            # If Mailcow committed the password before a response was lost, retire
            # access just as on success. Never log out an unauthorized target.
            if exc.status == 503 and previous is not None and credential_version(address) != previous:
                retire_mailbox_access(address)
            raise
        retire_mailbox_access(address)
        log.info("Mail administration: password reset by %s: %s", g.session.email, address)
        return jsonify(mailbox=public_mailbox(record))


@app.post("/api/admin/mailboxes/role")
def admin_mailbox_role():
    with organization_access("domain", "email", "admin", platform_only=True) as data:
        try:
            record = update_mailbox("/mailboxes/role", data)
            if record.get("organizationAdmin") is not data["admin"]:
                raise MailError("Kontrollér administratorrollen, før du prøver igen.", 503)
        except MailError as exc:
            # A grant may already have committed before a timeout. Require a fresh
            # sign-in even then, so an older session cannot inherit the new role.
            if exc.status == 503:
                close_mailbox_sessions(data["email"])
            raise
        close_mailbox_sessions(data["email"])
        log.info("Mail administration: organization admin set by %s: %s admin=%s",
                 g.session.email, data["email"], data["admin"])
        return jsonify(mailbox=public_mailbox(record))


def close_mailbox_sessions(address):
    with TABLE:
        retired = [SESSIONS.pop(k) for k, s in list(SESSIONS.items()) if s.email == address]
    for other in retired:
        with other.lock:
            other.close()
            other.secret = b""
            other.recovery = None


def retire_mailbox_access(address):
    close_mailbox_sessions(address)
    revoke_ai_for_mailbox(address)


@app.post("/api/logout")
def logout():
    with TABLE:
        SESSIONS.pop(g.sid, None)
    with g.session.lock:
        g.session.close()
        g.session.secret = b""
    response = jsonify(ok=True)
    response.delete_cookie(COOKIE, path="/", secure=True, httponly=True, samesite="Lax")
    return response


def operation(fn, retry=True):
    current = g.session
    if not current.lock.acquire(timeout=15):
        raise MailError("Postkassen er optaget. Prøv igen.", 503)
    try:
        with TABLE:
            if SESSIONS.get(g.sid) is not current or not current.secret:
                raise MailError("Log ind igen.", 401)
        for attempt in range(2):
            try:
                return fn(current.imap())
            except LoginError:
                current.close()
                with TABLE:
                    SESSIONS.pop(g.sid, None)
                current.secret = b""
                raise MailError("Log ind igen.", 401) from None
            except (IMAPClientAbortError, OSError):
                current.close()
                if attempt or not retry:
                    raise
    finally:
        current.lock.release()


def folder():
    return mailstore.folder_name(request.args.get("folder"))


@app.get("/api/folders")
def folders():
    return jsonify(folders=operation(g.session.cached_folders))


@app.get("/api/messages")
def messages():
    q = request.args.get("q", "").strip()
    if len(q) > 180 or any(ord(c)<32 for c in q):
        raise MailError("Ugyldig søgning.")
    source = folder()
    view = request.args.get("view", "")
    return jsonify(operation(lambda c: mailstore.list_messages(
        c, source, request.args.get("cursor"), q, address=g.session.email,
        sender=request.args.get("sender", ""), label=request.args.get("label", ""),
        category=request.args.get("category", ""), view=view, only_snoozed=view == "snoozed",
        snoozed=(lambda validity: snooze.active(g.session.email, validity)) if source.upper() == "INBOX" else None,
    )))


@app.get("/api/messages/<identifier>")
def message(identifier):
    def read(c):
        source = folder()
        # Use Dovecot's special-use folder, including localized names.
        folders = g.session.folders if g.session.folders is not None else g.session.cached_folders(c)
        in_junk = any(f["name"] == source and f["role"] == "junk" for f in folders)
        result = mailstore.read_message(c, source, identifier, address=g.session.email, inspect_content=True, in_junk=in_junk)
        g.session.folder_time = 0
        return result
    return jsonify(operation(read))


@app.post("/api/messages/<identifier>/action")
def message_action(identifier):
    data = payload()
    def apply(c):
        folders = g.session.cached_folders(c) if data.get("action") in ("archive", "trash", "move") else ()
        result = mailstore.message_action(c, folder(), identifier, data, folders)
        g.session.folder_time = 0
        return result
    # If the server moved the UID but its reply was lost, retrying it could
    # report a misleading not-found result instead of an uncertain outcome.
    return jsonify(operation(apply, retry=False))


@app.get("/api/messages/<identifier>/attachments/<part>")
def attachment(identifier, part):
    blob, name = operation(lambda c: mailstore.attachment(c, folder(), identifier, part))
    response = send_file(io.BytesIO(blob), mimetype="application/octet-stream", as_attachment=True, download_name=name, etag=False)
    response.headers["Content-Security-Policy"] = "sandbox"
    return response


@app.post("/api/messages/<identifier>/snooze")
def snooze_message(identifier):
    if folder() != "INBOX":
        raise MailError("Du kan udsætte mails fra indbakken.")
    data = payload()
    if "until" not in data:
        raise MailError("Vælg hvornår mailen skal vises igen.")
    wake_at = snooze.wake_time(data["until"])

    def update(client):
        validity, uid, _ = mailstore.lookup(client, "INBOX", identifier)
        snooze.save(g.session.email, validity, uid, wake_at)
    operation(update)
    return jsonify(ok=True)


@app.post("/api/send")
def send():
    data = payload()
    supplied = request.headers.get("Idempotency-Key")
    cache_key = None
    if supplied:
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,100}", supplied):
            raise MailError("Ugyldig afsendelsesnøgle.")
        cache_key = (g.session.email, supplied)
        digest = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).digest()
        with TABLE:
            old = DELIVERIES.get(cache_key)
            if old:
                if old["digest"] != digest:
                    raise MailError("Afsendelsesnøglen er allerede brugt til en anden besked.", 409)
                if old.get("uncertain"):
                    raise mailstore.DeliveryUncertain()
                if "result" in old:
                    return jsonify(old["result"])
                raise MailError("Beskeden er ved at blive afsendt.", 409)
            if len(DELIVERIES) >= 1024:
                raise MailError("Prøv igen senere.", 503)
            DELIVERIES[cache_key] = {"digest": digest, "at": time.monotonic()}
    def deliver(c):
        try:
            result = mailstore.send_message(c, g.session.email, g.session.password(), data, g.session.cached_folders(c))
        except smtplib.SMTPRecipientsRefused:
            raise MailError("Mailserveren afviste modtagerne.", 422) from None
        except smtplib.SMTPAuthenticationError:
            raise MailError("Postkassen har ikke tilladelse til SMTP med denne adgangskode.", 403) from None
        g.session.folder_time = 0
        return result
    try:
        throttle(("send", g.session.email), 40, 3600)
        result = operation(deliver, retry=False)
    except mailstore.DeliveryUncertain:
        if cache_key:
            with TABLE:
                DELIVERIES[cache_key]["uncertain"] = True
        raise
    except Exception:
        if cache_key:
            with TABLE:
                DELIVERIES.pop(cache_key, None)
        raise
    if cache_key:
        with TABLE:
            DELIVERIES[cache_key]["result"] = result
    return jsonify(result)
