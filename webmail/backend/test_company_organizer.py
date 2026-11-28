import email.policy
from email.message import EmailMessage
import os
from pathlib import Path
import secrets
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import MagicMock, patch

from cryptography.fernet import Fernet
import company_organizer as org
from mailstore import MailError


class ScheduleTests(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.key = root / "key"
        self.key.write_bytes(Fernet.generate_key())
        self.path = root / "queue"
        self.now = 2000000000
        self.queue = self.new()
        self.address = "me@example.test"
        self.generation = "a"*64
        self.password = "synthetic-only-secret"
        self.token = secrets.token_urlsafe(24)
        self.body = {"to":"test@example.test","subject":"Hemmelig test","text":"Fortrolig besked"}
        self.due = self.now+100

    def new(self):
        return org.Schedule(self.path,self.key,clock=lambda: self.now)

    def prepare(self):
        msg = EmailMessage(policy=email.policy.SMTP)
        msg["Subject"] = self.body["subject"]
        msg["To"] = self.body["to"]
        msg.set_content(self.body["text"])
        return msg, [self.body["to"]]

    def enqueue(self, key=None):
        return self.queue.add(self.address,self.generation,self.password,key or self.token,self.due,self.body,self.prepare)

    def test_durable_and_encrypted_queue_sends_once_across_independent_workers(self):
        entry = self.enqueue()
        self.assertEqual(entry,self.enqueue())
        raw = self.path.read_bytes()
        for clear in (self.password,self.address,self.body['to'],self.body['text'],self.body['subject']):
            self.assertNotIn(clear.encode(),raw)
        self.assertEqual(self.new().listing(self.address,self.generation)[0]['id'],entry['id'])
        self.assertFalse(self.new().deliver_one(lambda *_: self.fail()))
        self.now = self.due
        calls, winners = [], []
        def send(head, raw):
            calls.append(head)
            self.assertIn(b'Hemmelig test',raw)
            return "sent"
        def worker():
            winners.append(self.new().deliver_one(send))
        pool=[threading.Thread(target=worker) for _ in range(6)]
        for t in pool: t.start()
        for t in pool: t.join()
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]['password'],self.password)
        self.assertEqual(winners.count(True),1)
        self.assertEqual(len(winners),6)
        self.assertEqual(self.enqueue()['status'],'sent')
        self.assertEqual(self.queue.listing(self.address,self.generation),[])
        with self.queue.connection() as db:
            self.assertIsNone(db.execute("SELECT delivery FROM scheduled").fetchone()[0])

    def test_cancel_idempotent_and_scoped_to_account_and_generation(self):
        item = self.enqueue()
        for address, gen in [('other@example.test',self.generation),(self.address,'new-owner')]:
            self.assertEqual(self.queue.listing(address,gen),[])
            with self.assertRaises(MailError):
                self.queue.cancel(address,gen,item['id'])
        self.queue.cancel(self.address,self.generation,item['id'])
        self.queue.cancel(self.address,self.generation,item['id'])
        self.assertEqual(self.enqueue()['status'],'cancelled')
        self.now = self.due+1
        self.assertFalse(self.queue.deliver_one(lambda *_: self.fail()))

    def test_changed_content_cannot_reuse_request_and_unconfirmed_send_never_retries(self):
        entry = self.enqueue()
        self.body["subject"] = "Ændret"
        with self.assertRaises(MailError): self.enqueue()
        self.now = self.due+1
        self.assertTrue(self.queue.deliver_one(lambda *_: "unknown"))
        self.assertFalse(self.queue.deliver_one(lambda *_: self.fail()))
        self.assertEqual(self.queue.listing(self.address,self.generation)[0]["status"],"unknown")
        with self.assertRaises(MailError): self.queue.cancel(self.address,self.generation,entry['id'])

    def test_bad_times_and_missing_key_fail_closed(self):
        for due in [self.now,self.now-1,self.now+31*86400,"2030-01-01",True]:
            self.due = due
            with self.assertRaises(MailError): self.enqueue()
        self.key.unlink()
        with self.assertRaises(MailError): self.queue.listing(self.address,self.generation)

class ScheduledTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("WEBMAIL_ORIGIN", "https://webmail.example.test")
        os.environ.setdefault("WEBMAIL_STAFF", "staff@example.test")
        import app
        cls.webmail = app

    def test_actual_send_pipeline_uses_authenticated_owner_and_writes_sent_copy(self):
        mail = self.webmail.mailstore
        head = dict(address="test@example.test", password="synthetic", generation="fixture", recipients=["news@example.test"])
        data = dict(to=head["recipients"][0], subject="Testmail", text="Privat testtekst")
        client = MagicMock()
        msg, _ = mail.prepare_message(client, head["address"], data)
        with patch.object(self.webmail, "credential_version", return_value="fixture"), \
             patch.object(mail, "connect", return_value=client) as connect, \
             patch.object(mail, "folder_list", return_value=[dict(role="sent",id=mail.folder_id("Sent"))]), \
             patch.object(mail, "verified_tls"), patch.object(mail.smtplib, "SMTP_SSL") as smtp:
            smtp.return_value.send_message.return_value = {}
            self.assertEqual(self.webmail.submit_scheduled(head, msg.as_bytes()), "sent")
            connect.assert_called_once_with(head["address"], head["password"])
            sent = smtp.return_value.send_message.call_args
            self.assertEqual(sent.kwargs, dict(from_addr=head["address"], to_addrs=head["recipients"]))
            self.assertEqual(sent.args[0]["Message-ID"], msg["Message-ID"])
            self.assertEqual(client.append.call_args.args[:2], ("Sent", sent.args[0].as_bytes()))
            client.shutdown.assert_called_once()

    def test_changed_credential_generation_never_opens_mail_transport(self):
        with patch.object(self.webmail, "credential_version", return_value="changed"), \
             patch.object(self.webmail.mailstore, "connect") as connect:
            self.assertEqual(self.webmail.submit_scheduled(dict(address="test@example.test",generation="old"), b""), "access-changed")
            connect.assert_not_called()


class SubscriptionTests(unittest.TestCase):
    @staticmethod
    def row(sender, listid, unsubscribe):
        raw = f"From: Test <{sender}>\r\nList-ID: {listid}\r\nList-Unsubscribe: {unsubscribe}\r\n\r\n".encode()
        return {b"BODY[HEADER.FIELDS (FROM LIST-ID LIST-UNSUBSCRIBE)]<0>":raw}

    def test_dedup_by_list_and_sender_keep_latest_token_and_offer_only_explicit_links(self):
        c = MagicMock()
        c.select_folder.return_value = {b"UIDVALIDITY":42}
        c.search.return_value=[7,9,10,11]
        c.fetch.return_value={
            7:self.row('news@example.test','<list>','<https://example.test/u/old>'),
            9:self.row('news@example.test','<list>','<https://example.test/u/new>'),
            10:self.row('news@example.test','<other>','<mailto:bye@example.test?subject=stop&body=bye>'),
            11:self.row('other@example.test','<fake>','<file:///secret>, <javascript:alert>'),
        }
        items=org.subscriptions(c,None)['items']
        self.assertEqual(len(items),2)
        self.assertEqual(items[0]['target']['value'],'bye@example.test')
        self.assertEqual(items[1]['target']['value'],'https://example.test/u/new')
        c.select_folder.assert_called_with("INBOX",readonly=True)
        self.assertIn("BODY.PEEK",c.fetch.call_args.args[1][0])
        with self.assertRaises(MailError): org.subscriptions(c,'99.20')

    def test_unsafe_authorities_and_mailto_header_injection_drop(self):
        for value in ['<http://example.test/u>','<https://user@other.test/u>',
                      '<mailto:q@example.test%0Abcc:other@example.test>','<mailto:q@example.test?subject=ok%0abcc:test>']:
            self.assertFalse(org.unsubscribe_targets(value),value)


if __name__ == "__main__":
    unittest.main()
