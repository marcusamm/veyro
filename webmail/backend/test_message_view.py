import os
import struct
import unittest
from unittest.mock import Mock, MagicMock, patch

import mailstore
import message_view as view


def body_part(kind, source, *, attached=False):
    return {"mime": "text/" + kind, "id": kind, "size": len(source), "attachment": attached,
            "filename": "notes.html" if attached else "", "charset": "utf-8", "encoding": "8bit"}


class MessageReading(unittest.TestCase):
    def message(self, bodies, *, scan=("clean", None), rich=True, junk=False, header=b"", attached=False):
        client = Mock()
        row = {b"UID": 7, b"BODYSTRUCTURE": (), b"FLAGS": (), b"RFC822.SIZE": 100,
               b"BODY[HEADER.FIELDS (FROM TO SUBJECT)]": header}
        parts = [body_part(k, v, attached=attached and k == "html") for k, v in bodies.items()]
        with patch.object(mailstore, "lookup", return_value=(4, 7, row)), \
                patch.object(mailstore, "section_tree", return_value=parts), \
                patch.object(mailstore, "read_part", side_effect=lambda c, u, part, limit: bodies[part["id"]]), \
                patch.object(view, "antivirus", return_value=scan) as scanner:
            result = mailstore.read_message(client, "INBOX", "4.7", mark_seen=False, inspect_content=rich, in_junk=junk)
        client.add_flags.assert_not_called()
        self.assertEqual(scanner.called, rich)
        return result

    def test_html_only_preserves_links_and_format_without_contacting_resources(self):
        source = ('<h2>Booking</h2><table><tr><td rowspan="2">Status</td></tr></table>'
                  '<img src="https://img.invalid/pixel" alt="pixel"><form>Private form</form>'
                  '<p style="color:red" onclick="unused"><a href="https://example.test/book">Book tid</a></p>'
                  '<a href="/relative">relative</a><a href="data:text/plain,example">other</a>'
                  '<a href="//other.invalid">network</a>').encode()
        result = self.message({"html": source}, scan=("unknown", view.SCANNER_UNAVAILABLE))
        self.assertEqual(result["security"]["status"], "unknown")
        self.assertIn("Book tid (https://example.test/book)", result["text"])
        self.assertIn('<a href="https://example.test/book"', result["html"])
        self.assertIn("<table>", result["html"])
        for removed in ("img.invalid", "style=", "onclick=", "Private form", 'href="/relative"', "data:text", "other.invalid"):
            self.assertNotIn(removed, result["html"])

    def test_plain_and_html_alternatives_preserve_plain_original(self):
        result = self.message({"plain": b"Plain original", "html": b"<strong>HTML alternative</strong>"})
        self.assertEqual(result["text"], "Plain original")
        self.assertIn("<strong>HTML alternative</strong>", result["html"])
        self.assertEqual(result["security"], {"status": "clean", "reasons": []})

    def test_html_only_mailto_allows_subject_and_body_for_one_recipient(self):
        href = "mailto:team@example.test?subject=Booking&amp;body=Hello%20there"
        result = self.message({"html": f'<a href="{href}">Skriv til os</a>'.encode()})
        self.assertIn(href, result["html"])
        self.assertIn("Skriv til os (mailto:team@example.test?subject=Booking&body=Hello%20there)", result["text"])
        for rest in ("?subject=Hi%0d%0aCc%3Aother%40example.test", "?bcc=other@example.test",
                     "?body=Hello%00", "?subject=Hi&subject=Again", "%2cother@example.test"):
            safe, _, _ = view.html_view(f'<a href="mailto:team@example.test{rest}">Write</a>')
            self.assertNotIn("href=", safe)

    def test_plain_only_and_attached_html(self):
        result = self.message({"plain": b"https://example.test", "html": b"<b>attachment</b>"}, attached=True)
        self.assertEqual(result["text"], "https://example.test")
        self.assertIsNone(result["html"])
        self.assertEqual(result["attachments"][0]["name"], "notes.html")

    def test_forged_advisory_headers_do_not_promote_message(self):
        result = self.message({"plain": b"example"}, scan=("unknown", view.SCANNER_UNAVAILABLE),
                              header=b"X-Virus-Status: Clean\r\nX-Spam-Status: No\r\n\r\n")
        self.assertEqual(result["security"], {"status": "unknown", "reasons": [view.SCANNER_UNAVAILABLE]})

    def test_scanner_warning_and_mismatched_visible_domains(self):
        bad = b'<a href="https://different.test/view">https://shown.test/view</a>'
        result = self.message({"html": bad})
        self.assertEqual(result["security"]["status"], "suspicious")
        self.assertIn(view.LINK_MISMATCH, result["security"]["reasons"])
        self.assertIn("different.test", result["html"])
        clean = self.message({"html": b'<a href="https://shop.shown.test/">shown.test</a>'})
        self.assertEqual(clean["security"]["status"], "clean")
        self.assertEqual(self.message({"plain": b"Hi"}, junk=True)["security"]["status"], "suspicious")

    def test_attachment_or_secret_requests_are_suspicious_and_no_html_for_malware(self):
        with patch.object(view, "antivirus", return_value=("clean", None)):
            parts = [{"attachment": True, "filename": "file.exe"}]
            result = view.assess(None, 7, 100, parts, "Please send your password", "", False, False, False)
        self.assertEqual(result["reasons"], [view.RISKY_ATTACHMENT, view.CREDENTIAL_REQUEST])
        result = self.message({"html": b"<b>example</b>"}, scan=("dangerous", view.MALWARE))
        self.assertEqual(result["security"]["status"], "dangerous")
        self.assertIsNone(result["html"])

    def test_read_for_ai_keeps_plaintext_with_no_content_scan(self):
        result = self.message({"plain": b"body"}, rich=False)
        self.assertEqual(result["text"], "body")
        self.assertNotIn("security", result)
        self.assertNotIn("html", result)

    def test_malformed_html_alternative_preserves_original_plaintext(self):
        client = Mock()
        row = {b"UID": 7, b"BODYSTRUCTURE": (), b"FLAGS": (), b"RFC822.SIZE": 210}
        parts = [body_part("plain", b"text"), body_part("html", b"invalid")]
        with patch.object(mailstore, "lookup", return_value=(4, 7, row)), \
                patch.object(mailstore, "section_tree", return_value=parts), \
                patch.object(mailstore, "read_part", side_effect=[b"text", mailstore.MailError("invalid", 422)]), \
                patch.object(view, "antivirus", return_value=("clean", None)):
            result = mailstore.read_message(client, "INBOX", "4.7", mark_seen=False, inspect_content=True)
        self.assertEqual(result["text"], "text")
        self.assertIsNone(result["html"])
        self.assertEqual(result["security"], {"status": "unknown", "reasons": [view.BODY_INCOMPLETE]})


class LocalScanner(unittest.TestCase):
    def setUp(self):
        p = patch.dict(os.environ, {"WEBMAIL_CLAMD_HOST": "127.0.0.1", "WEBMAIL_CLAMD_PORT": "13310"})
        p.start()
        self.addCleanup(p.stop)

    def run_scanner(self, raw, reply, *, reported=None, times=None):
        conn, client = MagicMock(), Mock()
        sock = conn.__enter__.return_value
        sock.recv.side_effect = [reply[:5], reply[5:]]
        client.fetch.return_value = {7: {b"BODY[]<0>": raw}}
        size = len(raw) if reported is None else reported
        with patch.object(view.socket, "create_connection", return_value=conn) as connect, \
                patch.object(view.time, "monotonic", side_effect=times, return_value=1):
            result = view.antivirus(client, 7, size)
        return result, client, connect, sock

    def test_transmits_original_including_attachment_to_loopback_only(self):
        raw = (b"Content-Type: multipart/mixed; boundary=sample\r\n\r\n--sample\r\n\r\nHi\r\n"
               b"--sample\r\nContent-Disposition: attachment\r\n\r\n" + b"demo" * 17600 + b"\r\n--sample--\r\n")
        result, client, connect, sock = self.run_scanner(raw, b"stream: OK\0")
        self.assertEqual(result, ("clean", None))
        client.fetch.assert_called_once_with([7], [f"BODY.PEEK[]<0.{len(raw)}>"])
        connect.assert_called_once_with(("127.0.0.1", 13310), timeout=1)
        packets = [item.args[0] for item in sock.sendall.call_args_list]
        self.assertEqual((packets[0], packets[-1]), (b"zINSTREAM\0", bytes(4)))
        self.assertEqual(b"".join(p[4:] for p in packets[1:-1]), raw)
        for packet in packets[1:-1]:
            self.assertEqual(struct.unpack("!I", packet[:4])[0], len(packet) - 4)
        self.assertEqual(self.run_scanner(raw, b"stream: test-signature FOUND\0")[0][0], "dangerous")
        self.assertEqual(self.run_scanner(raw, b"stream: Heuristics.Phishing.Email FOUND\0")[0][0], "suspicious")

    def test_not_scanned_or_incomplete_can_never_be_clean(self):
        raw = b"hello"
        for reply in (b"error\0", b"X-Scan: OK\0", b"stream: Heuristics.Encrypted.Zip FOUND\0",
                      b"stream: Heuristics.Limits.Exceeded FOUND\0"):
            self.assertEqual(self.run_scanner(raw, reply)[0][0], "unknown")
        result, client, connect, sock = self.run_scanner(raw, b"stream: OK\0", reported=view.MAX_SCAN + 1)
        self.assertEqual(result[0], "unknown")
        client.fetch.assert_not_called()
        connect.assert_not_called()
        result, _, _, sock = self.run_scanner(raw, b"stream: OK\0", reported=18)
        self.assertEqual(result[0], "unknown")
        sock.sendall.assert_not_called()
        result = self.run_scanner(raw, b"stream: OK\0", times=[1, 2, 3, 4, 9])[0]
        self.assertEqual(result[0], "unknown")

    def test_busy_disabled_and_external_scanner_never_receive_message(self):
        with patch.object(view, "SCAN_SLOTS") as slots:
            slots.acquire.return_value = False
            result, client, connect, _ = self.run_scanner(b"hi", b"stream: OK\0")
            self.assertEqual(result[0], "unknown")
            client.fetch.assert_not_called()
            connect.assert_not_called()
        for host in ("", "public.test", "192.0.2.1"):
            with patch.dict(os.environ, {"WEBMAIL_CLAMD_HOST": host}):
                result, client, connect, _ = self.run_scanner(b"hi", b"stream: OK\0")
                self.assertEqual(result[0], "unknown")
                client.fetch.assert_not_called()
                connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
