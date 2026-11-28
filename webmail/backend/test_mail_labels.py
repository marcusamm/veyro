import os
import tempfile
import unittest
from unittest.mock import patch

import mail_labels as labels
from mailstore import MailError, label_flag
import snooze


class Mailbox:
    def __init__(self):
        self.old, self.other = label_flag("Ældre"), label_flag("Behold")
        self.rows = {"INBOX": {7: {self.old, self.other, b"\\seen"}}, "Sendt": {7: {self.old}}}
        self.known = {name: set.union(set(), *rows.values()) for name, rows in self.rows.items()}
        self.folders = [{"name": name} for name in self.rows]
        self.fail = False
        self.recreate = None

    def select_folder(self, name, readonly):
        self.name = name
        if not readonly and name == self.recreate:
            self.rows[name] = {7: {self.other}}
            self.recreate = None
        return {b"FLAGS": tuple(self.known[name])}

    def search(self, criteria):
        return [uid for uid, flags in self.rows[self.name].items() if criteria[1] in flags]

    def add_flags(self, uids, flags):
        self.known[self.name].update(flags)
        for uid in uids:
            self.rows[self.name][uid].update(flags)
        return {uid: self.rows[self.name][uid] for uid in uids}

    def remove_flags(self, uids, flags):
        if self.fail and self.name == "Sendt":
            self.fail = False
            raise OSError("fixture disconnect before removal")
        for uid in uids:
            self.rows[self.name][uid].difference_update(flags)
        return {uid: self.rows[self.name][uid] for uid in uids}


class LabelCatalogTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        override = patch.object(snooze, "DATABASE", os.path.join(directory.name, "organizer.sqlite3"))
        override.start()
        self.addCleanup(override.stop)
        self.client = Mailbox()
        self.address = "test@example.invalid"

    def catalog(self):
        return labels.discover(self.address, self.client, self.client.folders)

    def change(self, operation, name, newName=None):
        return labels.manage(self.address, dict(operation=operation, name=name, newName=newName), self.client, self.client.folders)

    def test_legacy_and_empty_labels_scoped_to_authenticated_mailbox(self):
        self.assertEqual(set(self.catalog()["labels"]), {"Behold", "Ældre"})
        self.change("create", "Ny")
        self.assertIn("Ny", self.catalog()["labels"])
        other = labels.discover("other@example.invalid", self.client, [])
        self.assertEqual(other["labels"], [])
        with self.assertRaises(MailError):
            self.change("rename", "Ældre", "Ny")

    def test_retry_after_partial_rename_and_delete_recreate(self):
        self.client.fail = True
        with self.assertRaises(OSError):
            self.change("rename", "Ældre", "Nyt navn")
        self.assertEqual(self.catalog()["pending"][0]["newName"], "Nyt navn")
        with self.assertRaises(MailError):
            labels.record_message_label(self.address, "Ældre", lambda: None)
        self.change("rename", "Ældre", "Nyt navn")
        self.change("rename", "Ældre", "Nyt navn")
        self.assertEqual(self.client.rows["INBOX"][7], {label_flag("Behold"), b"\\seen", label_flag("Nyt navn")})
        self.assertEqual(self.client.rows["Sendt"][7], {label_flag("Nyt navn")})
        self.assertNotIn("Ældre", self.catalog()["labels"])
        self.change("delete", "Nyt navn")
        self.change("delete", "Nyt navn")
        self.assertEqual(self.client.rows["INBOX"][7], {label_flag("Behold"), b"\\seen"})
        self.assertEqual(self.client.rows["Sendt"][7], set())
        self.change("create", "Ældre")
        self.assertIn("Ældre", self.catalog()["labels"])
        self.assertEqual(self.client.rows["Sendt"][7], set())

    def test_recreated_folder_with_reused_uid_remains_intact(self):
        self.client.recreate = "Sendt"
        self.change("rename", "Ældre", "Haster")
        self.assertEqual(self.client.rows["Sendt"][7], {self.client.other})

    def test_individual_action_only_registers_on_success(self):
        def fail():
            raise MailError("Fixture")
        with self.assertRaises(MailError):
            labels.record_message_label(self.address, "Test", fail)
        self.assertNotIn("Test", self.catalog()["labels"])
        self.assertEqual(labels.record_message_label(self.address, "Test", lambda: {"ok": True}), {"ok": True})
        self.assertIn("Test", self.catalog()["labels"])
