import hashlib
import importlib.util
import json
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("recovery_setup", Path(__file__).with_name("configure-recovery.py"))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class MailboxEligibility(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.create_function("SHA2", 2, lambda value, _: hashlib.sha256(value.encode()).hexdigest() if value is not None else None)
        self.db.create_function("CONCAT", -1, lambda *args: None if None in args else "".join(map(str, args)))
        self.db.create_function("CONCAT_WS", -1, lambda sep, *args: sep.join(str(a) for a in args if a is not None))
        self.db.create_function("JSON_VALUE", 2, lambda data, path: json.loads(data).get(path[2:]))
        self.db.executescript("""
            CREATE TABLE domain (domain TEXT PRIMARY KEY, active INT, backupmx INT, relay_all_recipients INT);
            CREATE TABLE mailbox (username TEXT PRIMARY KEY, password TEXT, domain TEXT, active INT, kind TEXT, authsource TEXT, attributes TEXT);
            CREATE TABLE tfa (username TEXT, active INT);
            CREATE TABLE admin (username TEXT);
            CREATE TABLE app_passwd (id INTEGER PRIMARY KEY, mailbox TEXT, password TEXT, active INT, imap_access INT, smtp_access INT);
            INSERT INTO domain VALUES ('customer.test',1,0,0), ('veyro.dk',1,0,0);
            INSERT INTO mailbox VALUES ('user@customer.test','testhash','customer.test',1,'','mailcow','{}'),
                ('marcus@veyro.dk','testhash','veyro.dk',1,'','mailcow','{}');
        """)
        # SQLite spells GROUP_CONCAT's separator as an argument. Fixture keys
        # use ascending integer primary keys, the order specified in production.
        query = setup.mailbox_view_query().replace(" ORDER BY ap.id SEPARATOR ''", ", ''")
        self.db.execute("CREATE VIEW versions AS " + query)

    def version(self, address="user@customer.test"):
        row = self.db.execute("SELECT version FROM versions WHERE username=?", (address,)).fetchone()
        return row[0] if row else None

    def test_local_mailbox_and_domain_are_both_required(self):
        self.assertEqual(len(self.version()), 64)
        self.assertIsNone(self.version("alias@customer.test"))
        cases = [
            "UPDATE domain SET active=0", "UPDATE domain SET backupmx=1", "UPDATE domain SET relay_all_recipients=1",
            "UPDATE mailbox SET active=0", "UPDATE mailbox SET kind='group'", "UPDATE mailbox SET authsource='ldap'",
            "INSERT INTO admin VALUES ('user@customer.test')",
        ]
        for sql in cases:
            with self.subTest(sql=sql):
                self.db.execute("SAVEPOINT test_case")
                self.db.execute(sql)
                self.assertIsNone(self.version())
                self.db.execute("ROLLBACK TO test_case")
                self.db.execute("RELEASE test_case")

    def test_mailbox_flags_and_challenges(self):
        for flags in [{"shared":"1"}, {"imap_access":"0"}, {"sogo_access":"0"}, {"force_tfa":"1"}, {"force_pw_update":"1"}]:
            with self.subTest(flags=flags):
                self.db.execute("UPDATE mailbox SET attributes=? WHERE domain='customer.test'", (json.dumps(flags),))
                self.assertIsNone(self.version())
        self.db.execute("UPDATE mailbox SET attributes='{}'")
        for active in [0, 1]:
            self.db.execute("DELETE FROM tfa")
            self.db.execute("INSERT INTO tfa SELECT username,? FROM mailbox", (active,))
            self.assertIsNone(self.version())
            self.assertIsNotNone(self.version("marcus@veyro.dk"))

    def test_credential_version_follows_primary_password_and_app_permissions(self):
        address = "user@customer.test"
        first = self.version()
        self.db.execute("UPDATE mailbox SET password='different' WHERE username=?", (address,))
        after_password = self.version()
        self.assertNotEqual(first, after_password)
        self.db.execute("INSERT INTO app_passwd VALUES (1,?,'testapphash',1,1,1)", (address,))
        after_add = self.version()
        self.assertNotEqual(after_password, after_add)
        self.db.execute("UPDATE app_passwd SET smtp_access=0")
        after_scope = self.version()
        self.assertNotEqual(after_add, after_scope)
        self.db.execute("DELETE FROM app_passwd")
        self.assertEqual(self.version(), after_password)

    def test_view_only_migrations_do_not_modify_mailboxes_or_recovery(self):
        with patch.object(setup.os, "geteuid", create=True, return_value=0), patch.object(setup, "sql") as sql:
            for rollback in [False, True]:
                setup.migrate_mailbox_view(staff_only=rollback)
                command = sql.call_args.args[0]
                self.assertTrue(command.startswith("ALTER SQL SECURITY DEFINER VIEW"))
                self.assertNotIn("UPDATE ", command)
                self.assertNotIn("GRANT ", command)
                self.assertNotIn("reset_password", command)
                self.assertEqual(command.count(";"), 1)


if __name__ == "__main__":
    unittest.main()
