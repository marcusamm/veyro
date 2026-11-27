"""Passive CSS subset used only inside the isolated message document."""
import re

import tinycss2

PROPERTIES = set("""
    color background background-color width height min-width max-width min-height max-height
    display box-sizing table-layout border-collapse border-spacing caption-side empty-cells
    margin padding border border-radius border-width border-style border-color
    font font-family font-size font-weight font-style font-variant line-height letter-spacing
    text-align text-decoration text-decoration-color text-decoration-line text-decoration-style
    text-transform vertical-align white-space word-break overflow-wrap word-wrap
    list-style-type list-style-position float clear direction flex flex-direction flex-wrap
    justify-content align-content align-items align-self gap row-gap column-gap
""".split())
for side in ("top", "right", "bottom", "left"):
    PROPERTIES.update({f"padding-{side}", f"margin-{side}", f"border-{side}"})
    PROPERTIES.update(f"border-{side}-{suffix}" for suffix in ("width", "style", "color"))
for vertical in ("top", "bottom"):
    PROPERTIES.update(f"border-{vertical}-{horizontal}-radius" for horizontal in ("left", "right"))

IDENT = re.compile(r"[A-Za-z_-][A-Za-z0-9_-]{0,80}")
SELECTOR = re.compile(r"[A-Za-z0-9.*#_ >+~:,\t\n\r-]{1,512}")
PSEUDOS = {"hover", "link", "first-child", "last-child", "first-of-type", "last-of-type", "only-child"}
FEATURE = (r"\(\s*(?:(?:min-|max-)?(?:width|height)\s*:\s*\d{1,4}(?:\.\d{1,2})?(?:px|em|rem)"
           r"|orientation\s*:\s*(?:portrait|landscape)|prefers-color-scheme\s*:\s*(?:light|dark))\s*\)")
MEDIA = re.compile(r"(?:(?:only\s+)?(?:screen|all)(?:\s+and\s+" + FEATURE + r")*|"
                   + FEATURE + r"(?:\s+and\s+" + FEATURE + r")*)", re.I)
DISPLAY = {"none", "block", "inline", "inline-block", "table", "inline-table", "table-row", "table-cell",
           "table-row-group", "table-header-group", "table-footer-group", "flex", "inline-flex", "list-item"}
UNITS = {"px", "pt", "em", "rem", "ex", "ch", "pc", "cm", "mm", "in", "vw", "vh", "vmin", "vmax", "deg"}
COLORS = {"rgb", "rgba", "hsl", "hsla"}


def safe_values(tokens, *, font=False, in_color=False):
    if not 0 < len(tokens) <= 96:
        return False
    for token in tokens:
        kind = token.type
        if kind == "whitespace":
            continue
        if kind == "ident" and IDENT.fullmatch(token.value):
            continue
        if kind == "number" and 0 <= token.value <= 4000:
            continue
        if kind == "percentage" and 0 <= token.value <= 100:
            continue
        if kind == "dimension" and token.lower_unit in UNITS and 0 <= token.value <= 4000:
            continue
        if kind == "hash" and re.fullmatch(r"(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})", token.value):
            continue
        if kind == "literal" and token.value in (",", "/"):
            continue
        if kind == "string" and font and re.fullmatch(r"[\w .-]{1,80}", token.value):
            continue
        if kind == "function" and not in_color and token.lower_name in COLORS and safe_values(token.arguments, in_color=True):
            continue
        return False
    return True


def declarations(source):
    if isinstance(source, str) and len(source) > 8192:
        return ""
    result = []
    for node in tinycss2.parse_blocks_contents(source, skip_whitespace=True, skip_comments=True):
        if node.type != "declaration" or node.lower_name not in PROPERTIES:
            continue
        name = node.lower_name
        if not safe_values(node.value, font=name in {"font", "font-family"}):
            continue
        value = tinycss2.serialize(node.value).strip()
        if not value or (name == "display" and value.lower() not in DISPLAY):
            continue
        result.append(f"{name}:{value}" + ("!important" if node.important else ""))
        if len(result) >= 96:
            break
    return ";".join(result)


def selector_groups(tokens):
    if len(tokens) > 160 or any(t.type not in {"ident", "hash", "literal", "whitespace"} for t in tokens):
        return ""
    groups = []
    for selector in tinycss2.serialize(tokens).split(",")[:32]:
        selector = selector.strip()
        if not SELECTOR.fullmatch(selector):
            continue
        pseudo_names = re.findall(r":([a-z-]+)", selector, re.I)
        if selector.count(":") == len(pseudo_names) and all(name.lower() in PSEUDOS for name in pseudo_names):
            groups.append(selector)
    return ",".join(groups)


def media_condition(condition):
    return len(condition) < 500 and all(MEDIA.fullmatch(group.strip()) for group in condition.split(","))


def styles(rules, allow_media):
    output = []
    for rule in rules[:1400]:
        if rule.type == "qualified-rule":
            selectors = selector_groups(rule.prelude)
            if selectors:
                values = declarations(rule.content)
                if values:
                    output.append(f"{selectors}{{{values}}}")
        elif rule.type == "at-rule" and allow_media and rule.lower_at_keyword == "media" and rule.content:
            # Inspect the token grammar before serialization. Nested function/block
            # payloads must never cause unbounded recursive serialization.
            if len(rule.prelude) > 80 or any(t.type not in {"ident", "whitespace", "literal", "() block"} or
                    (t.type == "() block" and not all(v.type in {"ident", "whitespace", "literal", "dimension"}
                                                       for v in t.content)) for t in rule.prelude):
                continue
            condition = tinycss2.serialize(rule.prelude).strip()
            if media_condition(condition):
                inner = styles(tinycss2.parse_blocks_contents(rule.content, skip_whitespace=True, skip_comments=True), False)
                if inner:
                    output.append(f"@media {condition}{{{inner}}}")
    return "".join(output)


def stylesheet(source):
    if not source or len(source) > 128 * 1024:
        return ""
    return styles(tinycss2.parse_stylesheet(source, skip_whitespace=True, skip_comments=True), True)
