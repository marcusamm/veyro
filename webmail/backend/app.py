import hmac
import hashlib
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
from contextlib import contextmanager
from pathlib import Path
from queue import Full, Queue

from cryptography.fernet import Fernet
from flask import Flask, g, jsonify, request, send_file
from imapclient.exceptions import IMAPClientAbortError, LoginError
import pymysql
from werkzeug.exceptions import HTTPException

import account
import mailstore
from mailstore import MailError

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024
ORIGIN = os.environ["WEBMAIL_ORIGIN"]
STAFF = {address.strip().lower() for address in os.environ["WEBMAIL_STAFF"].split(",") if address.strip()}
ACCOUNT_LOCKS = {address: threading.Lock() for address in STAFF}
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
    return isinstance(a, str) and isinstance(b, str) and hmac.compare_digest(a.encode(), b.encode())


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
                cursor.execute("SELECT version FROM veyro_webmail_credential_version WHERE username=%s", (address,))
                row = cursor.fetchone()
        if row is None:
            return None
        if not isinstance(row[0], str) or not re.fullmatch(r"[0-9a-fA-F]{64}", row[0]):
            raise ValueError("Invalid credential version")
        return row[0]
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
    if request.method == "POST":
        if request.headers.get("Origin") != ORIGIN:
            raise MailError("Adgang afvist.", 403)
        if (request.path in {"/api/send", "/api/login", "/api/password"} or
                request.path.startswith("/api/recovery/")) and not request.is_json:
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


def public_session(s):
    return dict(email=s.email, csrfToken=s.csrf)


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
    with ACCOUNT_LOCKS[session.email], session.lock:
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
    address = address.strip().lower()
    if address not in STAFF or not 1 <= len(password) <= 1024 or any(c in password for c in "\0\r\n"):
        raise MailError("Mailadresse eller adgangskode er forkert.", 401)
    throttle(("mailbox", address), 15, 300)
    # Serialize primary credential changes with admission of IMAP-backed sessions.
    with ACCOUNT_LOCKS[address]:
        return start_session(address, password)


def start_session(address, password):
    generation = credential_version(address)
    if not generation:
        raise MailError("Mailadresse eller adgangskode er forkert.", 401)
    try:
        client = mailstore.connect(address, password)
    except LoginError:
        raise MailError("Mailadresse eller adgangskode er forkert.", 401) from None
    try:
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
    with ACCOUNT_LOCKS[session.email]:
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
    return jsonify(operation(lambda c: mailstore.list_messages(c, folder(), request.args.get("cursor"), q)))


@app.get("/api/messages/<identifier>")
def message(identifier):
    def read(c):
        result = mailstore.read_message(c, folder(), identifier)
        g.session.folder_time = 0
        return result
    return jsonify(operation(read))


@app.get("/api/messages/<identifier>/attachments/<part>")
def attachment(identifier, part):
    blob, name = operation(lambda c: mailstore.attachment(c, folder(), identifier, part))
    response = send_file(io.BytesIO(blob), mimetype="application/octet-stream", as_attachment=True, download_name=name, etag=False)
    response.headers["Content-Security-Policy"] = "sandbox"
    return response


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
