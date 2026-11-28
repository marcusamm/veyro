"""Scheduled mail and subscription discovery for authenticated Veyro mailboxes."""
import base64
from contextlib import closing, contextmanager
import email.policy
from email.parser import BytesHeaderParser
from email.utils import getaddresses
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import parse_qs, unquote, urlsplit
import uuid

from cryptography.fernet import Fernet
from mailstore import MailError

DAY = 86400
MAX_MAIL_BYTES = 24 * 1024 * 1024
KEY_FILE = "/run/veyro/remembered-session-key"
DB_FILE = "/var/lib/veyro-webmail/scheduled.sqlite3"


class Schedule:
    def __init__(self, database=DB_FILE, key_file=KEY_FILE, clock=time.time):
        self.database, self.key_file, self.clock = Path(database), Path(key_file), clock

    def keys(self):
        try:
            master = base64.b64decode(self.key_file.read_bytes().strip(), altchars=b"-_", validate=True)
            if len(master) != 32:
                raise ValueError()
            encryption = hmac.digest(master, b"veyro/scheduled/mail/v1", "sha256")
            index = hmac.digest(master, b"veyro/scheduled/account/v1", "sha256")
            return Fernet(base64.urlsafe_b64encode(encryption)), index
        except (OSError, ValueError):
            raise MailError("Planlagt afsendelse er midlertidigt utilgængelig.", 503) from None

    @contextmanager
    def connection(self):
        try:
            os.close(os.open(self.database, os.O_CREAT | os.O_RDWR, 0o600))
            with closing(sqlite3.connect(self.database, timeout=5)) as db:
                db.row_factory = sqlite3.Row
                db.execute("PRAGMA secure_delete=ON")
                db.execute("PRAGMA max_page_count=65536")  # 256 MiB on the default 4 KiB pages.
                db.execute("""CREATE TABLE IF NOT EXISTS scheduled (
                    id TEXT PRIMARY KEY, owner BLOB NOT NULL, request_key TEXT NOT NULL,
                    digest BLOB NOT NULL, due INTEGER NOT NULL, status TEXT NOT NULL,
                    updated INTEGER NOT NULL, summary BLOB NOT NULL, delivery BLOB,
                    UNIQUE(owner,request_key))""")
                db.execute("CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled(status,due)")
                db.execute("BEGIN IMMEDIATE")
                now = int(self.clock())
                db.execute("UPDATE scheduled SET status='unknown', updated=? WHERE status='sending' AND updated<?",
                           (now, now-600))
                db.execute("DELETE FROM scheduled WHERE status NOT IN ('pending','sending') AND updated<?", (now-30*DAY,))
                yield db
                db.commit()
        except (OSError, sqlite3.Error):
            raise MailError("Køen til planlagt mail er midlertidigt utilgængelig.", 503) from None

    @staticmethod
    def account_index(key, address, generation):
        # A reassigned/reset mailbox cannot inspect the previous account's queue.
        return hmac.digest(key, (address+"\x00"+generation).encode(), "sha256")

    def add(self, address, generation, password, key, due, data, prepare):
        now = int(self.clock())
        if not isinstance(key, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{16,100}", key):
            raise MailError("Ugyldig afsendelsesnøgle.")
        if type(due) is not int or not isinstance(data, dict):
            raise MailError("Vælg en dato og en mail at sende.")
        cipher, index = self.keys()
        owner = self.account_index(index, address, generation)
        digest = hmac.digest(index, json.dumps([due,data], sort_keys=True).encode(), "sha256")

        def previous(db):
            existing = db.execute("SELECT id,digest,status FROM scheduled WHERE owner=? AND request_key=?", (owner,key)).fetchone()
            if existing and existing["digest"] != digest:
                raise MailError("Afsendelsesnøglen tilhører en anden mail.", 409)
            return dict(id=existing["id"], status=existing["status"]) if existing else None

        with self.connection() as db:
            old = previous(db)
        if old:
            return old
        if not now < due <= now + 30*DAY:
            raise MailError("Vælg et tidspunkt inden for de næste 30 dage.")
        msg, recipients = prepare()
        raw = msg.as_bytes()
        if len(raw) > MAX_MAIL_BYTES:
            raise MailError("Mailen er for stor til planlagt afsendelse.", 413)
        ident = str(uuid.uuid4())
        head = dict(id=ident, address=address, generation=generation, password=password, recipients=recipients)
        delivery = cipher.encrypt(json.dumps(head).encode() + b"\n" + raw)
        summary = cipher.encrypt(json.dumps(dict(id=ident, address=address, subject=str(msg["Subject"] or ""), to=str(msg["To"]))).encode())
        with self.connection() as db:
            old = previous(db)
            if old:
                return old
            count = db.execute("SELECT COUNT(*) FROM scheduled WHERE owner=? AND status IN ('pending','sending')", (owner,)).fetchone()[0]
            if count >= 50:
                raise MailError("Du har allerede 50 planlagte mails.", 429)
            stored = db.execute("SELECT COALESCE(SUM(length(delivery)),0) FROM scheduled").fetchone()[0]
            if stored + len(delivery) > 180 * 1024 * 1024:
                raise MailError("Der er ikke plads til flere planlagte mails lige nu.", 503)
            db.execute("INSERT INTO scheduled VALUES(?,?,?,?,?,'pending',?,?,?)", (ident,owner,key,digest,due,now,summary,delivery))
        return dict(id=ident,status="pending")

    def listing(self, address, generation):
        cipher, index = self.keys()
        owner = self.account_index(index, address, generation)
        with self.connection() as db:
            rows = db.execute("""SELECT id,due,status,summary FROM scheduled WHERE owner=? AND
                                 status NOT IN ('sent','cancelled') ORDER BY (status='pending') DESC, due""", (owner,)).fetchall()
        result = []
        for row in rows:
            summary = json.loads(cipher.decrypt(row["summary"]))
            if summary["id"] != row["id"] or summary["address"] != address:
                raise MailError("Den planlagte mail kunne ikke læses.", 503)
            result.append(dict(id=row["id"], at=row["due"], status=row["status"], subject=summary["subject"], to=summary["to"]))
        return result

    def cancel(self, address, generation, ident):
        _, index = self.keys()
        owner = self.account_index(index, address, generation)
        with self.connection() as db:
            row = db.execute("SELECT status FROM scheduled WHERE owner=? AND id=?", (owner,ident)).fetchone()
            if not row:
                raise MailError("Den planlagte mail findes ikke.", 404)
            if row["status"] == "cancelled":
                return
            if row["status"] != "pending":
                raise MailError("Mailen kan ikke længere annulleres.", 409)
            db.execute("UPDATE scheduled SET delivery=NULL,status='cancelled',updated=? WHERE id=?", (int(self.clock()),ident))

    def deliver_one(self, send):
        if not self.database.exists():
            return False
        cipher, index = self.keys()
        now = int(self.clock())
        with self.connection() as db:
            row = db.execute("""SELECT id,owner,delivery FROM scheduled WHERE status='pending' AND due<=?
                                ORDER BY due LIMIT 1""", (now,)).fetchone()
            if not row:
                return False
            # Commit the single claim and erase the on-disk credentials before SMTP.
            # A crash after SMTP acceptance is indistinguishable from a lost reply.
            db.execute("UPDATE scheduled SET status='sending',delivery=NULL,updated=? WHERE id=?", (now,row["id"]))
        status = "failed"
        try:
            header, raw = cipher.decrypt(row["delivery"]).split(b"\n", 1)
            head = json.loads(header)
            if head["id"] == row["id"] and self.account_index(index,head["address"],head["generation"]) == row["owner"]:
                status = send(head, raw)
        finally:
            with self.connection() as db:
                db.execute("UPDATE scheduled SET status=?,updated=? WHERE id=? AND status='sending'",
                           (status,int(self.clock()),row["id"]))
        return True


def unsubscribe_targets(value):
    targets = []
    for raw in re.findall(r"<([^<>\s]{1,2048})>", value or "")[:8]:
        try:
            parsed = urlsplit(raw)
            if parsed.scheme == "https" and parsed.hostname and "." in parsed.hostname and not parsed.username and not parsed.password and not any(c in raw for c in "\\\r\n\x00"):
                targets.append(dict(kind="web", value=raw, host=parsed.hostname))
            elif parsed.scheme == "mailto" and not parsed.netloc:
                address = unquote(parsed.path)
                if not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",address):
                    continue
                query = parse_qs(parsed.query, max_num_fields=12)
                subject = query.get("subject",["Afmeld"])[0]
                body = query.get("body",["Afmeld mig venligst fra denne liste."])[0]
                if not re.search(r"[\x00-\x1f\x7f]",subject) and "\x00" not in body:
                    targets.append(dict(kind="mail", value=address, subject=subject[:500], body=body[:2000]))
        except ValueError:
            continue
    return targets


def subscriptions(client, cursor):
    box = client.select_folder("INBOX", readonly=True)
    validity = int(box[b"UIDVALIDITY"])
    before = 4294967295
    if cursor:
        match = re.fullmatch(r"(\d{1,10})\.(\d{1,10})",cursor)
        if not match or int(match[1]) != validity or not 1 <= int(match[2]) <= 4294967295:
            raise MailError("Indbakken har ændret sig. Åbn abonnementerne igen.", 409)
        before = int(match[2])
    uids = sorted(client.search(["UID",f"1:{before}","HEADER","List-Unsubscribe",""]), reverse=True)
    page = uids[:80]
    rows = client.fetch(page, ["BODY.PEEK[HEADER.FIELDS (FROM LIST-ID LIST-UNSUBSCRIBE)]<0.8192>"]) if page else {}
    found = {}
    for uid in page:
        raw = next((v for k,v in rows.get(uid,{}).items() if isinstance(k,bytes) and k.startswith(b"BODY[HEADER.FIELDS")), None)
        if not isinstance(raw,bytes):
            continue
        headers = BytesHeaderParser(policy=email.policy.default).parsebytes(raw[:8192])
        addresses = getaddresses([str(headers.get("From",""))])
        name, address = addresses[0] if addresses else ("","")
        options = unsubscribe_targets(str(headers.get("List-Unsubscribe","")))
        if not options or not address:
            continue
        listid = str(headers.get("List-ID","")).strip()
        group = hashlib.sha256(json.dumps([address.casefold(),listid.casefold()]).encode()).hexdigest()
        if group not in found:
            target = next((x for x in options if x["kind"]=="web"), options[0])
            found[group] = dict(id=group, sender=address, name=name or address, list=listid[:256], target=target)
    return dict(items=list(found.values()),next=f"{validity}.{page[-1]-1}" if len(uids)>len(page) and page[-1]>1 else None)
