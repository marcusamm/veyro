"""Build a passive email view and assess the stored message without contacting its sender."""
import imaplib
import ipaddress
import os
import re
import socket
import struct
import threading
import time
from html.parser import HTMLParser
from urllib.parse import parse_qsl, unquote, urlsplit

import nh3


def safe_attribute(tag, name, value):
    if tag == "a" and name == "rel":
        return "noopener noreferrer"
    if name in {"colspan", "rowspan"}:
        return value if re.fullmatch(r"[1-9][0-9]?", value) else None
    if name != "href":
        return None
    value = value.strip()
    if (len(value) > 4096 or "\\" in value or any(char.isspace() or ord(char) < 32
            or ord(char) == 127 for char in value)):
        return None
    try:
        dest = urlsplit(value)
        if dest.scheme in {"http", "https"} and dest.hostname and dest.username is None:
            return value
        if dest.scheme == "mailto" and not dest.netloc and not dest.fragment:
            address = unquote(dest.path)
            if not address.isprintable() or not re.fullmatch(r"[^\s<>@/?,;:#]+@[^\s<>@/?,;:#]+", address):
                return None
            fields = parse_qsl(dest.query, keep_blank_values=True, strict_parsing=True, max_num_fields=2)
            names = {name for name, _ in fields}
            if len(names) == len(fields) and names <= {"subject", "body"} and all(
                    not content or content.isprintable() for _, content in fields):
                return value
    except ValueError:
        pass
    return None


CLEANER = nh3.Cleaner(
    tags=set("a b blockquote br caption code dd del div dl dt em h1 h2 h3 h4 h5 h6 hr i li ol p pre s small span strong sub sup table tbody td th thead tfoot tr u ul".split()),
    clean_content_tags=set("audio button canvas embed form head iframe math noscript object script style svg template textarea video".split()),
    attributes={"a": {"href"}, "td": {"colspan", "rowspan"}, "th": {"colspan", "rowspan"}},
    attribute_filter=safe_attribute, url_relative="deny", url_schemes={"http", "https", "mailto"},
)

LINK_MISMATCH = "En synlig webadresse i mailen peger på et andet domæne."
RISKY_ATTACHMENT = "Mailen indeholder en programfil eller et script som vedhæftning."
CREDENTIAL_REQUEST = "Mailen beder dig sende en adgangskode eller sikkerhedskode."
SCANNER_UNAVAILABLE = "Virusscanningen kunne ikke gennemføres."
SCAN_LIMIT = "Hele mailen kunne ikke kontrolleres inden for scanningsgrænsen."
BODY_INCOMPLETE = "En tekstdel kunne ikke læses fuldstændigt."
MALWARE = "Virusscanneren har markeret denne mail eller en vedhæftet fil."
HEURISTIC = "Scanneren har fundet et mistænkeligt mønster i mailen."
SCAN_SLOTS = threading.BoundedSemaphore(2)
MAX_SCAN = 8 * 1024 * 1024
BODY_LIMIT = 1024 * 1024
EXECUTABLE = re.compile(r"\.(?:bat|cmd|com|cpl|exe|hta|iso|js|jse|lnk|msi|ps1|scr|vbe?|vbs|wsf)$", re.I)
SECRET_REQUEST = re.compile(
    r"(?<!not )(?<!n't )(?<!never )(?<!ikke )\b(?:send|reply with|provide|oplys|svar med|udlever)\s+(?:(?:os|mig|me|us|your|dit|din|the|dine|jeres)\s+){0,3}"
    r"(?:adgangskode|engangskode|sikkerhedskode|password|verification code|one.time code)\b", re.I)
VISIBLE_HOST = re.compile(r"(?:https?://|www\.)\S+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?:#]\S*)?", re.I)


class LinkText(HTMLParser):
    """Derive accessible text and compare visible URL labels from the sanitized fragment."""
    def __init__(self):
        super().__init__()
        self.chunks = []
        self.href = ""
        self.link_start = 0
        self.mismatch = False

    def handle_starttag(self, tag, attrs):
        if tag in {"br", "p", "div", "tr", "li", "blockquote", "hr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.chunks.append("\n")
        elif tag in {"td", "th"}:
            self.chunks.append("\t")
        elif tag == "a":
            self.href = dict(attrs).get("href", "")
            self.link_start = len(self.chunks)

    def handle_endtag(self, tag):
        if tag in {"p", "div", "tr", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.chunks.append("\n")
        if tag != "a" or not self.href:
            return
        label = "".join(self.chunks[self.link_start:]).strip()
        if label != self.href:
            self.chunks.append(f" ({self.href})" if label else self.href)
        if VISIBLE_HOST.fullmatch(label) and not self.href.lower().startswith("mailto:"):
            try:
                shown = urlsplit(label if "://" in label else "https://" + label).hostname
                actual = urlsplit(self.href).hostname
                if shown and actual:
                    shown = shown.lower().rstrip(".").removeprefix("www.")
                    actual = actual.lower().rstrip(".").removeprefix("www.")
                    if shown != actual and not actual.endswith("." + shown):
                        self.mismatch = True
            except ValueError:
                pass
        self.href = ""

    def handle_data(self, data):
        self.chunks.append(data)


def html_view(source):
    safe = CLEANER.clean(source)
    parser = LinkText()
    parser.feed(safe)
    parser.close()
    return safe or None, "".join(parser.chunks).strip(), parser.mismatch


def antivirus(client, uid, size):
    """Scan every stored octet (including MIME attachments) via a loopback-only daemon."""
    if type(size) is not int or not 0 < size <= MAX_SCAN:
        return "unknown", SCAN_LIMIT
    if not SCAN_SLOTS.acquire(blocking=False):
        return "unknown", SCANNER_UNAVAILABLE
    try:
        host = ipaddress.ip_address(os.environ.get("WEBMAIL_CLAMD_HOST", ""))
        if not host.is_loopback:
            return "unknown", SCANNER_UNAVAILABLE
        port = int(os.environ.get("WEBMAIL_CLAMD_PORT", "0"))
        if not 1 <= port <= 65535:
            return "unknown", SCANNER_UNAVAILABLE
        with socket.create_connection((str(host), port), timeout=1) as sock:
            message = client.fetch([uid], [f"BODY.PEEK[]<0.{size}>"]).get(uid, {}).get(b"BODY[]<0>")
            if not isinstance(message, bytes) or len(message) != size:
                return "unknown", SCAN_LIMIT
            # Socket reads/writes share one deadline, even if the daemon dribbles data.
            deadline = time.monotonic() + 6
            def set_time_left():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                sock.settimeout(remaining)
            set_time_left()
            sock.sendall(b"zINSTREAM\0")
            for offset in range(0, size, 65536):
                block = message[offset:offset + 65536]
                set_time_left()
                sock.sendall(struct.pack("!I", len(block)) + block)
            set_time_left()
            sock.sendall(b"\0\0\0\0")
            response = bytearray()
            while len(response) < 1024 and b"\0" not in response:
                set_time_left()
                data = sock.recv(1024 - len(response))
                if not data:
                    break
                response.extend(data)
        if response == b"stream: OK\0":
            return "clean", None
        if response.startswith((b"stream: Heuristics.Limits.Exceeded", b"stream: Heuristics.Encrypted")):
            return "unknown", SCAN_LIMIT
        if response.startswith(b"stream: ") and response.endswith(b" FOUND\0"):
            if response.startswith((b"stream: Heuristics.", b"stream: PUA.")):
                return "suspicious", HEURISTIC
            return "dangerous", MALWARE
    except (OSError, ValueError, OverflowError, imaplib.IMAP4.error):
        pass
    finally:
        SCAN_SLOTS.release()
    return "unknown", SCANNER_UNAVAILABLE


def assess(client, uid, size, parts, text, html_text, mismatch, truncated, in_junk):
    status, note = antivirus(client, uid, size)
    if status == "dangerous":
        return {"status": status, "reasons": [note]}
    reasons = []
    if in_junk:
        reasons.append("Mailen ligger i postkassens mappe til uønsket mail.")
    if mismatch:
        reasons.append(LINK_MISMATCH)
    if any(p["attachment"] and EXECUTABLE.search(p["filename"].rstrip(" .")) for p in parts):
        reasons.append(RISKY_ATTACHMENT)
    if SECRET_REQUEST.search(text) or SECRET_REQUEST.search(html_text):
        reasons.append(CREDENTIAL_REQUEST)
    if reasons:
        status = "suspicious"
    elif truncated and status == "clean":
        status = "unknown"
    if note:
        reasons.append(note)
    if truncated:
        reasons.append(BODY_INCOMPLETE)
    return {"status": status, "reasons": reasons}
