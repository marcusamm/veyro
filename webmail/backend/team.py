"""Durable, tenant-scoped company chat, intranet posts and shared documents.

The Flask gateway authenticates and checks CSRF before these handlers run. Every
request then obtains current membership from the private provisioning broker.
Browser input is never allowed to select a tenant or an authenticated identity.
"""

import base64
import binascii
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import unicodedata
import uuid
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone

from flask import g, jsonify, request, send_file

import org_admin_client
from mailstore import MailError


DATABASE = "/var/lib/veyro-webmail/team/team.sqlite3"
FILE_LIMIT = 5 * 1024 * 1024
UPLOAD_LIMIT = 7 * 1024 * 1024
TENANT_FILE_LIMIT = 250 * 1024 * 1024
PAGE_SIZE = 50
TYPES = {
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".txt": "text/plain", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS channels (
 id TEXT PRIMARY KEY, tenant TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
 direct_key TEXT, author TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(tenant,direct_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS company_channel_name ON channels(tenant,lower(name)) WHERE type='channel';
CREATE TABLE IF NOT EXISTS participants (
 channel TEXT NOT NULL REFERENCES channels(id), email TEXT NOT NULL,
 PRIMARY KEY(channel,email)
);
CREATE TABLE IF NOT EXISTS messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 tenant TEXT NOT NULL, channel TEXT NOT NULL REFERENCES channels(id),
 author TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
 client_id TEXT NOT NULL, content_hash TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
 UNIQUE(tenant,author,client_id)
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(tenant,channel,seq);
CREATE TABLE IF NOT EXISTS reads (
 tenant TEXT NOT NULL, channel TEXT NOT NULL REFERENCES channels(id),
 email TEXT NOT NULL, last_seq INTEGER NOT NULL,
 PRIMARY KEY(tenant,channel,email)
);
CREATE TABLE IF NOT EXISTS posts (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, tenant TEXT NOT NULL,
 author TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, pinned INTEGER NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL,
 deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS posts_tenant ON posts(tenant,seq);
CREATE TABLE IF NOT EXISTS files (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, tenant TEXT NOT NULL,
 author TEXT NOT NULL, name TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL,
 created_at TEXT NOT NULL, data BLOB, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS files_tenant ON files(tenant,seq);
CREATE TABLE IF NOT EXISTS post_files (
 post TEXT NOT NULL REFERENCES posts(id), file TEXT NOT NULL REFERENCES files(id),
 PRIMARY KEY(post,file)
);
CREATE TABLE IF NOT EXISTS audit (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, actor TEXT NOT NULL,
 action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL
);
"""


class Store:
    def __init__(self, database=DATABASE):
        self.database = Path(database)

    @contextmanager
    def connection(self):
        db = None
        try:
            self.database.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(self.database.parent, 0o700)
            fd = os.open(self.database, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            os.chmod(self.database, 0o600)
            db = sqlite3.connect(self.database, timeout=5)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA secure_delete=ON")
            db.execute("PRAGMA max_page_count=262144")  # Bound the store to ~1 GiB.
            db.executescript(SCHEMA)
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except (OSError, sqlite3.Error):
            raise MailError("Teamområdet er midlertidigt utilgængeligt. Prøv igen.", 503) from None
        finally:
            if db is not None:
                db.close()  # Roll back incomplete operations, including MailError.


STORE = Store()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def identifier(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError):
        raise MailError("Ugyldigt id.", 400) from None
    return value


def text(value, maximum, *, empty=False):
    if not isinstance(value, str):
        raise MailError("Ugyldig tekst.", 400)
    value = value.strip()
    if (not empty and not value) or len(value) > maximum or any(
            unicodedata.category(c) in {"Cc", "Cs"} and c not in "\n\t" for c in value):
        raise MailError("Teksten er tom, for lang eller indeholder ugyldige tegn.", 400)
    return value


def payload(required=(), optional=()):
    data = request.get_json(silent=True)
    if (not isinstance(data, dict) or not set(required) <= set(data)
            or set(data) - set(required) - set(optional)):
        raise MailError("Ugyldige oplysninger.", 400)
    return data


def directory():
    if hasattr(g, "team_directory"):
        return g.team_directory
    actor = g.session.email
    result = org_admin_client.call("/team/directory", {}, actor=actor)
    domain = actor.rsplit("@", 1)[-1]
    rows = result.get("members")
    if (result.get("email") != actor or result.get("domain") != domain
            or type(result.get("canManage")) is not bool or not isinstance(rows, list)
            or not rows or len(rows) > 10000):
        raise MailError("Virksomhedens medarbejdere kunne ikke kontrolleres.", 503)
    seen = set()
    for row in rows:
        if (not isinstance(row, dict) or not isinstance(row.get("email"), str)
                or row["email"].count("@") != 1 or row["email"].rsplit("@", 1)[1] != domain
                or row["email"] != row["email"].lower() or row["email"] in seen
                or not isinstance(row.get("name"), str)):
            raise MailError("Virksomhedens medarbejdere kunne ikke kontrolleres.", 503)
        seen.add(row["email"])
    if actor not in seen:
        raise MailError("Du har ikke adgang til virksomhedens teamområde.", 403)
    g.team_directory = {**result, "emails": seen}
    return g.team_directory


def audit(db, scope, action, target):
    db.execute("INSERT INTO audit(tenant,actor,action,target,created_at) VALUES(?,?,?,?,?)",
               (scope["domain"], scope["email"], action, target, now()))


def channel(db, scope, value):
    row = db.execute("SELECT * FROM channels WHERE tenant=? AND id=?",
                     (scope["domain"], identifier(value))).fetchone()
    if row is None:
        raise MailError("Samtalen blev ikke fundet.", 404)
    if row["type"] == "direct":
        participants = {r[0] for r in db.execute("SELECT email FROM participants WHERE channel=?", (row["id"],))}
        if scope["email"] not in participants:
            raise MailError("Samtalen blev ikke fundet.", 404)
        # Existing history remains available to active participants; revoked
        # colleagues lose all access through directory(), including downloads.
    return row


def channel_json(db, scope, row):
    members = [r[0] for r in db.execute("SELECT email FROM participants WHERE channel=? ORDER BY email", (row["id"],))]
    last = db.execute("SELECT id FROM messages WHERE tenant=? AND channel=? ORDER BY seq DESC LIMIT 1",
                      (scope["domain"], row["id"])).fetchone()
    read = db.execute("SELECT last_seq FROM reads WHERE tenant=? AND channel=? AND email=?",
                      (scope["domain"], row["id"], scope["email"])).fetchone()
    unread = db.execute("SELECT count(*) FROM messages WHERE tenant=? AND channel=? AND seq>? AND author<>? AND deleted=0",
                        (scope["domain"], row["id"], read[0] if read else 0, scope["email"])).fetchone()[0]
    return {"id": row["id"], "name": row["name"], "type": row["type"], "members": members,
            "lastId": last[0] if last else None, "unread": unread}


def message_json(row):
    return {"id": row["id"], "channel": row["channel"], "author": row["author"],
            "text": row["text"], "createdAt": row["created_at"], "deleted": bool(row["deleted"])}


def file_json(row):
    return {"id": row["id"], "name": row["name"], "contentType": row["content_type"],
            "size": row["size"], "author": row["author"], "createdAt": row["created_at"]}


def post_json(db, row):
    files = db.execute("SELECT f.id,f.name,f.content_type,f.size,f.author,f.created_at FROM files f JOIN post_files pf ON pf.file=f.id WHERE pf.post=? AND f.tenant=? AND f.deleted=0",
                       (row["id"], row["tenant"])).fetchall()
    return {"id": row["id"], "title": row["title"], "body": row["body"], "pinned": bool(row["pinned"]),
            "author": row["author"], "createdAt": row["created_at"], "updatedAt": row["updated_at"],
            "version": row["version"], "attachments": [file_json(f) for f in files]}


def owner_or_manager(scope, row):
    if scope["email"] != row["author"] and not scope["canManage"]:
        raise MailError("Kun forfatteren eller virksomhedens administrator kan ændre dette.", 403)


def query():
    if set(request.args) - {"channel", "before", "q"}:
        raise MailError("Ugyldige søgeparametre.", 400)
    q = text(request.args.get("q", ""), 120, empty=True)
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def before_seq(db, table, scope, *, channel_id=None):
    before = request.args.get("before")
    if not before:
        return 9223372036854775807
    # Only constant, internal table names call this helper.
    sql = f"SELECT seq FROM {table} WHERE tenant=? AND id=?"
    params = [scope["domain"], identifier(before)]
    if channel_id:
        sql += " AND channel=?"
        params.append(channel_id)
    row = db.execute(sql, params).fetchone()
    if row is None:
        raise MailError("Siden blev ikke fundet.", 404)
    return row[0]


def attachment_ids(db, scope, values):
    if not isinstance(values, list) or len(values) > 10 or not all(isinstance(v, str) for v in values):
        raise MailError("Vælg højst 10 dokumenter.", 400)
    if len(set(values)) != len(values):
        raise MailError("Dokumenter må ikke gentages.", 400)
    for value in values:
        if not db.execute("SELECT 1 FROM files WHERE tenant=? AND id=? AND deleted=0",
                          (scope["domain"], identifier(value))).fetchone():
            raise MailError("Dokumentet blev ikke fundet.", 404)
    return values


def validate_file(data):
    name = text(data["name"], 180)
    if name in {".", ".."} or any(c in name for c in "/\\\n\t") or any(unicodedata.category(c).startswith("C") for c in name):
        raise MailError("Ugyldigt filnavn.", 400)
    suffix = Path(name).suffix.lower()
    mime = TYPES.get(suffix)
    if not mime or data["contentType"] != mime:
        raise MailError("Vælg PDF, et billede, TXT, DOCX eller XLSX.", 415)
    encoded = data["data"]
    if not isinstance(encoded, str) or len(encoded) > ((FILE_LIMIT + 2) // 3) * 4:
        raise MailError("Dokumenter må højst fylde 5 MB.", 413)
    try:
        binary = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise MailError("Dokumentet kunne ikke læses.", 400) from None
    if not binary or len(binary) > FILE_LIMIT:
        raise MailError("Dokumenter skal fylde mellem 1 byte og 5 MB.", 413)
    valid = False
    if suffix == ".pdf":
        valid = binary.startswith(b"%PDF-")
    elif suffix == ".png":
        valid = binary.startswith(b"\x89PNG\r\n\x1a\n")
    elif suffix in {".jpg", ".jpeg"}:
        valid = binary.startswith(b"\xff\xd8\xff")
    elif suffix == ".gif":
        valid = binary.startswith((b"GIF87a", b"GIF89a"))
    elif suffix == ".webp":
        valid = binary.startswith(b"RIFF") and binary[8:12] == b"WEBP"
    elif suffix == ".txt":
        try:
            decoded = binary.decode("utf-8")
            valid = not any(unicodedata.category(c) in {"Cc", "Cs"} and c not in "\r\n\t" for c in decoded)
        except UnicodeDecodeError:
            pass
    elif suffix in {".docx", ".xlsx"}:
        try:
            with zipfile.ZipFile(io.BytesIO(binary)) as archive:
                entries = archive.infolist()
                required = "word/document.xml" if suffix == ".docx" else "xl/workbook.xml"
                names = {item.filename for item in entries}
                valid = (len(entries) <= 2000 and required in names and "[Content_Types].xml" in names
                         and sum(item.file_size for item in entries) <= 50 * 1024 * 1024
                         and not any("vbaproject" in entry.lower() or entry.startswith("/") or ".." in entry.split("/")
                                     for entry in names))
        except (zipfile.BadZipFile, ValueError, OSError):
            pass
    if not valid:
        raise MailError("Filens indhold passer ikke til den valgte filtype.", 415)
    return name, mime, binary


def install(app, throttle):
    def limited(kind, maximum=60, seconds=60):
        throttle(("team", kind, g.session.email), maximum, seconds)
        return directory()

    @app.get("/api/team/bootstrap")
    def team_bootstrap():
        scope = limited("read", 240)
        with STORE.connection() as db:
            default_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, "veyro-team:" + scope["domain"]))
            db.execute("INSERT OR IGNORE INTO channels(id,tenant,name,type,author,created_at) VALUES(?,?,?,'channel',?,?)",
                       (default_id, scope["domain"], "Generelt", scope["email"], now()))
            rows = db.execute("SELECT * FROM channels WHERE tenant=? AND (type='channel' OR id IN (SELECT channel FROM participants WHERE email=?)) ORDER BY type,name,id",
                              (scope["domain"], scope["email"])).fetchall()
            channels = [channel_json(db, scope, row) for row in rows]
        return jsonify(email=scope["email"], domain=scope["domain"],
                            companyName=scope.get("companyName", scope["domain"]), canManage=scope["canManage"],
                            members=scope["members"], channels=channels)

    @app.post("/api/team/channels")
    def team_create_channel():
        scope = limited("channel", 20, 3600)
        data = payload(("type",), ("name", "members"))
        kind = data["type"]
        if not isinstance(kind, str) or kind not in {"channel", "direct"}:
            raise MailError("Ugyldig samtaletype.", 400)
        selected = data.get("members", [])
        if not isinstance(selected, list) or not all(isinstance(v, str) for v in selected) or len(selected) > 11:
            raise MailError("Vælg højst 11 kolleger.", 400)
        members = sorted(set(selected) | {scope["email"]}) if kind == "direct" else []
        if kind == "direct" and (len(members) < 2 or not set(members) <= scope["emails"]):
            raise MailError("Vælg aktive kolleger fra din virksomhed.", 400)
        if kind == "channel" and (not scope["canManage"] or selected):
            raise MailError("Kun virksomhedens administrator kan oprette fælles kanaler.", 403)
        name = text(data.get("name", ""), 80, empty=kind == "direct")
        direct_key = hashlib.sha256("\0".join(members).encode()).hexdigest() if kind == "direct" else None
        with STORE.connection() as db:
            if direct_key:
                old = db.execute("SELECT * FROM channels WHERE tenant=? AND direct_key=?", (scope["domain"], direct_key)).fetchone()
                if old:
                    return jsonify(channel=channel_json(db, scope, old))
            elif db.execute("SELECT 1 FROM channels WHERE tenant=? AND type='channel' AND lower(name)=lower(?)", (scope["domain"], name)).fetchone():
                raise MailError("Der findes allerede en kanal med det navn.", 409)
            count = db.execute("SELECT count(*) FROM channels WHERE tenant=?", (scope["domain"],)).fetchone()[0]
            if count >= 2000:
                raise MailError("Virksomhedens grænse for samtaler er nået.", 409)
            new_id = str(uuid.uuid4())
            db.execute("INSERT INTO channels(id,tenant,name,type,direct_key,author,created_at) VALUES(?,?,?,?,?,?,?)",
                       (new_id, scope["domain"], name, kind, direct_key, scope["email"], now()))
            db.executemany("INSERT INTO participants(channel,email) VALUES(?,?)", [(new_id, member) for member in members])
            audit(db, scope, "channel.create", new_id)
            result = channel_json(db, scope, channel(db, scope, new_id))
        return jsonify(channel=result), 201

    @app.get("/api/team/messages")
    def team_messages():
        scope = limited("read", 240)
        q = query()
        with STORE.connection() as db:
            row = channel(db, scope, request.args.get("channel"))
            before = before_seq(db, "messages", scope, channel_id=row["id"])
            rows = db.execute("SELECT * FROM messages WHERE tenant=? AND channel=? AND seq<? AND (text LIKE ? ESCAPE '\\' OR (?='%%' AND deleted=1)) ORDER BY seq DESC LIMIT ?",
                              (scope["domain"], row["id"], before, q, q, PAGE_SIZE + 1)).fetchall()
            shown = rows[:PAGE_SIZE]
            return jsonify(messages=[message_json(row) for row in reversed(shown)],
                           nextBefore=shown[-1]["id"] if len(rows) > PAGE_SIZE else None)

    @app.post("/api/team/messages")
    def team_send_message():
        scope = limited("message", 60)
        data = payload(("channel", "text", "clientId"))
        body = text(data["text"], 8000)
        client_id = identifier(data["clientId"])
        digest = hashlib.sha256(body.encode()).hexdigest()
        with STORE.connection() as db:
            row = channel(db, scope, data["channel"])
            if row["type"] == "direct":
                participants = {r[0] for r in db.execute("SELECT email FROM participants WHERE channel=?", (row["id"],))}
                if not participants <= scope["emails"]:
                    raise MailError("En deltager er ikke længere aktiv. Start en ny samtale med aktive kolleger.", 409)
            old = db.execute("SELECT * FROM messages WHERE tenant=? AND author=? AND client_id=?",
                             (scope["domain"], scope["email"], client_id)).fetchone()
            if old:
                if old["channel"] != row["id"] or old["content_hash"] != digest:
                    raise MailError("Beskedens id er allerede brugt til et andet indhold.", 409)
                return jsonify(message=message_json(old))
            new_id = str(uuid.uuid4())
            db.execute("INSERT INTO messages(id,tenant,channel,author,text,created_at,client_id,content_hash) VALUES(?,?,?,?,?,?,?,?)",
                       (new_id, scope["domain"], row["id"], scope["email"], body, now(), client_id, digest))
            audit(db, scope, "message.create", new_id)
            result = message_json(db.execute("SELECT * FROM messages WHERE tenant=? AND id=?", (scope["domain"], new_id)).fetchone())
        return jsonify(message=result), 201

    @app.post("/api/team/messages/<message_id>/delete")
    def team_delete_message(message_id):
        scope = limited("mutation", 60)
        payload()
        with STORE.connection() as db:
            row = db.execute("SELECT * FROM messages WHERE tenant=? AND id=?", (scope["domain"], identifier(message_id))).fetchone()
            if row is None:
                raise MailError("Beskeden blev ikke fundet.", 404)
            channel(db, scope, row["channel"])  # No admin bypass for a private DM.
            owner_or_manager(scope, row)
            db.execute("UPDATE messages SET text='',deleted=1 WHERE tenant=? AND id=?", (scope["domain"], message_id))
            audit(db, scope, "message.delete", message_id)
        return jsonify(ok=True)

    @app.post("/api/team/read")
    def team_read():
        scope = limited("readstate", 120)
        data = payload(("channel", "lastId"))
        with STORE.connection() as db:
            row = channel(db, scope, data["channel"])
            last = db.execute("SELECT seq FROM messages WHERE tenant=? AND channel=? AND id=?",
                              (scope["domain"], row["id"], identifier(data["lastId"]))).fetchone()
            if last is None:
                raise MailError("Beskeden blev ikke fundet.", 404)
            db.execute("INSERT INTO reads(tenant,channel,email,last_seq) VALUES(?,?,?,?) ON CONFLICT(tenant,channel,email) DO UPDATE SET last_seq=max(last_seq,excluded.last_seq)",
                       (scope["domain"], row["id"], scope["email"], last[0]))
        return jsonify(ok=True)

    @app.get("/api/team/posts")
    def team_posts():
        scope = limited("read", 240)
        q = query()
        with STORE.connection() as db:
            before = request.args.get("before")
            cursor = None
            if before:
                cursor = db.execute("SELECT pinned,seq FROM posts WHERE tenant=? AND id=?",
                                    (scope["domain"], identifier(before))).fetchone()
                if cursor is None:
                    raise MailError("Siden blev ikke fundet.", 404)
            cursor_pinned, cursor_seq = (cursor["pinned"], cursor["seq"]) if cursor else (2, 9223372036854775807)
            rows = db.execute("SELECT * FROM posts WHERE tenant=? AND deleted=0 AND (pinned<? OR (pinned=? AND seq<?)) AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY pinned DESC,seq DESC LIMIT ?",
                              (scope["domain"], cursor_pinned, cursor_pinned, cursor_seq, q, q, PAGE_SIZE + 1)).fetchall()
            shown = rows[:PAGE_SIZE]
            return jsonify(posts=[post_json(db, row) for row in shown], nextBefore=shown[-1]["id"] if len(rows) > PAGE_SIZE else None)

    def write_post(post_id=None):
        scope = limited("post", 30, 3600)
        required = ("title", "body", "version") if post_id else ("title", "body")
        data = payload(required, ("pinned", "attachments"))
        title, body = text(data["title"], 180), text(data["body"], 30000)
        if type(data.get("pinned", False)) is not bool:
            raise MailError("Ugyldig fastgørelse.", 400)
        with STORE.connection() as db:
            previous = None
            if post_id:
                previous = db.execute("SELECT * FROM posts WHERE tenant=? AND id=? AND deleted=0", (scope["domain"], identifier(post_id))).fetchone()
                if previous is None:
                    raise MailError("Opslaget blev ikke fundet.", 404)
                owner_or_manager(scope, previous)
                if type(data["version"]) is not int or data["version"] != previous["version"]:
                    raise MailError("Opslaget er ændret af en anden. Genindlæs før du gemmer.", 409)
            pinned = data.get("pinned", bool(previous["pinned"]) if previous else False)
            if not scope["canManage"] and pinned != (bool(previous["pinned"]) if previous else False):
                raise MailError("Kun virksomhedens administrator kan fastgøre opslag.", 403)
            files = attachment_ids(db, scope, data.get("attachments", []))
            updated = now()
            if previous:
                db.execute("UPDATE posts SET title=?,body=?,pinned=?,updated_at=?,version=version+1 WHERE tenant=? AND id=?",
                           (title, body, int(pinned), updated, scope["domain"], post_id))
                db.execute("DELETE FROM post_files WHERE post=?", (post_id,))
            else:
                post_id = str(uuid.uuid4())
                db.execute("INSERT INTO posts(id,tenant,author,title,body,pinned,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,1)",
                           (post_id, scope["domain"], scope["email"], title, body, int(pinned), updated, updated))
            db.executemany("INSERT INTO post_files(post,file) VALUES(?,?)", [(post_id, f) for f in files])
            audit(db, scope, "post.update" if previous else "post.create", post_id)
            result = post_json(db, db.execute("SELECT * FROM posts WHERE tenant=? AND id=?", (scope["domain"], post_id)).fetchone())
        return jsonify(post=result), 200 if previous else 201

    app.add_url_rule("/api/team/posts", "team_create_post", write_post, methods=["POST"])
    app.add_url_rule("/api/team/posts/<post_id>/update", "team_update_post", write_post, methods=["POST"])

    @app.post("/api/team/posts/<post_id>/delete")
    def team_delete_post(post_id):
        scope = limited("mutation", 60)
        data = payload((), ("version",))
        with STORE.connection() as db:
            row = db.execute("SELECT * FROM posts WHERE tenant=? AND id=? AND deleted=0", (scope["domain"], identifier(post_id))).fetchone()
            if row is None:
                raise MailError("Opslaget blev ikke fundet.", 404)
            owner_or_manager(scope, row)
            if "version" in data and (type(data["version"]) is not int or data["version"] != row["version"]):
                raise MailError("Opslaget er ændret. Genindlæs før du sletter.", 409)
            db.execute("UPDATE posts SET title='',body='',deleted=1,version=version+1 WHERE tenant=? AND id=?", (scope["domain"], post_id))
            db.execute("DELETE FROM post_files WHERE post=?", (post_id,))
            audit(db, scope, "post.delete", post_id)
        return jsonify(ok=True)

    @app.get("/api/team/files")
    def team_files():
        scope = limited("read", 240)
        q = query()
        with STORE.connection() as db:
            before = before_seq(db, "files", scope)
            rows = db.execute("SELECT id,name,content_type,size,author,created_at FROM files WHERE tenant=? AND deleted=0 AND seq<? AND name LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?",
                              (scope["domain"], before, q, PAGE_SIZE + 1)).fetchall()
            shown = rows[:PAGE_SIZE]
            return jsonify(files=[file_json(row) for row in shown], nextBefore=shown[-1]["id"] if len(rows) > PAGE_SIZE else None)

    @app.post("/api/team/files")
    def team_upload_file():
        scope = limited("upload", 20, 3600)
        data = payload(("name", "contentType", "data"))
        name, mime, binary = validate_file(data)
        with STORE.connection() as db:
            used = db.execute("SELECT coalesce(sum(size),0) FROM files WHERE tenant=? AND deleted=0", (scope["domain"],)).fetchone()[0]
            if used + len(binary) > TENANT_FILE_LIMIT:
                raise MailError("Virksomhedens dokumentplads er brugt op. Slet et dokument først.", 409)
            new_id = str(uuid.uuid4())
            db.execute("INSERT INTO files(id,tenant,author,name,content_type,size,created_at,data) VALUES(?,?,?,?,?,?,?,?)",
                       (new_id, scope["domain"], scope["email"], name, mime, len(binary), now(), binary))
            audit(db, scope, "file.create", new_id)
            result = file_json(db.execute("SELECT * FROM files WHERE tenant=? AND id=?", (scope["domain"], new_id)).fetchone())
        return jsonify(file=result), 201

    @app.get("/api/team/files/<file_id>")
    @app.get("/api/team/files/<file_id>/download")
    def team_download_file(file_id):
        scope = limited("download", 60)
        with STORE.connection() as db:
            row = db.execute("SELECT * FROM files WHERE tenant=? AND id=? AND deleted=0", (scope["domain"], identifier(file_id))).fetchone()
            if row is None:
                raise MailError("Dokumentet blev ikke fundet.", 404)
            response = send_file(io.BytesIO(row["data"]), mimetype=row["content_type"],
                                 download_name=row["name"], as_attachment=True, max_age=0)
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Content-Security-Policy"] = "sandbox; default-src 'none'"
            response.headers["Cache-Control"] = "no-store, private"
            return response

    @app.post("/api/team/files/<file_id>/delete")
    def team_delete_file(file_id):
        scope = limited("mutation", 60)
        payload()
        with STORE.connection() as db:
            row = db.execute("SELECT * FROM files WHERE tenant=? AND id=? AND deleted=0", (scope["domain"], identifier(file_id))).fetchone()
            if row is None:
                raise MailError("Dokumentet blev ikke fundet.", 404)
            owner_or_manager(scope, row)
            db.execute("DELETE FROM post_files WHERE file=?", (file_id,))
            db.execute("UPDATE files SET data=NULL,deleted=1 WHERE tenant=? AND id=?", (scope["domain"], file_id))
            audit(db, scope, "file.delete", file_id)
        return jsonify(ok=True)
