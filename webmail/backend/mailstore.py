import base64
import binascii
import email.policy
import io
import quopri
import re
import smtplib
import ssl
import threading
import unicodedata
from dataclasses import dataclass
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.parser import BytesHeaderParser, BytesParser
from email.utils import formatdate, getaddresses, make_msgid, parsedate_to_datetime
from functools import lru_cache
from pathlib import Path

from imapclient import IMAPClient
from imapclient.exceptions import IMAPClientError
from PIL import Image

import message_view

HOST = "post.veyro.dk"
TRUST_FILE = Path("/run/veyro/mailcow-public.pem")
PAGE = 30
MAX_ATTACHMENT = 32 * 1024 * 1024
HEADERS = "BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO CC REPLY-TO DATE MESSAGE-ID REFERENCES CONTENT-TYPE CONTENT-TRANSFER-ENCODING)]"
FLAGS = {"inbox", "sent", "drafts", "trash", "junk", "archive"}
LABEL_PREFIX = b"veyro-label-"
TASK = b"veyro-task"
MUTED = b"veyro-muted"
CATEGORIES = {value: f"veyro-category-{value}".encode() for value in ("updates", "social", "promotions")}
MAX_FORWARD = 16 * 1024 * 1024
INLINE_FORMATS = {"image/png": "PNG", "image/jpeg": "JPEG", "image/gif": "GIF", "image/webp": "WEBP"}
INLINE_COUNT = 16
INLINE_SIZE = 1024 * 1024
INLINE_TOTAL = 3 * 1024 * 1024 - 1024  # Includes headroom for data URL prefixes in a 4 MiB HTML budget.
INLINE_WIRE_SIZE = INLINE_SIZE * 3 // 2  # MIME transfer encoding and line breaks.
INLINE_WIRE_TOTAL = 5 * 1024 * 1024
INLINE_PIXELS = 16 * 1024 * 1024
IMAGE_DECODERS = threading.BoundedSemaphore(2)
MIME_NODES = 256
MIME_DEPTH = 24
MIME_HEADER_READS = 8
MIME_HEADER_BYTES = 8192


class MailError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


@lru_cache(maxsize=2)
def _tls_context(version):
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=str(TRUST_FILE))
    context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    return context


def verified_tls():
    stat = TRUST_FILE.stat()
    return _tls_context((stat.st_ino, stat.st_mtime_ns))


def connect(email_address, password):
    client = IMAPClient(HOST, port=993, ssl_context=verified_tls(), timeout=15)
    try:
        if password.isascii():
            client.login(email_address, password)
        else:
            # IMAP LOGIN encodes commands as ASCII. SASL PLAIN carries UTF-8.
            client.plain_login(email_address, password)
        return client
    except Exception:
        client.shutdown()
        raise


def folder_id(name):
    return base64.urlsafe_b64encode(name.encode()).decode().rstrip("=")


def folder_name(value):
    if not isinstance(value, str) or len(value) > 1600 or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise MailError("Ugyldig mappe.")
    try:
        name = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode()
    except (UnicodeError, ValueError, binascii.Error):
        raise MailError("Ugyldig mappe.") from None
    if not name or any(ord(c) < 32 for c in name) or folder_id(name) != value:
        raise MailError("Ugyldig mappe.")
    return name


def decoded(value):
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    if not value:
        return ""
    try:
        return str(make_header(decode_header(str(value))))
    except (LookupError, ValueError, UnicodeError):
        return str(value)


def folder_list(client):
    result = []
    for flags, _, name in client.list_folders():
        labels = {f.decode("ascii", "ignore").lower().lstrip("\\") for f in flags}
        if "noselect" in labels or "nonexistent" in labels:
            continue
        role = "inbox" if name.upper() == "INBOX" else next((r for r in FLAGS if r in labels), "other")
        unseen = client.folder_status(name, ["UNSEEN"]).get(b"UNSEEN", 0)
        result.append(dict(id=folder_id(name), name=name, role=role, unread=unseen))
    return result


def headers(row):
    raw = next((v for k, v in row.items() if isinstance(k, bytes) and k.startswith(b"BODY[HEADER.FIELDS")), b"")
    return BytesHeaderParser(policy=email.policy.default).parsebytes(raw or b"")


def content_id(value):
    if isinstance(value, bytes):
        try:
            value = value.decode("ascii")
        except UnicodeDecodeError:
            return ""
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if value.startswith("<") and value.endswith(">"):
        value = value[1:-1]
    if not 1 <= len(value) <= 255 or not value.isascii() or not value.isprintable() or re.search(r"[\s<>]", value):
        return ""
    return value.casefold()


def mime_options(fields):
    if not isinstance(fields, (list, tuple)):
        return {}
    return {decoded(k).lower(): decoded(v) for k, v in zip(fields[::2], fields[1::2])}


@dataclass
class MimeWalk:
    nodes: int = 0
    header_reads: int = 0
    incomplete: bool = False


def read_container_ids(client, uid, paths):
    # Multipart containers have no Content-ID slot in BODYSTRUCTURE. Read just the MIME headers.
    query = [f"BODY.PEEK[{path}.MIME]<0.{MIME_HEADER_BYTES}>" for path in paths]
    try:
        row = client.fetch([uid], query).get(uid, {})
    except IMAPClientError:
        return {}
    found = {}
    for path in paths:
        section = f"BODY[{path}.MIME]".encode()
        raw = row.get(section + b"<0>", row.get(section))
        if not isinstance(raw, bytes) or len(raw) > MIME_HEADER_BYTES:
            continue
        if len(raw) == MIME_HEADER_BYTES and not re.search(rb"\r?\n\r?\n", raw):
            continue
        values = BytesHeaderParser(policy=email.policy.default).parsebytes(raw).get_all("Content-ID", [])
        if values:
            found[path] = content_id(str(values[0])) if len(values) == 1 else ""
    return found


def related_root(children, section, start, walk, resolve):
    matches, containers, readable = [], {}, []
    for index, child in enumerate(children, 1):
        if not isinstance(child, (list, tuple)) or len(child) < 2:
            continue
        if isinstance(child[0], list):
            disposition = child[3] if len(child) > 3 else None
            if isinstance(disposition, (tuple, list)) and disposition and decoded(disposition[0]).lower() == "attachment":
                continue
            path = f"{section}.{index}" if section else str(index)
            containers[path] = index
            readable.append(index)
        elif len(child) >= 7:
            if content_id(child[3]) == start:
                matches.append(index)
            if decoded(child[0]).lower() == "text":
                readable.append(index)
    known = {}
    if containers and resolve:
        paths = list(containers)[:MIME_HEADER_READS - walk.header_reads]
        if paths:
            walk.header_reads += len(paths)
            known = resolve(paths)
            matches.extend(containers[p] for p, cid in known.items() if cid == start)
    unknown = [index for path, index in containers.items() if path not in known]
    if len(matches) == 1 and (not unknown or resolve is None):
        return matches[0]
    if not matches and len(unknown) == 1 and readable == unknown:
        return unknown[0]  # One unreadable container is the only possible body among raster/resource siblings.
    walk.incomplete = True
    return None


def section_tree(body, section="", *, related=(), alternatives=(), order=(), is_body=True, enclosed=False, walk=None, resolve=None):
    """Flatten IMAP BODYSTRUCTURE without downloading attachment payloads."""
    if walk is None:
        walk = MimeWalk()
    if walk.nodes >= MIME_NODES:
        walk.incomplete = True
        return []
    walk.nodes += 1
    if len(order) >= MIME_DEPTH:
        walk.incomplete = True
        return []
    if not isinstance(body, (tuple, list)) or len(body) < 2:
        return []
    if isinstance(body[0], list):
        if len(body[0]) > MIME_NODES - walk.nodes:
            walk.incomplete = True
            return []
        subtype = decoded(body[1]).lower()
        options = mime_options(body[2] if len(body) > 2 else None)
        disposition = body[3] if len(body) > 3 else None
        if isinstance(disposition, (list, tuple)) and disposition and decoded(disposition[0]).lower() == "attachment":
            enclosed = True
        root = 1
        if subtype == "related":
            related = (*related, section or "root")
            start = content_id(options.get("start"))
            if start and is_body and not enclosed:
                root = related_root(body[0], section, start, walk, resolve)
        leaves = []
        for index, child in enumerate(body[0], 1):
            if walk.nodes >= MIME_NODES:
                walk.incomplete = True
                break
            path = f"{section}.{index}" if section else str(index)
            choice = subtype == "alternative"
            leaves.extend(section_tree(child, path, related=related, alternatives=(*alternatives, path) if choice else alternatives,
                                       order=(*order, -index if choice else index), enclosed=enclosed,
                                       is_body=is_body and (subtype != "related" or root == index), walk=walk, resolve=resolve))
        return leaves
    if len(body) < 7:
        return []
    # A message/rfc822 is one downloadable leaf. Its nested MIME structure belongs to the forwarded message.
    mime = f"{decoded(body[0])}/{decoded(body[1])}".lower()
    params = mime_options(body[2])
    filename = params.get("name", "")
    attachment = False
    inline = False
    for field in body[7:]:
        if not isinstance(field, (tuple, list)) or len(field) != 2 or not isinstance(field[0], bytes):
            continue
        if field[0].upper() not in (b"ATTACHMENT", b"INLINE"):
            continue
        attachment = field[0].upper() == b"ATTACHMENT"
        inline = field[0].upper() == b"INLINE"
        opts = field[1] or ()
        for k, v in zip(opts[::2], opts[1::2]):
            if decoded(k).lower() == "filename":
                filename = decoded(v)
    return [dict(id=section or "1", mime=mime, filename=filename, attachment=bool(enclosed or attachment or filename or mime not in {"text/plain", "text/html"}),
                 cid=content_id(body[3]), related=related, alternatives=alternatives, order=order,
                 is_body=is_body and not (enclosed or attachment) and (not filename or inline),
                 enclosed=enclosed, explicit_attachment=attachment,
                 charset=params.get("charset") or "utf-8", encoding=decoded(body[5]).lower(), size=int(body[6] or 0))]


def label_flag(value):
    if not isinstance(value, str):
        raise MailError("Vælg en etiket.")
    name = unicodedata.normalize("NFC", value.strip())
    if not name or len(name) > 40 or len(name.encode()) > 120 or not name.isprintable():
        raise MailError("Etiketten må indeholde op til 40 synlige tegn.")
    # Hex remains unambiguous when an IMAP server folds keyword case.
    return LABEL_PREFIX + name.encode().hex().encode()


def label_names(flags):
    names = set()
    for flag in flags:
        flag = flag.lower()
        if flag.startswith(LABEL_PREFIX):
            try:
                name = bytes.fromhex(flag[len(LABEL_PREFIX):].decode("ascii")).decode()
                if label_flag(name) == flag:
                    names.add(name)
            except (UnicodeError, ValueError, MailError):
                continue
    return sorted(names, key=str.casefold)


def addresses(value, seen=None):
    seen = set() if seen is None else seen
    result = []
    for _, address in getaddresses([str(value or "")]):
        if not address or not re.fullmatch(r"[^\s,;<>@]+@[^\s,;<>@]+", address) or address.casefold() in seen:
            continue
        seen.add(address.casefold())
        result.append(address)
    return result


def message_summary(row, validity, address="", parts=None):
    h = headers(row)
    date = row.get(b"INTERNALDATE")
    try:
        date = parsedate_to_datetime(str(h["Date"])) if h["Date"] else date
    except (ValueError, TypeError, OverflowError):
        pass
    preview = decoded(row.get(b"PREVIEW", b""))
    flags = {flag.lower() for flag in row.get(b"FLAGS", ())}
    senders = addresses(h.get("From"))
    own = address.casefold()
    replies = addresses(h.get("Reply-To") or h.get("From"))
    seen = {own}
    if own and any(item.casefold() == own for item in senders):
        replies = addresses(h.get("To"))
    reply_all = [item for item in replies if item.casefold() != own]
    seen.update(item.casefold() for item in reply_all)
    reply_cc = addresses(h.get("To"), seen) + addresses(h.get("Cc"), seen)
    if parts is None:
        parts = section_tree(row.get(b"BODYSTRUCTURE"), is_body=False)
    return dict(id=f"{validity}.{row[b'UID']}", subject=str(h.get("Subject", "")), **{
        "from": str(h.get("From", "")), "to": str(h.get("To", "")), "cc": str(h.get("Cc", "")),
        "replyTo": str(h.get("Reply-To") or h.get("From") or ""),
        "senderAddress": next(iter(senders), ""), "replyAddresses": replies,
        "replyAllTo": reply_all or reply_cc[:1], "replyAllCc": reply_cc if reply_all else reply_cc[1:],
        "labels": label_names(flags), "task": TASK in flags, "muted": MUTED in flags,
        "category": next((name for name, flag in CATEGORIES.items() if flag in flags), "primary"),
        "date": date.isoformat() if date else "", "unread": b"\\Seen" not in row.get(b"FLAGS", ()),
        "snippet": preview[:220], "hasAttachments": any(p["attachment"] for p in parts),
    })


def numeric_parts(value, count):
    parts = str(value or "").split(".")
    if len(parts) != count or any(not re.fullmatch(r"[0-9]{1,10}", part) or int(part) > 4294967295 for part in parts):
        raise MailError("Ugyldig meddelelse eller side.")
    return tuple(map(int, parts))


def list_messages(client, folder, cursor, query, *, sender="", label="", category="", view="",
                  address="", snoozed=None, only_snoozed=False):
    meta = client.select_folder(folder, readonly=True)
    validity, size = meta[b"UIDVALIDITY"], meta[b"EXISTS"]
    result = dict(messages=[], nextCursor=None, availableLabels=label_names(meta.get(b"FLAGS", ())))
    if view not in {"", "tasks", "muted", "snoozed"}:
        raise MailError("Ukendt visning.")
    if sender and (len(sender) > 254 or addresses(sender) != [sender] or not sender.isprintable()):
        raise MailError("Ugyldig afsender.")
    criteria = []
    if sender:
        criteria.extend(["FROM", sender])
    if label:
        criteria.extend(["KEYWORD", label_flag(label)])
    if category == "primary":
        for flag in CATEGORIES.values():
            criteria.extend(["UNKEYWORD", flag])
    elif category:
        if category not in CATEGORIES:
            raise MailError("Vælg en gyldig fane.")
        criteria.extend(["KEYWORD", CATEGORIES[category]])
    if view in {"tasks", "muted"}:
        criteria.extend(["KEYWORD", TASK if view == "tasks" else MUTED])
    if query:
        criteria.extend(["OR", "OR", "SUBJECT", query, "FROM", query, "TO", query])
    hidden = set(snoozed(validity)) if snoozed else set()
    limit_seq, upper_uid = size, 4294967296
    if cursor:
        version, seq, upper_uid = numeric_parts(cursor, 3)
        if version != validity:
            raise MailError("Mappen er ændret. Åbn den igen.", 409)
        limit_seq = min(seq, size)
    if not size or (only_snoozed and not hidden):
        return result
    fields = ["UID", "FLAGS", "INTERNALDATE", "BODYSTRUCTURE", HEADERS]
    if b"PREVIEW" in client.capabilities():
        fields.append("PREVIEW")
    def visible(row):
        uid = row[b"UID"]
        if uid >= upper_uid or ((uid in hidden) != only_snoozed):
            return False
        if folder.upper() == "INBOX" and not view and MUTED in {flag.lower() for flag in row.get(b"FLAGS", ())}:
            return False
        return not sender or sender.casefold() in {a.casefold() for a in addresses(headers(row).get("From"))}

    ordered = []
    if criteria or only_snoozed:
        if cursor and upper_uid <= 1:
            return result
        if cursor:
            criteria[0:0] = ["UID", f"1:{upper_uid-1}"]
        matches = client.search(criteria, charset="UTF-8") if criteria else hidden
        candidates = sorted((uid for uid in matches if uid < upper_uid and (uid in hidden) == only_snoozed), reverse=True)
        for start in range(0, len(candidates), PAGE + 1):
            batch = candidates[start:start + PAGE + 1]
            rows = client.fetch(batch, fields)
            for uid in batch:
                if uid in rows:
                    rows[uid][b"UID"] = uid
                    if visible(rows[uid]):
                        ordered.append(rows[uid])
            if len(ordered) > PAGE:
                break
    else:
        client.use_uid = False
        try:
            while limit_seq and len(ordered) < PAGE + 1:
                start = max(1, limit_seq - PAGE)
                rows = client.fetch(list(range(start, limit_seq + 1)), fields)
                ordered.extend(row for _, row in sorted(rows.items(), reverse=True) if b"UID" in row and visible(row))
                limit_seq = start - 1
        finally:
            client.use_uid = True
    page = ordered[:PAGE]
    next_cursor = None
    if len(ordered) > PAGE:
        last = page[-1]
        next_cursor = f"{validity}.{max(0, last[b'SEQ'] - 1)}.{last[b'UID']}"
    result.update(messages=[message_summary(row, validity, address) for row in page], nextCursor=next_cursor)
    return result


def lookup(client, folder, identifier, readonly=True):
    validity, uid = numeric_parts(identifier, 2)
    meta = client.select_folder(folder, readonly=readonly)
    if validity != meta[b"UIDVALIDITY"]:
        raise MailError("Meddelelsen findes ikke længere i mappen.", 404)
    rows = client.fetch([uid], ["UID", "FLAGS", "INTERNALDATE", HEADERS, "BODYSTRUCTURE", "RFC822.SIZE"])
    if uid not in rows or b"BODYSTRUCTURE" not in rows[uid]:
        raise MailError("Meddelelsen findes ikke.", 404)
    rows[uid][b"UID"] = uid
    return validity, uid, rows[uid]


def set_flags_checked(client, uid, flags, enabled):
    operation = client.add_flags if enabled else client.remove_flags
    try:
        updated = operation([uid], flags)
    except IMAPClientError as exc:
        raise MailError("Mailserveren kunne ikke gemme ændringen. Kontrollér mappens rettigheder og etiketgrænse.", 409) from exc
    current = {flag.lower() for flag in updated.get(uid, ())}
    if uid not in updated or any((flag.lower() in current) != enabled for flag in flags):
        raise MailError("Ændringen blev ikke gemt. Opdatér mappen, og prøv igen.", 409)


def message_action(client, source, identifier, data, folders):
    action = data.get("action")
    _, uid, row = lookup(client, source, identifier, readonly=False)
    if action in ("archive", "trash", "move"):
        if action == "move":
            target = folder_name(data.get("target"))
            if not any(f["name"] == target for f in folders):
                raise MailError("Mappen blev ikke fundet.", 404)
        else:
            target = next((f["name"] for f in folders if f["role"] == action), None)
            if not target:
                raise MailError("Postkassen mangler den valgte systemmappe.", 409)
        if target != source:
            if b"MOVE" not in client.capabilities():
                raise MailError("Mailserveren understøtter ikke flytning.", 409)
            client.move([uid], target)
    elif action == "category":
        category = data.get("category")
        if not isinstance(category, str) or category not in {"primary", *CATEGORIES}:
            raise MailError("Vælg en gyldig fane.")
        current = {flag.lower() for flag in row.get(b"FLAGS", ())}
        new = CATEGORIES.get(category)
        if new and new not in current:
            set_flags_checked(client, uid, [new], True)
        old = [flag for flag in CATEGORIES.values() if flag != new and flag in current]
        if old:
            set_flags_checked(client, uid, old, False)
    elif action in ("label", "unlabel"):
        set_flags_checked(client, uid, [label_flag(data.get("label"))], action == "label")
    else:
        flags = {"read": b"\\Seen", "unread": b"\\Seen", "task": TASK, "untask": TASK, "mute": MUTED, "unmute": MUTED}
        if not isinstance(action, str) or action not in flags:
            raise MailError("Ukendt handling.")
        set_flags_checked(client, uid, [flags[action]], action in {"read", "task", "mute"})
    return {"ok": True}


def read_part(client, uid, part, max_bytes, *, complete=False):
    section = part["id"]
    rows = client.fetch([uid], [f"BODY.PEEK[{section}]<0.{max_bytes}>"])
    data = next((v for k, v in rows.get(uid, {}).items() if isinstance(k, bytes) and k.startswith(f"BODY[{section}]".encode())), None)
    if data is None:
        raise MailError("Meddelelsesdelen blev ikke fundet.", 404)
    if complete and (not isinstance(data, bytes) or not 0 < len(data) == part["size"] <= max_bytes):
        raise MailError("Meddelelsesdelen kunne ikke læses fuldstændigt.", 422)
    if part["encoding"] == "base64":
        data = re.sub(rb"\s+", b"", data)
        try:
            data = base64.b64decode(data, validate=True) if complete else base64.b64decode(data[:len(data) - len(data) % 4])
        except binascii.Error:
            raise MailError("Meddelelsesdelen kunne ikke læses.", 422) from None
    elif part["encoding"] == "quoted-printable":
        data = quopri.decodestring(data)
    return data


def read_text_part(client, uid, part):
    if part is None:
        return "", False
    try:
        data = read_part(client, uid, part, message_view.BODY_LIMIT)
    except MailError as exc:
        # A malformed or missing MIME alternative must not hide the other body.
        if exc.status not in (404, 422):
            raise
        return "", True
    try:
        text = data.decode(part["charset"], "replace")
    except LookupError:
        text = data.decode("utf-8", "replace")
    return text, part["size"] > message_view.BODY_LIMIT


def related_images(parts, body):
    """Index CID references visible to this MIME alternative; ambiguous names have no target."""
    if not body:
        return {}
    scopes = body.get("related", ())
    branches = body.get("alternatives", ())
    matches = {}
    for part in parts:
        cid = part.get("cid")
        scope = part.get("related", ())
        if not cid or part.get("enclosed") or (bool(scope) != bool(scopes)) or scopes[:len(scope)] != scope:
            continue
        if any(branch not in branches for branch in part.get("alternatives", ())):
            continue
        if cid in matches or part.get("explicit_attachment") or part["mime"] not in INLINE_FORMATS:
            matches[cid] = None
        elif 0 < part["size"] <= INLINE_WIRE_SIZE:
            matches[cid] = part["id"]
        else:
            matches[cid] = None
    return {cid: section for cid, section in matches.items() if section}


@dataclass
class PixelBudget:
    remaining: int

    def reserve(self, width, height):
        pixels = width * height
        if not 0 < width <= 4096 or not 0 < height <= 4096 or pixels > self.remaining:
            return False
        self.remaining -= pixels
        return True


def raster_pixels(data, mime, budget):
    """Verify the claimed raster format and decode within a per-message pixel and frame budget."""
    before = budget.remaining
    try:
        expected = (INLINE_FORMATS[mime],)
        with Image.open(io.BytesIO(data), formats=expected) as image:
            if not budget.reserve(*image.size):
                return 0
            image.verify()
        # verify() checks container integrity for formats that support it. load() also validates pixel data.
        with Image.open(io.BytesIO(data), formats=expected) as image:
            for frame in range(129):
                try:
                    image.seek(frame)
                except EOFError:
                    return before - budget.remaining if frame else 0
                if frame == 128 or (frame and not budget.reserve(*image.size)):
                    return 0
                image.load()
            return 0
    except (Image.DecompressionBombError, OSError, SyntaxError, ValueError, EOFError):
        return 0


def inline_content(client, uid, parts, allowed, requested):
    if not IMAGE_DECODERS.acquire(blocking=False):
        return {}, []
    try:
        return read_inline_images(client, uid, parts, allowed, requested)
    finally:
        IMAGE_DECODERS.release()


def read_inline_images(client, uid, parts, allowed, requested):
    sources, metadata = {}, []
    indexed = {p["id"]: p for p in parts if p["id"] in allowed}
    wire_left, bytes_left = INLINE_WIRE_TOTAL, INLINE_TOTAL
    pixel_budget = PixelBudget(INLINE_PIXELS)
    for section in requested[:INLINE_COUNT]:
        if not bytes_left or not pixel_budget.remaining:
            break
        part = indexed.get(section)
        if not part or part["size"] > wire_left:
            continue
        wire_left -= part["size"]
        try:
            data = read_part(client, uid, part, part["size"], complete=True)
        except MailError as exc:
            if exc.status not in (404, 422):
                raise
            continue
        if not 0 < len(data) <= min(bytes_left, INLINE_SIZE):
            continue
        if not raster_pixels(data, part["mime"], pixel_budget):
            continue
        sources[section] = "data:" + part["mime"] + ";base64," + base64.b64encode(data).decode("ascii")
        metadata.append(dict(id=section, mime=part["mime"], size=len(data)))
        bytes_left -= len(data)
    return sources, metadata


def read_message(client, folder, identifier, *, mark_seen=True, address="", inspect_content=False, in_junk=False):
    validity, uid, row = lookup(client, folder, identifier, readonly=not mark_seen)
    walk = MimeWalk()
    parts = section_tree(row[b"BODYSTRUCTURE"], walk=walk, resolve=lambda paths: read_container_ids(client, uid, paths))
    bodies = sorted((p for p in parts if p.get("is_body", not p["attachment"])), key=lambda p: p.get("order", ()))
    plain = next((p for p in bodies if p["mime"] == "text/plain"), None)
    rich = next((p for p in bodies if p["mime"] == "text/html"), None)
    text, plain_incomplete = read_text_part(client, uid, plain)
    html, html_text, mismatch = None, "", False
    rich_incomplete = False
    cid_parts = related_images(parts, rich) if inspect_content and not walk.incomplete else {}
    if rich and (inspect_content or not text):
        raw_html, rich_incomplete = read_text_part(client, uid, rich)
        html, html_text, mismatch = message_view.html_view(raw_html, cid_parts=cid_parts)
    incomplete = plain_incomplete if text else rich_incomplete
    text = text or html_text
    if walk.incomplete or incomplete or (not text and (plain_incomplete or rich_incomplete)):
        text += "\n\n[Mailens tekst kunne ikke vises fuldstændigt.]"
    result = message_summary(row, validity, address, parts=parts)
    if inspect_content:
        verdict = message_view.assess(client, uid, row.get(b"RFC822.SIZE"), parts, text, html_text,
                                      mismatch, plain_incomplete or rich_incomplete or walk.incomplete, in_junk)
        inline, has_external = [], False
        if verdict["status"] == "dangerous":
            html = None
        if html:
            requested, has_external = message_view.image_references(html)
            if requested:
                sources, inline = inline_content(client, uid, parts, set(cid_parts.values()), requested)
                html = message_view.hydrate_inline_images(html, sources)
        result.update(security=verdict, html=html, inlineImages=inline, has_external_images=has_external)
    if mark_seen:
        client.add_flags([uid], [b"\\Seen"], silent=True)
        result["unread"] = False
    result.update(text=text, attachments=[dict(id=p["id"], name=p["filename"] or "Vedhæftet fil", size=p["size"]) for p in parts if p["attachment"]])
    return result


def attachment(client, folder, identifier, section):
    _, uid, row = lookup(client, folder, identifier)
    part = next((p for p in section_tree(row[b"BODYSTRUCTURE"], is_body=False) if p["attachment"] and p["id"] == section), None)
    if not part:
        raise MailError("Filen findes ikke.", 404)
    if part["size"] > MAX_ATTACHMENT:
        raise MailError("Filen er for stor til download i webmail.", 413)
    name = Path((part["filename"] or "vedhaeftet-fil").replace("\\", "/")).name
    name = re.sub(r"[\x00-\x1f\x7f]", "_", name)[:160] or "vedhaeftet-fil"
    return read_part(client, uid, part, MAX_ATTACHMENT), name


def smtp_login(smtp, email_address, password):
    if password.isascii():
        return smtp.login(email_address, password)
    # smtplib.auth accepts only ASCII responses. Use the RFC 4616 UTF-8
    # response on this already certificate-verified implicit TLS connection.
    smtp.ehlo_or_helo_if_needed()
    if "PLAIN" not in smtp.esmtp_features.get("auth", "").upper().split():
        raise smtplib.SMTPNotSupportedError("Mailserveren understøtter ikke AUTH PLAIN.")
    code, reply = smtp.docmd("AUTH", "PLAIN")
    if code != 334:
        raise smtplib.SMTPAuthenticationError(code, reply)
    credentials = b"\0" + email_address.encode("utf-8") + b"\0" + password.encode("utf-8")
    code, reply = smtp.docmd(base64.b64encode(credentials).decode("ascii"))
    if code != 235:
        raise smtplib.SMTPAuthenticationError(code, reply)
    return code, reply


def attachment_name(value, fallback):
    name = Path(str(value or fallback).replace("\\", "/")).name
    return re.sub(r"[\x00-\x1f\x7f]", "_", name)[:150] or fallback


def forwarded_parts(client, msg, data):
    original = data.get("forwardAttachment")
    files = data.get("forwardFiles")
    if original is None and files is None:
        return
    source = original if original is not None else files
    if not isinstance(source, dict) or (original is not None and files is not None):
        raise MailError("Vælg én mail at videresende.")
    _, uid, row = lookup(client, folder_name(source.get("folder")), source.get("id"))
    if original is not None:
        size = client.fetch([uid], ["RFC822.SIZE"]).get(uid, {}).get(b"RFC822.SIZE")
        if not isinstance(size, int) or size <= 0:
            raise MailError("Originalmailen kunne ikke hentes.", 404)
        if size > MAX_FORWARD:
            raise MailError("Originalmailen er for stor til videresendelse (maks. 16 MB).", 413)
        rows = client.fetch([uid], [f"BODY.PEEK[]<0.{size}>"])
        raw = rows.get(uid, {}).get(b"BODY[]<0>")
        if not isinstance(raw, bytes) or len(raw) != size:
            raise MailError("Originalmailen kunne ikke hentes fuldstændigt.", 409)
        # A binary .eml attachment preserves every original octet, including
        # signatures and attachments; parsing and serializing it can alter both.
        name = attachment_name(headers(row).get("Subject"), "Originalmail") + ".eml"
        msg.add_attachment(raw, maintype="application", subtype="octet-stream", filename=name)
        return
    walk = MimeWalk()
    parts = [p for p in section_tree(row[b"BODYSTRUCTURE"], is_body=False, walk=walk) if p["attachment"]]
    if walk.incomplete:
        raise MailError("Mailen har for mange MIME-dele til at videresende filerne samlet.", 413)
    if sum(p["size"] for p in parts) > MAX_FORWARD:
        raise MailError("De vedhæftede filer er for store til videresendelse (maks. 16 MB).", 413)
    for part in parts:
        name = attachment_name(part["filename"], "vedhaeftet-fil")
        raw = read_part(client, uid, part, max(1, part["size"]))
        mime = part["mime"] if re.fullmatch(r"[a-z0-9!#$&^_.+\-]+/[a-z0-9!#$&^_.+\-]+", part["mime"]) else "application/octet-stream"
        if mime == "message/rfc822":
            msg.add_attachment(BytesParser(policy=email.policy.SMTP).parsebytes(raw), filename=name)
        else:
            maintype, subtype = mime.split("/")
            msg.add_attachment(raw, maintype=maintype, subtype=subtype, filename=name)


def send_message(client, email_address, password, data, folders):
    to, cc, subject, text = (data.get(k, "") for k in ("to", "cc", "subject", "text"))
    if not all(isinstance(v, str) for v in (to, cc, subject, text)) or any(c in to+cc+subject for c in "\r\n\0"):
        raise MailError("Ugyldig modtager eller emne.")
    if (not text.strip() and not data.get("forwardAttachment")) or len(subject)>500 or len(to+cc)>4000 or len(text)>500_000:
        raise MailError("Kontrollér modtager, besked og længde.")
    recipients = [a for _, a in getaddresses([to] + ([cc] if cc else []))]
    if not (1 <= len(recipients) <= 20) or any(not re.fullmatch(r'[^\s,;<>@]+@[^\s,;<>@]+', a) or not a.isascii() for a in recipients):
        raise MailError("Skriv gyldige mailadresser adskilt med komma.")
    msg = EmailMessage(policy=email.policy.SMTP)
    msg["From"], msg["To"], msg["Subject"] = email_address, to, subject
    if cc:
        msg["Cc"] = cc
    msg["Date"], msg["Message-ID"] = formatdate(localtime=False, usegmt=True), make_msgid(domain="veyro.dk")
    if data.get("replyToId"):
        _, _, row = lookup(client, folder_name(data.get("replyToFolder")), data["replyToId"])
        h = headers(row)
        ids = re.findall(r"<[^\s<>]+>", str(h.get("Message-ID") or ""))
        if ids:
            msg["In-Reply-To"] = ids[-1]
            msg["References"] = " ".join((re.findall(r"<[^\s<>]+>", str(h.get("References") or "")) + [ids[-1]])[-15:])
    msg.set_content(text)
    forwarded_parts(client, msg, data)
    sent = next((folder_name(f["id"]) for f in folders if f["role"] == "sent"), None)
    refused = {}
    smtp = smtplib.SMTP_SSL(HOST, port=465, context=verified_tls(), timeout=18)
    try:
        smtp_login(smtp, email_address, password)
        try:
            refused = smtp.send_message(msg, from_addr=email_address, to_addrs=list(dict.fromkeys(recipients)))
        except (smtplib.SMTPServerDisconnected, TimeoutError, ConnectionError) as exc:
            raise DeliveryUncertain() from exc
    finally:
        smtp.close()
    result = {"sent": True, "savedCopy": False}
    if refused:
        result["refused"] = list(refused)
    if sent:
        try:
            client.append(sent, msg.as_bytes(), flags=[b"\\Seen"])
            result["savedCopy"] = True
        except Exception:
            pass  # Submission already succeeded; an automatic resend could duplicate it.
    if not result["savedCopy"]:
        result["warning"] = "Mailen blev afsendt. En kopi kunne ikke gemmes i Sendt."
    return result


class DeliveryUncertain(MailError):
    def __init__(self):
        super().__init__("Mailserveren bekræftede ikke afsendelsen. Kontrollér Sendt, før du prøver igen.", 502)
