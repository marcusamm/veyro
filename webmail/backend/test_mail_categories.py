import email.policy
import unittest
from email.parser import BytesHeaderParser
from unittest.mock import patch

import mail_categories as categories
import mailstore as mail


def header(subject, sender="alex@example.test", extra=""):
    return f"Subject: {subject}\r\nFrom: {sender}\r\n{extra}\r\n".encode()


class HeaderRules(unittest.TestCase):
    def test_categories_use_decoded_danish_and_english_headers_and_preserve_personal_mail(self):
        examples = (
            ("purchases", header("=?utf-8?q?Ordrebekr=C3=A6ftelse_123?=", "orders@shop.test")),
            ("purchases", header("Your receipt from Shopify")),
            ("social", header("You have a new connection", "Alex <messages@in.linkedin.com>")),
            ("social", header("Din ven har kommenteret", "ping@facebookmail.com")),
            ("updates", header("Security alert", "noreply@instagram.com")),
            ("updates", header("Din konto er klar", extra="Auto-Submitted: auto-generated\r\n")),
            ("forums", header("Re: Eksempel", extra="List-Post: <mailto:dev@lists.example.test>\r\n")),
            ("forums", header("Et nyt svar", extra="X-Discourse-Topic-ID: 123\r\n")),
            ("promotions", header("Denne uges tilbud", extra="List-Unsubscribe: <https://shop.test/unsubscribe>\r\n")),
            ("promotions", header("Nyhedsbrev for november")),
            ("promotions", header("Lad dig inspirere", extra="Precedence: bulk\r\nList-Unsubscribe: <mailto:list@shop.test>\r\n")),
            ("forums", header("Re: [team/project] Kommentar", extra="X-GitHub-Reason: mention\r\n")),
            ("primary", header("Skal vi sende fakturaen i dag?")),
            ("primary", header("Re: Your receipt for 42")),
            ("primary", header("Hello", '"Facebook" <friend@notfacebook.com>')),
            ("primary", header("Din kvittering", "buyer@example.test")),
        )
        for expected, raw in examples:
            with self.subTest(raw=raw):
                h = BytesHeaderParser(policy=email.policy.default).parsebytes(raw)
                self.assertEqual(categories.effective(h, set(), "buyer@example.test", True), expected)
                self.assertEqual(categories.effective(h, set(), "buyer@example.test", False), "primary")

    def test_persistent_overrides_include_primary_and_historical_keywords(self):
        h = BytesHeaderParser(policy=email.policy.default).parsebytes(header("Order confirmation"))
        self.assertEqual(categories.effective(h, set(), "", True), "purchases")
        for category in categories.FLAGS:
            flags = {categories.FLAGS[category]}
            for inbox in (True, False):
                self.assertEqual(categories.effective(h, flags, "", inbox), category)


class Mailbox:
    def __init__(self):
        self.rows = {}
        self.full_fetches = []
        self.writes = []

    def add(self, uid, subject, sender="buyer@example.test", extra="", flags=()):
        self.rows[uid] = {b"SEQ": uid, b"UID": uid, b"FLAGS": tuple(flags), b"BODYSTRUCTURE": (),
                          b"BODY[HEADER.FIELDS (SUBJECT FROM)]": header(subject, sender, extra)}

    def select_folder(self, name, readonly=True):
        return {b"UIDVALIDITY": 17, b"EXISTS": len(self.rows)}

    def capabilities(self):
        return []

    def fetch(self, uids, fields):
        if any(f in fields for f in ("BODYSTRUCTURE", "PREVIEW")):
            self.full_fetches.extend(uids)
        if any(f.startswith("BODY[") for f in fields):
            raise AssertionError("Reading a category must not mark mail as seen.")
        return {uid: self.rows[uid].copy() for uid in uids if uid in self.rows}

    def search(self, terms, charset):
        # Interpret precisely the subset used for category lists including binary
        # OR, ordinary IMAP AND, and the UID fence when moving to an older page.
        def matches(uid, terms):
            row = self.rows[uid]
            parsed = mail.headers(row)
            tokens = iter(terms)

            def expression(token):
                if isinstance(token, list):
                    return matches(uid, token)
                if token == "OR":
                    left, right = expression(next(tokens)), expression(next(tokens))
                    return left or right
                if token == "UID":
                    lower, upper = map(int, next(tokens).split(":"))
                    return lower <= uid <= upper
                if token == "KEYWORD":
                    return next(tokens) in row[b"FLAGS"]
                if token == "ALL":
                    return True
                if token in ("FROM", "SUBJECT", "HEADER"):
                    field = next(tokens) if token == "HEADER" else token
                    value = next(tokens).casefold()
                    return field in parsed and value in str(parsed[field]).casefold()
                raise AssertionError(token)

            return all(expression(token) for token in tokens)
        return [uid for uid in self.rows if matches(uid, terms)]

    def add_flags(self, uids, flags):
        self.writes.append((uids, flags))
        for uid in uids:
            self.rows[uid][b"FLAGS"] = tuple(set(self.rows[uid][b"FLAGS"]) | set(flags))
        return {uid: self.rows[uid][b"FLAGS"] for uid in uids}

    def remove_flags(self, uids, flags):
        self.writes.append((uids, flags))
        for uid in uids:
            self.rows[uid][b"FLAGS"] = tuple(set(self.rows[uid][b"FLAGS"]) - set(flags))
        return {uid: self.rows[uid][b"FLAGS"] for uid in uids}


class CategoryViews(unittest.TestCase):
    def setUp(self):
        self.client = Mailbox()
        self.client.add(1, "Ordrebekræftelse")
        self.client.add(2, "Re: Dankort")
        self.client.add(3, "Favoritter", "me@pinterest.com")
        self.client.add(4, "Verification code", "noreply@pinterest.com")
        self.client.add(5, "Re: test", extra="List-Post: <mailto:test@lists.example.test>\r\n")
        self.client.add(6, "Test", "news@shop.test", "List-Unsubscribe: <https://shop.test/u>\r\n")
        self.client.add(7, "Black Friday")
        self.client.add(8, "Kundemøde", flags=[categories.FLAGS["purchases"]])

    def listing(self, name, cursor=None):
        return mail.list_messages(self.client, "INBOX", cursor, "", category=name, address="reader@example.test")

    def test_every_tab_selects_only_effective_category_and_respects_a_manual_primary(self):
        expected = {"purchases": {1, 8}, "primary": {2, 6}, "social": {3}, "updates": {4}, "forums": {5}, "promotions": {7}}
        for name, uids in expected.items():
            page = self.listing(name)
            self.assertEqual([row["id"] for row in page["messages"]], [f"17.{uid}" for uid in sorted(uids, reverse=True)])
            self.assertTrue(all(row["category"] == name for row in page["messages"]))
        self.assertEqual(self.client.writes, [])
        mail.message_action(self.client, "INBOX", "17.1", dict(action="category", category="primary"), [])
        self.assertEqual([r["id"] for r in self.listing("purchases")["messages"]], ["17.8"])
        self.assertIn("17.1", [r["id"] for r in self.listing("primary")["messages"]])
        self.assertEqual(self.client.rows[1][b"FLAGS"], (categories.FLAGS["primary"],))
        self.client.add(9, "Your receipt")
        self.assertEqual(self.listing("purchases")["messages"][0]["id"], "17.9")

    def test_page_fences_and_candidate_screening_before_hydrating(self):
        for uid in range(9, 180):
            flags = [categories.FLAGS["forums"]] if uid % 2 == 0 else []
            self.client.add(uid, "Receipt for order " + str(uid), flags=flags)
        with patch.object(mail, "PAGE", 5):
            first = self.listing("purchases")
            self.assertEqual(self.client.full_fetches, [179, 177, 175, 173, 171, 169])
            self.client.add(180, "Invoice 145")
            del self.client.rows[169]
            second = self.listing("purchases", first["nextCursor"])
        self.assertEqual([x["id"] for x in second["messages"]], ["17.167", "17.165", "17.163", "17.161", "17.159"])
        self.assertTrue(all(not self.client.rows[uid][b"FLAGS"] for uid in self.client.full_fetches if uid in self.client.rows))
