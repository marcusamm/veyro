import html
import re
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

import nh3

import email_css

TAGS = set("""
a abbr address article b blockquote br caption center code col colgroup dd del div dl dt em
font footer h1 h2 h3 h4 h5 h6 header hr i img li main mark ol p pre s section small span
strong sub sup table tbody td th thead tfoot tr u ul
""".split())
VOID = {"br", "col", "hr", "img"}
ATTRS = {
    "*": {"class", "id", "style", "title", "dir", "lang", "align", "valign", "bgcolor", "width", "height"},
    "a": {"href"}, "img": {"src", "alt", "border", "hspace", "vspace"},
    "table": {"border", "cellspacing", "cellpadding", "role"},
    "td": {"colspan", "rowspan"}, "th": {"colspan", "rowspan"},
    "col": {"span"}, "colgroup": {"span"}, "font": {"color", "size", "face"},
    "style": {"type", "media"},
}
SECTION = re.compile(r"[1-9]\d{0,5}(?:\.[1-9]\d{0,5}){0,23}", re.ASCII)
IMG_TAG = re.compile(r"<img(?: [^<>]*)?>")  # Output HTML escapes both angle brackets in all attributes.
PART_MARKER = re.compile(r' data-veyro-part="([0-9.]+)"')
RASTER = re.compile(r"data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}\Z", re.ASCII)
IMAGE_BUDGET = 4 * 1024 * 1024


def attributes(tag, name, value, link_filter):
    if name == "href" or name == "rel":
        return link_filter(tag, name, value)
    if name == "src":
        if tag != "img" or len(value) > 4096 or not value.isprintable() or "\\" in value or any(c.isspace() for c in value):
            return None
        if value.startswith("//"):
            value = "https:" + value
        try:
            url = urlsplit(value)
            if url.scheme == "https" and url.hostname and url.username is None:
                return value
            if url.scheme == "cid" and url.path and not (url.netloc or url.query or url.fragment):
                return value
        except ValueError:
            pass
        return None
    if name == "style":
        return email_css.declarations(value) or None
    if tag == "style" and name in {"type", "media"}:
        # Keep an inapplicable qualifier inapplicable; removing it changes cascade.
        return value if len(value) <= 500 else "unsupported"
    if name == "id":
        return value if email_css.IDENT.fullmatch(value) else None
    if name == "class":
        return " ".join(c for c in value[:1024].split()[:32] if email_css.IDENT.fullmatch(c)) or None
    if name in {"alt", "title"}:
        return value[:512] if value.isprintable() else None
    if name in {"colspan", "rowspan", "span"}:
        return value if re.fullmatch(r"[1-9][0-9]?", value) else None
    if name in {"border", "hspace", "vspace", "cellpadding", "cellspacing"}:
        return value if re.fullmatch(r"\d{1,3}", value, re.ASCII) else None
    if name in {"width", "height"}:
        return value if re.fullmatch(r"(?:\d{1,4}|(?:100|[0-9]{1,2})%)", value, re.ASCII) else None
    if name in {"color", "bgcolor"}:
        return value if re.fullmatch(r"#[0-9a-f]{3}(?:[0-9a-f]{3})?|[a-z]{1,24}", value, re.I | re.ASCII) else None
    if name == "face":
        return value if re.fullmatch(r"[\w,' .-]{1,150}", value) else None
    if name == "size":
        return value if re.fullmatch(r"[+-]?[1-7]", value) else None
    if name == "lang":
        return value if re.fullmatch(r"[a-zA-Z-]{1,40}", value) else None
    values = {"align": {"left", "center", "right", "justify"}, "valign": {"top", "middle", "bottom", "baseline"},
              "dir": {"ltr", "rtl", "auto"}, "role": {"presentation", "none"}}
    return value.lower() if value.lower() in values.get(name, ()) else None


def make_cleaner(link_filter):
    # nh3's html5ever tree builder first removes unapproved elements, attributes and namespaces.
    return nh3.Cleaner(
        tags=TAGS | {"style"},
        clean_content_tags=set("audio button canvas embed form iframe math noscript object script svg template textarea title video".split()),
        attributes=ATTRS, attribute_filter=lambda t, n, v: attributes(t, n, v, link_filter),
        # Our tag-specific filter rejects relative hyperlinks. Protocol-relative CDN
        # images must reach it so they can become inert, absolute HTTPS metadata.
        url_relative="pass_through", url_schemes={"http", "https", "mailto", "cid"})


def open_tag(tag, attrs):
    return "<" + tag + "".join(f' {name}="{html.escape(value, quote=True)}"' for name, value in attrs) + ">"


class RichFragment(HTMLParser):
    """Serialize only passive images and filtered styles; intermediate HTML never leaves the server."""
    def __init__(self, cid_parts):
        super().__init__()
        self.parts = cid_parts or {}
        self.out = []
        self.style = None
        self.media = ""
        self.css_budget = 256 * 1024

    def handle_starttag(self, tag, attrs):
        if tag == "style":
            self.style = []
            options = dict(attrs)
            self.media = options.get("media", "").strip()
            if options.get("type", "text/css").strip().lower() not in {"", "text/css"}:
                self.media = "unsupported"
            return
        if tag not in TAGS:
            return
        if tag == "img":
            image = dict(attrs)
            src = image.pop("src", "")
            if src.lower().startswith("https://"):
                image["data-veyro-src"] = src
            elif src.lower().startswith("cid:"):
                name = unquote(src[4:]).strip("<>").casefold()
                section = self.parts.get(name)
                if isinstance(section, str) and SECTION.fullmatch(section):
                    image["data-veyro-part"] = section
            attrs = image.items()
        self.out.append(open_tag(tag, attrs))

    def handle_endtag(self, tag):
        if tag == "style":
            if self.style is not None:
                source = "".join(self.style)
                if len(source) <= self.css_budget:
                    self.css_budget -= len(source)
                    safe = email_css.stylesheet(source)
                    if self.media:
                        safe = f"@media {self.media}{{{safe}}}" if safe and email_css.media_condition(self.media) else ""
                    if safe:
                        self.out.append("<style>" + safe + "</style>")
                self.style = None
        elif tag in TAGS and tag not in VOID:
            self.out.append(f"</{tag}>")

    def handle_data(self, data):
        if self.style is not None:
            self.style.append(data)
        else:
            self.out.append(html.escape(data, quote=False))


class BodyAppearance(HTMLParser):
    """HTML5 fragment parsing omits the source body's attributes; keep its passive appearance."""
    def __init__(self):
        super().__init__()
        self.attrs = None

    def handle_starttag(self, tag, attrs):
        if tag != "body" or self.attrs is not None:
            return
        self.attrs = {}
        styles = []
        for name, value in attrs:
            if not value or name not in {"class", "id", "dir", "lang", "align", "bgcolor", "text", "style"}:
                continue
            if name in {"bgcolor", "text"}:
                color = attributes("div", "color", value, None)
                if color:
                    styles.insert(0, ("background-color:" if name == "bgcolor" else "color:") + color)
            elif name == "style":
                styles.append(email_css.declarations(value))
            elif (safe := attributes("div", name, value, None)):
                self.attrs[name] = safe
        if any(styles):
            self.attrs["style"] = ";".join(style for style in styles if style)


def clean_fragment(cleaner, source, cid_parts):
    fragment = RichFragment(cid_parts)
    fragment.feed(cleaner.clean(source))
    fragment.close()
    result = "".join(fragment.out)
    # Body attributes (e.g. a receipt's background) occur at the head of full email documents.
    prefix = source[:192 * 1024]
    if re.search(r"<body(?:\s|>)", prefix, re.I):
        appearance = BodyAppearance()
        try:
            appearance.feed(prefix)
        except (AssertionError, ValueError):
            # Malformed declarations may confuse HTMLParser. The HTML5-sanitized
            # body remains usable without the optional outer appearance.
            return result
        if appearance.attrs:
            result = open_tag("div", appearance.attrs.items()) + result + "</div>"
    return result


def image_references(safe_html):
    parts = {}
    external = False
    for img in IMG_TAG.finditer(safe_html or ""):
        marker = PART_MARKER.search(img[0])
        if marker and SECTION.fullmatch(marker[1]):
            parts[marker[1]] = None
        external |= ' data-veyro-src="' in img[0]
    return list(parts), external


def hydrate_inline_images(safe_html, sources):
    """Caller supplies raster data URLs from verified MIME parts belonging to this message."""
    used = set()
    remaining = IMAGE_BUDGET

    def hydrate(match):
        nonlocal remaining
        tag = match[0]
        marker = PART_MARKER.search(tag)
        if not marker or marker[1] in used:
            return tag
        source = sources.get(marker[1])
        if not isinstance(source, str) or len(source) > remaining or not RASTER.fullmatch(source):
            return tag
        used.add(marker[1])
        remaining -= len(source)
        return tag[:-1] + ' src="' + source + '">'
    return IMG_TAG.sub(hydrate, safe_html) if safe_html and sources else safe_html
