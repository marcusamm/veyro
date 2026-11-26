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
from pathlib import Path

from cryptography.fernet import Fernet
from flask import Flask, g, jsonify, request, send_file
from imapclient.exceptions import IMAPClientAbortError, LoginError
from werkzeug.exceptions import HTTPException

import account
import mailstore
from mailstore import MailError

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024
ORIGIN = os.environ["WEBMAIL_ORIGIN"]
STAFF = {address.strip().lower() for address in os.environ["WEBMAIL_STAFF"].split(",") if address.strip()}
ACCOUNT_LOCKS = {address: threading.Lock() for address in STAFF}
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
    def __init__(self, address, password, client):
        self.email = address
        self.secret = KEY.encrypt(password.encode())
        self.csrf = secrets.token_urlsafe(32)
        self.created = self.touched = self.connected = time.monotonic()
        self.client = client
        self.lock = threading.Lock()
        self.folders = None
        self.folder_time = 0

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
        if request.path in {"/api/send", "/api/login", "/api/password"} and not request.is_json:
            raise MailError("Der kræves JSON.", 415)
    if request.path == "/api/login":
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
    try:
        client = mailstore.connect(address, password)
    except LoginError:
        raise MailError("Mailadresse eller adgangskode er forkert.", 401) from None
    current = Session(address, password, client)
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
