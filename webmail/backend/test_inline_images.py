import base64
import io
import re
import unittest
from unittest.mock import MagicMock, Mock, patch

from imapclient.response_types import BodyData
from PIL import Image
import mailstore as mail


# Four small raster images generated from a synthetic white 2×2 square.
SAMPLES = {
    "image/png": "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR42mP8//8/AwMDEwMDAwMDAwAkBgMB/umWrAAAAABJRU5ErkJggg==",
    "image/gif": "R0lGODdhAgACAIEAAP///wAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7",
    "image/jpeg": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z",
    "image/webp": "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAIAAUAmJaQAA3AA/vz0AAA=",
}
PNG = base64.b64decode(SAMPLES["image/png"])


def leaf(mime, wire, cid=None, encoding=b"8BIT", disposition=None):
    kind, sub = mime.encode().upper().split(b"/")
    fields = (kind, sub, None, cid, None, encoding, len(wire))
    if kind == b"TEXT":
        fields += (1,)
    return fields + (None, disposition)


def multipart(kind, *children, start=None, disposition=None):
    return children + (kind, (b"START", start) if start else None, disposition)


def fixture(tree, wires):
    row = {b"UID": 5, b"UIDVALIDITY": 9, b"BODYSTRUCTURE": BodyData.create(tree),
           b"RFC822.SIZE": 512, b"FLAGS": (), b"INTERNALDATE": None}
    client = Mock()
    client.select_folder.return_value = {b"UIDVALIDITY": 9}
    def fetch(uids, fields):
        if "BODYSTRUCTURE" in fields:
            return {5: row}
        if ".MIME]" in fields[0]:
            response = {}
            for field in fields:
                match = re.fullmatch(r"BODY\.PEEK\[([\d.]+\.MIME)\]<0\.(\d+)>", field)
                section, size = match.groups()
                if section in wires:
                    response[f"BODY[{section}]<0>".encode()] = wires[section][:int(size)]
            return {5: response}
        match = re.fullmatch(r"BODY\.PEEK\[([\d.]+)\]<0\.(\d+)>", fields[0])
        if not match:
            raise AssertionError(fields)
        section, size = match.groups()
        return {5: {f"BODY[{section}]<0>".encode(): wires[section][:int(size)]}}
    client.fetch.side_effect = fetch
    return client


class InlineImages(unittest.TestCase):
    def read(self, client, *, human=True, verdict="clean"):
        with patch.object(mail.message_view, "antivirus", return_value=(verdict, None)):
            return mail.read_message(client, "INBOX", "9.5", mark_seen=False, inspect_content=human)

    def test_related_root_and_alternative_use_correct_sections_and_byte_verified_images(self):
        html = (b'<p>Ordre</p><img src="cid:Logo@Shop"><img src="cid:Logo@Shop">'
                b'<img src="https://shop.example.test/banner"><img src="cid:no-match">')
        wires = {"1.1": SAMPLES["image/png"].encode(), "1.2": html, "1.3": b"unused", "2": b"note"}
        tree = multipart(b"MIXED", multipart(b"RELATED",
            leaf("image/png", wires["1.1"], cid=b"<LOGO@SHOP>", encoding=b"BASE64"),
            leaf("text/html", html, cid=b"<root>"), leaf("image/png", b"unused", cid=b"<unused>"),
            start=b"<root>"), leaf("text/plain", b"note", disposition=(b"ATTACHMENT", (b"FILENAME", b"note.txt"))))
        client = fixture(tree, wires)
        result = self.read(client)
        self.assertEqual(result["inlineImages"], [dict(id="1.1", mime="image/png", size=len(PNG))])
        self.assertIn('src="data:image/png;base64,' + SAMPLES["image/png"] + '"', result["html"])
        self.assertEqual(result["html"].count("data:image/png;base64,"), 1)
        self.assertTrue(result["has_external_images"])
        self.assertEqual([call.args[1][0] for call in client.fetch.call_args_list if "BODYSTRUCTURE" not in call.args[1]],
                         [f"BODY.PEEK[1.2]<0.{mail.message_view.BODY_LIMIT}>", f"BODY.PEEK[1.1]<0.{len(wires['1.1'])}>"])
        # The same UID and numeric section still download as an ordinary authenticated attachment.
        self.assertEqual(mail.attachment(client, "INBOX", "9.5", "1.1")[0], PNG)
        with self.assertRaises(mail.MailError):
            mail.attachment(client, "INBOX", "8.5", "1.1")

    def test_scopes_duplicate_ids_and_attached_messages(self):
        html = b'<p>Latest</p><img src="cid:same"><img src="cid:ambig"><img src="cid:attached">'
        old = multipart(b"RELATED", leaf("text/html", b"Old"), leaf("image/png", PNG, b"<same>"))
        chosen = multipart(b"RELATED", leaf("text/html", html), leaf("image/png", PNG, b"<same>"),
                           leaf("image/png", PNG, b"<ambig>"), leaf("image/gif", PNG, b"<AMBIG>"),
                           leaf("image/png", PNG, b"<attached>", disposition=(b"ATTACHMENT", None)))
        envelope = (None,) * 10
        # BODYSTRUCTURE carries an entire nested email here. Do not use that email's HTML or CID.
        original = (b"MESSAGE", b"RFC822", None, None, None, b"7BIT", 512, envelope, old, 15, None,
                    (b"ATTACHMENT", (b"FILENAME", b"original.eml")))
        tree = multipart(b"MIXED", original, multipart(b"ALTERNATIVE", old, chosen))
        client = fixture(tree, {"2.2.1": html, "2.2.2": PNG})
        result = self.read(client)
        self.assertEqual(result["inlineImages"], [dict(id="2.2.2", mime="image/png", size=len(PNG))])
        self.assertIn("Latest", result["text"])
        self.assertFalse(result["has_external_images"])
        self.assertTrue(any(f["name"] == "original.eml" for f in result["attachments"]))

    def test_related_around_alternative_and_attached_multipart(self):
        html = b'<img src="cid:photo">'
        attachment = multipart(b"RELATED", leaf("text/html", b"Ignored"), leaf("image/png", PNG, b"<photo>"),
                               disposition=(b"ATTACHMENT", None))
        alternative = multipart(b"ALTERNATIVE", leaf("text/plain", b"plain"), leaf("text/html", html))
        tree = multipart(b"MIXED", attachment, multipart(b"RELATED", alternative, leaf("image/png", PNG, b"<photo>")))
        result = self.read(fixture(tree, {"2.1.1": b"plain", "2.1.2": html, "2.2": PNG}))
        self.assertEqual(result["text"], "plain")
        self.assertEqual([i["id"] for i in result["inlineImages"]], ["2.2"])

    def test_related_start_matches_multipart_by_header_and_unique_body_fallback(self):
        body = multipart(b"ALTERNATIVE", leaf("text/plain", b"tekst"), leaf("text/html", b'<img src="cid:art">'))
        other = multipart(b"ALTERNATIVE", leaf("text/html", b"other"))
        tree = multipart(b"RELATED", leaf("image/png", PNG, b"<art>"), other, body, start=b"<body@sample>")
        wires = {"1": PNG, "2.MIME": b"Content-ID: <other>\r\n\r\n",
                 "3.MIME": b"Content-ID: <body@sample>\r\n\r\n", "3.1": b"tekst", "3.2": b'<img src="cid:art">'}
        client = fixture(tree, wires)
        result = self.read(client)
        self.assertEqual(result["text"], "tekst")
        self.assertEqual([i["id"] for i in result["inlineImages"]], ["1"])
        batches = [c.args[1] for c in client.fetch.call_args_list if ".MIME]" in c.args[1][0]]
        self.assertEqual(batches, [[f"BODY.PEEK[{p}.MIME]<0.{mail.MIME_HEADER_BYTES}>" for p in ("2", "3")]])
        # Old mail occasionally omits the container's ID. A unique body next to an image is unambiguous.
        fallback_tree = multipart(b"RELATED", leaf("image/png", PNG, b"<art>"), body, start=b"<missing>")
        fallback = self.read(fixture(fallback_tree, {"1": PNG, "2.MIME": b"Content-Type: multipart/alternative\r\n\r\n",
                                                    "2.1": b"tekst", "2.2": b'<img src="cid:art">'}))
        self.assertEqual(fallback["text"], "tekst")
        self.assertEqual(len(fallback["inlineImages"]), 1)
        denied = self.read(fixture(tree, {}))  # No trustworthy way to pick between two root candidates.
        self.assertIsNone(denied["html"])
        self.assertEqual(denied["inlineImages"], [])
        self.assertEqual(denied["security"]["status"], "unknown")

    def test_shared_mime_depth_width_total_nodes_and_header_reads(self):
        text = leaf("text/plain", b"body")
        deep = text
        for _ in range(40):
            deep = multipart(b"MIXED", deep)
        wide = multipart(b"MIXED", *([text] * 270))
        many_roots = multipart(b"MIXED", *([multipart(b"MIXED", *([text] * 13))] * 23))
        for tree in (deep, wide, many_roots):
            parsed = BodyData.create(tree)
            walk = mail.MimeWalk()
            limited = mail.section_tree(parsed, walk=walk)
            self.assertTrue(walk.incomplete)
            self.assertLessEqual(walk.nodes, mail.MIME_NODES)
            row = {b"UID": 1, b"BODYSTRUCTURE": parsed}
            self.assertFalse(mail.message_summary(row, 1)["hasAttachments"])
            client = fixture(tree, {p["id"]: b"body" for p in limited})
            result = self.read(client)
            self.assertEqual(result["security"]["status"], "unknown")
            self.assertEqual(result["inlineImages"], [])
        group = multipart(b"RELATED", *([multipart(b"ALTERNATIVE", text)] * 7), start=b"<root>")
        client = fixture(multipart(b"MIXED", group, group), {})
        self.read(client)
        header_reads = sum(len(c.args[1]) for c in client.fetch.call_args_list if ".MIME]" in c.args[1][0])
        self.assertEqual(header_reads, mail.MIME_HEADER_READS)

    def test_only_a_human_safe_reader_hydrates_and_encoded_length_must_match(self):
        html = b'<img src="cid:pic"><img src="https://shop.example.test/a">'
        tree = multipart(b"RELATED", leaf("text/html", html), leaf("image/png", PNG, b"<pic>"))
        # These fixtures have no available bytes at section 2; an image fetch would fail the test.
        result = self.read(fixture(tree, {"1": html}), verdict="dangerous")
        self.assertIsNone(result["html"])
        self.assertEqual(result["inlineImages"], [])
        self.assertFalse(result["has_external_images"])
        self.assertNotIn("inlineImages", self.read(fixture(tree, {"1": html}), human=False))
        incomplete = self.read(fixture(tree, {"1": html, "2": PNG[:-4]}))
        self.assertNotIn("data:image", incomplete["html"])
        self.assertEqual(incomplete["inlineImages"], [])

    def test_mislabeled_artwork_remains_downloadable_only(self):
        html = b'<img src="cid:pic">'
        for data in [b"<svg></svg>", b"<html>Example</html>", base64.b64decode(SAMPLES["image/gif"])]:
            tree = multipart(b"RELATED", leaf("text/html", html), leaf("image/png", data, b"<pic>"))
            client = fixture(tree, {"1": html, "2": data})
            result = self.read(client)
            self.assertEqual(result["inlineImages"], [])
            self.assertNotIn("data:image", result["html"])
            self.assertEqual(mail.attachment(client, "INBOX", "9.5", "2")[0], data)

    def test_failed_later_frame_debits_budget_and_busy_decoder_skips_entire_message(self):
        file = MagicMock()
        image = file.__enter__.return_value
        image.size = (2, 2)
        image.seek.side_effect = [None, None]
        image.load.side_effect = [None, OSError("incomplete second frame")]
        budget = mail.PixelBudget(9)
        with patch.object(mail.Image, "open", return_value=file):
            self.assertEqual(mail.raster_pixels(PNG, "image/png", budget), 0)
        self.assertEqual(budget.remaining, 1)
        self.assertFalse(mail.raster_pixels(PNG, "image/png", budget))
        with patch.object(mail, "IMAGE_DECODERS") as decoders, patch.object(mail, "read_part") as read:
            decoders.acquire.return_value = False
            self.assertEqual(mail.inline_content(None, 5, [], set(), [str(i) for i in range(16)]), ({}, []))
            decoders.acquire.assert_called_once_with(blocking=False)
            decoders.release.assert_not_called()
            read.assert_not_called()

    def test_raster_container_dimensions_size_count_and_total_limits(self):
        for mime, encoded in SAMPLES.items():
            with self.subTest(mime=mime):
                blob = base64.b64decode(encoded)
                self.assertEqual(mail.raster_pixels(blob, mime, mail.PixelBudget(4)), 4)
                self.assertFalse(mail.raster_pixels(blob[:len(blob)//2], mime, mail.PixelBudget(4)))
                self.assertFalse(mail.raster_pixels(b"ordinary text", mime, mail.PixelBudget(4)))
                self.assertFalse(mail.raster_pixels(blob, mime, mail.PixelBudget(3)))
        frames = [Image.new("RGB", (3, 2), color) for color in ("white", "blue")]
        for format_name in ("GIF", "WEBP"):
            file = io.BytesIO()
            frames[0].save(file, format_name, save_all=True, append_images=frames[1:], duration=100, loop=0)
            self.assertEqual(mail.raster_pixels(file.getvalue(), "image/" + format_name.lower(), mail.PixelBudget(12)), 12)
            self.assertFalse(mail.raster_pixels(file.getvalue(), "image/" + format_name.lower(), mail.PixelBudget(11)))
        parts = [dict(id=str(i), mime="image/png", size=len(PNG), encoding="8bit") for i in range(1, 22)]
        ids = [p["id"] for p in parts]
        with patch.object(mail, "read_part", return_value=PNG) as read:
            sources, results = mail.inline_content(None, 5, parts, set(ids), ids)
            self.assertEqual(len(results), mail.INLINE_COUNT)
            self.assertEqual(read.call_count, mail.INLINE_COUNT)
            self.assertEqual(list(sources), ids[:mail.INLINE_COUNT])
            with patch.object(mail, "INLINE_TOTAL", len(PNG)):
                self.assertEqual(len(mail.inline_content(None, 5, parts, set(ids), ids)[1]), 1)
            with patch.object(mail, "INLINE_WIRE_TOTAL", len(PNG)-1):
                self.assertFalse(mail.inline_content(None, 5, parts, set(ids), ids)[1])
            with patch.object(mail, "INLINE_PIXELS", 5):
                self.assertEqual(len(mail.inline_content(None, 5, parts, set(ids), ids)[1]), 1)


if __name__ == "__main__":
    unittest.main()
