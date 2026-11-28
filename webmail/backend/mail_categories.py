"""Local inbox categories. Header signals organize mail; they do not authenticate its sender."""
import re
from email.utils import getaddresses

NAMES = ("updates", "social", "promotions", "purchases", "forums")
FLAGS = {name: f"veyro-category-{name}".encode() for name in ("primary", *NAMES)}
LIST_FIELDS = ("List-Id", "List-Post", "List-Unsubscribe", "X-Discourse-Topic-ID", "X-Mailman-Version",
               "X-GitHub-Reason", "Auto-Submitted", "Precedence")
FILTER_HEADERS = "BODY.PEEK[HEADER.FIELDS (SUBJECT FROM " + " ".join(LIST_FIELDS) + ")]"

# The same literals drive the cheap IMAP candidate search and the final decision
# on decoded headers. The final check can be stricter than the server search.
PURCHASES = ("order confirmation", "thanks for your order", "thank you for your order", "your order has",
             "your order is confirmed", "your amazon order", "order received", "ordered:", "shipped:", "delivered:",
             "your receipt", "payment receipt", "receipt for", "payment received", "payment confirmation",
             "shipping confirmation", "refund confirmation", "ordrebekræftelse", "tak for din ordre",
             "tak for din bestilling", "din kvittering", "din betaling", "forsendelsesbekræftelse")
DOCUMENTS = ("invoice", "receipt", "faktura", "kvittering")
UPDATES = ("security alert", "security code", "verification code", "password reset", "password was changed",
           "new sign-in", "new login", "confirm your email", "verify your email", "appointment reminder",
           "sikkerhedsadvarsel", "sikkerhedskode", "bekræftelseskode", "nulstil din adgangskode",
           "nyt login", "bekræft din e-mail", "påmindelse om din aftale", "du har fået ny post fra")
PROMOTIONS = ("newsletter", "nyhedsbrev", "black friday", "cyber monday", "special offer", "limited time offer",
              "discount", "% off", "free trial", "udsalg", "rabat", "tilbud", "promo code", "kampagnekode")
SOCIAL_DOMAINS = ("facebookmail.com", "facebook.com", "instagram.com", "linkedin.com", "pinterest.com",
                  "tiktok.com", "x.com", "twitter.com", "snapchat.com", "nextdoor.com")
FORUM_DOMAINS = ("groups.io", "googlegroups.com", "groups.google.com", "discourse.org", "redditmail.com", "reddit.com")
MARKETING_SENDERS = ("newsletter", "nyhedsbrev", "marketing", "promotions", "offers")
AUTOMATED_SENDERS = ("noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "notifications")
FORUM_HEADERS = ("List-Post", "X-Discourse-Topic-ID", "X-Mailman-Version")


def _from_domain(domain, domains):
    return any(domain == suffix or domain.endswith("." + suffix) for suffix in domains)


def infer(headers, address):
    """Classify incoming mail with a conservative fallback for personal correspondence."""
    subject = str(headers.get("Subject") or "").strip().casefold()[:1024]
    senders = getaddresses([str(headers.get("From") or "")])
    sender = senders[0][1].casefold() if len(senders) == 1 else ""
    if not sender or sender == address.casefold() or "@" not in sender:
        return "primary"
    local, domain = sender.rsplit("@", 1)
    if (any(headers.get(name) and str(headers[name]).strip().casefold() != "no" for name in FORUM_HEADERS)
            or _from_domain(domain, FORUM_DOMAINS)
            or str(headers.get("X-GitHub-Reason") or "").strip().casefold()
            in {"mention", "comment", "team_mention", "subscribed", "review_requested"}):
        return "forums"
    if re.match(r"^(?:re|fw|fwd|sv|vs)\s*:", subject):
        return "primary"
    if any(term in subject for term in UPDATES):
        return "updates"
    if any(term in subject for term in PURCHASES) or re.match(r"^(?:(?:your|din)\s+)?(?:invoice|receipt|faktura|kvittering)\b", subject):
        return "purchases"
    if _from_domain(domain, SOCIAL_DOMAINS):
        return "social"
    can_unsubscribe = bool(headers.get("List-Unsubscribe"))
    precedence = str(headers.get("Precedence") or "").casefold().strip()
    bulk = can_unsubscribe or precedence in {"list", "bulk"}
    automated = any(local == term or local.startswith(term + ".") or local.startswith(term + "+")
                    for term in AUTOMATED_SENDERS)
    if any(term in subject for term in PROMOTIONS) and (bulk or automated or
            any(subject.startswith(term) for term in PROMOTIONS)):
        return "promotions"
    if bulk and any(term in local for term in MARKETING_SENDERS):
        return "promotions"
    if headers.get("List-Id") and precedence == "list":
        return "forums"
    if can_unsubscribe and precedence == "bulk":
        return "promotions"
    if automated or str(headers.get("Auto-Submitted") or "").casefold().strip() == "auto-generated":
        return "updates"
    return "primary"


def effective(headers, flags, address, inbox):
    for name, flag in FLAGS.items():
        if flag in flags:
            return name
    return infer(headers, address) if inbox else "primary"


def _any_of(conditions):
    # IMAP OR is binary. Balance the expression to keep Dovecot's nesting small.
    if len(conditions) == 1:
        return conditions[0]
    middle = len(conditions) // 2
    return ["OR", _any_of(conditions[:middle]), _any_of(conditions[middle:])]


def candidates(category, inbox):
    """IMAP-searchable superset, including old manual keywords and explicit Primær."""
    if not inbox:
        return (["KEYWORD", FLAGS[category]] if category != "primary" else
                [part for name in NAMES for part in ("UNKEYWORD", FLAGS[name])])
    if category == "primary":
        return []  # Unknown messages stay in the inbox's primary tab.
    subjects, senders, fields = {
        "purchases": (PURCHASES + DOCUMENTS, (), ()),
        "social": ((), SOCIAL_DOMAINS, ()),
        "promotions": (PROMOTIONS, MARKETING_SENDERS, ("List-Unsubscribe",)),
        "forums": ((), FORUM_DOMAINS, FORUM_HEADERS + ("List-Id", "X-GitHub-Reason")),
        "updates": (UPDATES, AUTOMATED_SENDERS, ("Auto-Submitted",)),
    }[category]
    conditions = ([["KEYWORD", FLAGS[category]]] + [["SUBJECT", term] for term in subjects]
                  + [["FROM", sender] for sender in senders] + [["HEADER", name, ""] for name in fields])
    return _any_of(conditions)
