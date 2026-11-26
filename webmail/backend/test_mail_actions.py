import email.policy
import unittest
from email.parser import BytesParser
from unittest.mock import MagicMock, patch

import mailstore as mail


def record(uid, sender="sender@example.net", flags=()):
    return {
        b"UID": uid, b"SEQ": uid, b"FLAGS": flags, b"BODYSTRUCTURE": (),
        b"BODY[HEADER.FIELDS (FROM TO CC SUBJECT)]": (
            f"From: {sender}\r\nTo: me@veyro.dk, other@example.net\r\n"
            "Cc: other@example.net, third@example.net\r\nSubject: Original\r\n\r\n"
        ).encode(),
    }


class MailActions(unittest.TestCase):
    def test_summary_excludes_self_deduplicates_and_decodes_labels(self):
        flag = mail.label_flag("Åbne sager")
        row = record(5, flags=[flag.upper(), mail.TASK, mail.CATEGORIES["social"]])
        result = mail.message_summary(row, 99, "ME@veyro.dk")
        self.assertEqual(result["replyAllTo"], ["sender@example.net"])
        self.assertEqual(result["replyAllCc"], ["other@example.net", "third@example.net"])
        self.assertEqual(result["labels"], ["Åbne sager"])
        self.assertEqual(result["category"], "social")
        self.assertTrue(result["task"])

    def test_filters_across_pages_before_cursor(self):
        rows = {i: record(i, "other@example.net" if i % 4 == 0 else "sales@example.net") for i in range(1, 90)}
        hidden = set(range(51, 73))
        client = MagicMock()
        client.select_folder.return_value = {b"UIDVALIDITY": 99, b"EXISTS": 89}
        client.capabilities.return_value = ()
        client.search.return_value = list(rows)
        client.fetch.side_effect = lambda ids, fields: {i: rows[i] for i in ids}
        def listing(cursor=None):
            return mail.list_messages(client, "INBOX", cursor, "", sender="sales@example.net", snoozed=lambda _: hidden)
        first = listing()
        second = listing(first["nextCursor"])
        self.assertEqual(len(first["messages"]), mail.PAGE)
        expected = sorted((i for i in rows if i % 4 and i not in hidden), reverse=True)
        actual = [int(item["id"].split(".")[1]) for item in first["messages"] + second["messages"]]
        self.assertEqual(actual, expected)
        self.assertIsNone(second["nextCursor"])
        deferred = mail.list_messages(client, "INBOX", None, "", snoozed=lambda _: hidden, only_snoozed=True, view="snoozed")
        self.assertEqual([x["id"] for x in deferred["messages"]], [f"99.{uid}" for uid in sorted(hidden, reverse=True)])

    def test_read_only_read_does_not_mark_seen(self):
        client = MagicMock()
        with patch.object(mail, "lookup", return_value=(99, 5, record(5))) as lookup:
            result = mail.read_message(client, "INBOX", "99.5", mark_seen=False)
        lookup.assert_called_once_with(client, "INBOX", "99.5", readonly=True)
        client.add_flags.assert_not_called()
        self.assertTrue(result["unread"])

    def test_move_to_trash_uses_only_target_uid(self):
        client = MagicMock()
        client.capabilities.return_value = [b"MOVE"]
        client.select_folder.return_value = {b"UIDVALIDITY": 99}
        client.fetch.return_value = {5: record(5)}
        folders = [{"role": "trash", "name": "Deleted"}]
        mail.message_action(client, "INBOX", "99.5", {"action": "trash"}, folders)
        client.move.assert_called_once_with([5], "Deleted")
        client.expunge.assert_not_called()
        with self.assertRaises(mail.MailError):
            mail.message_action(client, "INBOX", "98.5", {"action": "trash"}, folders)
        self.assertEqual(client.move.call_count, 1)

    def test_rejected_keyword_store_cannot_report_success(self):
        client = MagicMock()
        client.add_flags.return_value = {5: (b"\\Seen",)}
        with self.assertRaises(mail.MailError):
            mail.set_flags_checked(client, 5, [mail.TASK], True)

    @patch.object(mail, "verified_tls")
    @patch.object(mail.smtplib, "SMTP_SSL")
    def test_forward_original_with_cc_preserves_exact_bytes(self, smtp_ssl, _tls):
        client = MagicMock()
        raw = b"From: Test <sender@example.net>\r\nX-Original: exact\r\n\r\nhello\r\n"
        client.fetch.side_effect = [{5: {b"RFC822.SIZE": len(raw)}}, {5: {b"BODY[]<0>": raw}}]
        smtp = smtp_ssl.return_value
        smtp.send_message.return_value = {}
        with patch.object(mail, "lookup", return_value=(99, 5, record(5))):
            mail.send_message(client, "me@veyro.dk", "example", {
                "to": "example@example.org", "cc": "cc@example.org", "subject": "Fwd", "text": "",
                "forwardAttachment": {"id": "99.5", "folder": mail.folder_id("INBOX")},
            }, [])
        args, kwargs = smtp.send_message.call_args
        self.assertEqual(kwargs["to_addrs"], ["example@example.org", "cc@example.org"])
        parsed = BytesParser(policy=email.policy.default).parsebytes(args[0].as_bytes())
        part, = parsed.iter_attachments()
        self.assertEqual(part.get_filename(), "Original.eml")
        self.assertEqual(part.get_payload(decode=True), raw)
        self.assertEqual(str(parsed["Cc"]), "cc@example.org")

    def test_oversize_forward_refused_without_downloading_or_submitting(self):
        client = MagicMock()
        client.fetch.return_value = {5: {b"RFC822.SIZE": mail.MAX_FORWARD + 1}}
        with patch.object(mail, "lookup", return_value=(99, 5, record(5))), patch.object(mail.smtplib, "SMTP_SSL") as smtp:
            with self.assertRaises(mail.MailError) as error:
                mail.send_message(client, "me@veyro.dk", "example", {
                    "to": "example@example.net", "forwardAttachment": {"id": "99.5", "folder": mail.folder_id("INBOX")},
                }, [])
        self.assertEqual(error.exception.status, 413)
        self.assertEqual(client.fetch.call_count, 1)
        smtp.assert_not_called()


if __name__ == "__main__":
    unittest.main()
