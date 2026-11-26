import base64
import binascii
import email.policy
import quopri
import re
import smtplib
import ssl
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.parser import BytesHeaderParser
from email.utils import formatdate, getaddresses, make_msgid, parsedate_to_datetime
from functools import lru_cache
from html.parser import HTMLParser
from pathlib import Path

from imapclient import IMAPClient

HOST = "post.veyro.dk"
TRUST_FILE = Path("/run/veyro/mailcow-public.pem")
PAGE = 30
MAX_ATTACHMENT = 32 * 1024 * 1024
HEADERS = "BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO CC REPLY-TO DATE MESSAGE-ID REFERENCES CONTENT-TYPE CONTENT-TRANSFER-ENCODING)]"
FLAGS = {"inbox", "sent", "drafts", "trash", "junk", "archive"}


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


def section_tree(body, section=""):
    """Flatten IMAP BODYSTRUCTURE without downloading attachment payloads."""
    if not isinstance(body, (tuple, list)) or len(body) < 2:
        return []
    if isinstance(body[0], list):
        leaves = []
        for index, child in enumerate(body[0], 1):
            leaves.extend(section_tree(child, f"{section}.{index}" if section else str(index)))
        return leaves
    mime = f"{decoded(body[0])}/{decoded(body[1])}".lower()
    params = body[2] or ()
    params = {decoded(k).lower(): decoded(v) for k, v in zip(params[::2], params[1::2])}
    filename = params.get("name", "")
    attachment = False
    for field in body[7:]:
        if not isinstance(field, (tuple, list)) or len(field) != 2 or not isinstance(field[0], bytes):
            continue
        if field[0].upper() not in (b"ATTACHMENT", b"INLINE"):
            continue
        attachment = field[0].upper() == b"ATTACHMENT"
        opts = field[1] or ()
        for k, v in zip(opts[::2], opts[1::2]):
            if decoded(k).lower() == "filename":
                filename = decoded(v)
    return [dict(id=section or "1", mime=mime, filename=filename, attachment=bool(attachment or filename or mime not in {"text/plain", "text/html"}),
                 charset=params.get("charset") or "utf-8", encoding=decoded(body[5]).lower(), size=int(body[6] or 0))]


def message_summary(row, validity):
    h = headers(row)
    date = row.get(b"INTERNALDATE")
    try:
        date = parsedate_to_datetime(str(h["Date"])) if h["Date"] else date
    except (ValueError, TypeError, OverflowError):
        pass
    preview = decoded(row.get(b"PREVIEW", b""))
    return dict(id=f"{validity}.{row[b'UID']}", subject=str(h.get("Subject", "")), **{
        "from": str(h.get("From", "")), "to": str(h.get("To", "")), "cc": str(h.get("Cc", "")),
        "replyTo": str(h.get("Reply-To") or h.get("From") or ""),
        "date": date.isoformat() if date else "", "unread": b"\\Seen" not in row.get(b"FLAGS", ()),
        "snippet": preview[:220], "hasAttachments": any(p["attachment"] for p in section_tree(row.get(b"BODYSTRUCTURE"))),
    })


def numeric_parts(value, count):
    parts = str(value or "").split(".")
    if len(parts) != count or any(not re.fullmatch(r"[0-9]{1,10}", part) or int(part) > 4294967295 for part in parts):
        raise MailError("Ugyldig meddelelse eller side.")
    return tuple(map(int, parts))


def list_messages(client, folder, cursor, query):
    meta = client.select_folder(folder, readonly=True)
    validity, size = meta[b"UIDVALIDITY"], meta[b"EXISTS"]
    limit_seq, upper_uid = size, 4294967296
    if cursor:
        version, seq, upper_uid = numeric_parts(cursor, 3)
        if version != validity:
            raise MailError("Mappen er ændret. Åbn den igen.", 409)
        limit_seq = min(seq, size)
    if not size:
        return dict(messages=[], nextCursor=None)
    fields = ["UID", "FLAGS", "INTERNALDATE", "BODYSTRUCTURE", HEADERS]
    if b"PREVIEW" in client.capabilities():
        fields.append("PREVIEW")
    if query:
        criteria = ["OR", "OR", "SUBJECT", query, "FROM", query, "TO", query]
        if cursor and upper_uid <= 1:
            return dict(messages=[], nextCursor=None)
        if cursor:
            criteria[0:0] = ["UID", f"1:{upper_uid-1}"]
        matches = list(reversed(client.search(criteria, charset="UTF-8")))
        rows = client.fetch(matches[:PAGE+1], fields) if matches else {}
        ordered = [rows[i] for i in matches[:PAGE+1] if i in rows]
        for message_uid, row in rows.items():
            row[b"UID"] = message_uid
    else:
        ordered = []
        client.use_uid = False
        try:
            while limit_seq and len(ordered) < PAGE + 1:
                start = max(1, limit_seq - PAGE)
                rows = client.fetch(list(range(start, limit_seq + 1)), fields)
                ordered.extend(row for _, row in sorted(rows.items(), reverse=True) if row.get(b"UID", upper_uid) < upper_uid)
                limit_seq = start - 1
        finally:
            client.use_uid = True
    page = ordered[:PAGE]
    next_cursor = None
    if len(ordered) > PAGE:
        last = page[-1]
        next_cursor = f"{validity}.{max(0, last[b'SEQ'] - 1)}.{last[b'UID']}"
    return dict(messages=[message_summary(row, validity) for row in page], nextCursor=next_cursor)


def lookup(client, folder, identifier, readonly=True):
    validity, uid = numeric_parts(identifier, 2)
    meta = client.select_folder(folder, readonly=readonly)
    if validity != meta[b"UIDVALIDITY"]:
        raise MailError("Meddelelsen findes ikke længere i mappen.", 404)
    rows = client.fetch([uid], ["UID", "FLAGS", "INTERNALDATE", HEADERS, "BODYSTRUCTURE"])
    if uid not in rows or b"BODYSTRUCTURE" not in rows[uid]:
        raise MailError("Meddelelsen findes ikke.", 404)
    rows[uid][b"UID"] = uid
    return validity, uid, rows[uid]


def read_part(client, uid, part, max_bytes):
    section = part["id"]
    rows = client.fetch([uid], [f"BODY.PEEK[{section}]<0.{max_bytes}>"])
    data = next((v for k, v in rows.get(uid, {}).items() if isinstance(k, bytes) and k.startswith(f"BODY[{section}]".encode())), None)
    if data is None:
        raise MailError("Meddelelsesdelen blev ikke fundet.", 404)
    if part["encoding"] == "base64":
        data = re.sub(rb"\s+", b"", data)
        try:
            data = base64.b64decode(data[:len(data) - len(data) % 4])
        except binascii.Error:
            raise MailError("Meddelelsesdelen kunne ikke læses.", 422) from None
    elif part["encoding"] == "quoted-printable":
        data = quopri.decodestring(data)
    return data


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.chunks, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "head"}:
            self.hidden += 1
        if tag in {"br", "p", "div", "tr", "li", "blockquote"} and not self.hidden:
            self.chunks.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "head"} and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.chunks.append(data)


def read_message(client, folder, identifier):
    validity, uid, row = lookup(client, folder, identifier, readonly=False)
    parts = section_tree(row[b"BODYSTRUCTURE"])
    text_parts = [p for p in parts if not p["attachment"]]
    body = next((p for p in text_parts if p["mime"] == "text/plain"), next(iter(text_parts), None))
    text = ""
    if body:
        data = read_part(client, uid, body, 1024 * 1024)
        try:
            text = data.decode(body["charset"], "replace")
        except LookupError:
            text = data.decode("utf-8", "replace")
        if body["mime"] == "text/html":
            parser = VisibleText()
            parser.feed(text)
            text = "".join(parser.chunks).strip()
        if body["size"] > 1024 * 1024:
            text += "\n\n[Resten af den meget lange besked er udeladt.]"
    client.add_flags([uid], [b"\\Seen"], silent=True)
    result = message_summary(row, validity)
    result.update(text=text, unread=False, attachments=[dict(id=p["id"], name=p["filename"] or "Vedhæftet fil", size=p["size"]) for p in parts if p["attachment"]])
    return result


def attachment(client, folder, identifier, section):
    _, uid, row = lookup(client, folder, identifier)
    part = next((p for p in section_tree(row[b"BODYSTRUCTURE"]) if p["attachment"] and p["id"] == section), None)
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


def send_message(client, email_address, password, data, folders):
    to, subject, text = (data.get(k, "") for k in ("to", "subject", "text"))
    if not all(isinstance(v, str) for v in (to, subject, text)) or any(c in to+subject for c in "\r\n\0"):
        raise MailError("Ugyldig modtager eller emne.")
    if not text.strip() or len(subject)>500 or len(to)>4000 or len(text)>500_000:
        raise MailError("Kontrollér modtager, besked og længde.")
    recipients = [a for _, a in getaddresses([to])]
    if not (1 <= len(recipients) <= 20) or any(not re.fullmatch(r'[^\s,;<>@]+@[^\s,;<>@]+', a) or not a.isascii() for a in recipients):
        raise MailError("Skriv gyldige mailadresser adskilt med komma.")
    msg = EmailMessage(policy=email.policy.SMTP)
    msg["From"], msg["To"], msg["Subject"] = email_address, to, subject
    msg["Date"], msg["Message-ID"] = formatdate(localtime=False, usegmt=True), make_msgid(domain="veyro.dk")
    if data.get("replyToId"):
        _, _, row = lookup(client, folder_name(data.get("replyToFolder")), data["replyToId"])
        h = headers(row)
        ids = re.findall(r"<[^\s<>]+>", str(h.get("Message-ID") or ""))
        if ids:
            msg["In-Reply-To"] = ids[-1]
            msg["References"] = " ".join((re.findall(r"<[^\s<>]+>", str(h.get("References") or "")) + [ids[-1]])[-15:])
    msg.set_content(text)
    sent = next((folder_name(f["id"]) for f in folders if f["role"] == "sent"), None)
    refused = {}
    smtp = smtplib.SMTP_SSL(HOST, port=465, context=verified_tls(), timeout=18)
    try:
        smtp_login(smtp, email_address, password)
        try:
            refused = smtp.send_message(msg, from_addr=email_address, to_addrs=recipients)
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
