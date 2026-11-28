import datetime
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import mailstore
import mail_views
from test_mail_actions import record


class CompanyViews(unittest.TestCase):
    def setUp(self):
        self.folders = [dict(name=name, id=mailstore.folder_id(name), role=role)
                        for name, role in [("INBOX", "inbox"), ("Arkiv", "archive"), ("Spam", "junk"), ("Trash", "trash")]]
        self.session = SimpleNamespace(email="synthetic@example.invalid", view_pages={},
                                       cached_folders=lambda _: self.folders)
        self.client = MagicMock()
        self.client.capabilities.return_value = ()
        self.client.select_folder.side_effect = self.select
        self.client.fetch.side_effect = self.fetch

    def select(self, folder, readonly):
        self.assertTrue(readonly)
        self.assertIn(folder, ("INBOX", "Arkiv"))
        self.folder = folder
        return {b"UIDVALIDITY": 99, b"EXISTS": 34, b"FLAGS": ()}

    def fetch(self, uids, fields):
        self.assertFalse(any(item.startswith("BODY[") for item in fields))
        out = {}
        for uid in uids:
            row = record(uid)
            row[b"INTERNALDATE"] = datetime.datetime.fromtimestamp(2*uid + int(self.folder == "INBOX"), datetime.timezone.utc)
            out[uid] = row
        return out

    def page(self, view="all", cursor=None, label=""):
        return mail_views.list_page(self.client, self.session, view, cursor, "", label, "")

    def test_pagination_returns_physical_ids_and_complete_retryable_pages(self):
        full = []
        first = self.page()
        page = first
        while True:
            full += [(r["folder"], r["id"]) for r in page["messages"]]
            self.assertFalse(any("_after" in row or "_arrival" in row for row in page["messages"]))
            if not page["nextCursor"]:
                break
            page = self.page(cursor=page["nextCursor"])
        expected = [(f["id"], f"99.{uid}") for uid in range(34, 0, -1) for f in self.folders[:2]]
        self.assertEqual(full, expected)
        again = self.page(cursor=first["nextCursor"])
        self.assertEqual(again["messages"][0]["id"], "99.19")
        with self.assertRaises(mailstore.MailError):
            self.page(view="important", cursor=first["nextCursor"])
        self.session.view_pages = {}
        with self.assertRaises(mailstore.MailError):
            self.page(cursor=first["nextCursor"])

    def test_named_views_use_imap_flags(self):
        for view, label, expected in [("labels", "Kunder", ["KEYWORD", mailstore.label_flag("Kunder")]),
                                       ("starred", "", ["FLAGGED"]), ("important", "", ["KEYWORD", mailstore.IMPORTANT])]:
            self.client.search.return_value = [5]
            page = self.page(view=view, label=label)
            self.client.search.assert_called_with(expected, charset="UTF-8")
            self.assertEqual(len(page["messages"]), 2)
        self.client.add_flags.assert_not_called()

    def test_flags_and_categories_survive_a_second_read(self):
        flags = set()
        row = record(5)
        def store(uids, update, add):
            (flags.update if add else flags.difference_update)(update)
            row[b"FLAGS"] = tuple(flags)
            return {5: tuple(flags)}
        self.client.add_flags.side_effect = lambda ids, f: store(ids, f, True)
        self.client.remove_flags.side_effect = lambda ids, f: store(ids, f, False)
        with patch.object(mailstore, "lookup", return_value=(99, 5, row)):
            for action in ("star", "important", "unstar", "unimportant"):
                mailstore.message_action(self.client, "INBOX", "99.5", {"action": action}, [])
                result = mailstore.message_summary(row, 99)
                self.assertEqual(result["starred" if "star" in action else "important"], not action.startswith("un"))
            for category in ("purchases", "forums", "primary"):
                mailstore.message_action(self.client, "INBOX", "99.5", {"action": "category", "category":category}, [])
                self.assertEqual(mailstore.message_summary(row, 99)["category"], category)
