import asyncio
import hashlib
import io
import subprocess
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from documents import pages
from fixtures import receipt_bytes
from layout import TextBox, reconstruct_rows, text_boxes
from limits import InvalidDocument, MAX_FILE_BYTES
from service import app, run_child


class LayoutTests(unittest.TestCase):
    def test_reading_order_and_column_gaps(self):
        boxes = [
            TextBox("250,00", 1200, 101, 1300, 125),
            TextBox("Skruer", 50, 100, 150, 124),
            TextBox("5x80", 157, 100, 220, 124),
            TextBox("Vare", 50, 50, 130, 74),
            TextBox("Beløb", 1200, 52, 1300, 76),
        ]
        self.assertEqual(reconstruct_rows(boxes), "Vare  Beløb\nSkruer 5x80  250,00")

    def test_tall_box_does_not_merge_distinct_rows(self):
        boxes = [TextBox("A", 0, 0, 20, 20), TextBox("B", 100, 20, 120, 40)]
        self.assertEqual(reconstruct_rows(boxes), "A\nB")

    def test_result_validation_and_control_codes(self):
        result = {"rec_texts": [" A\x00  B "], "rec_polys": [[[0, 0], [20, 0], [20, 20], [0, 20]]]}
        self.assertEqual(text_boxes(result)[0].text, "A B")
        for bad in [
            {"rec_texts": ["A"], "rec_polys": []},
            {"rec_texts": ["A"], "rec_polys": [[[0, 0], [float("nan"), 0], [20, 20], [0, 20]]]},
        ]:
            with self.assertRaises(InvalidDocument):
                text_boxes(bad)

    def test_word_bounds_prevent_padded_header_cells_merging(self):
        result = {
            "rec_texts": ["Enhed", "Pris"],
            "rec_polys": [[[810, 100], [960, 100], [960, 140], [810, 140]], [[965, 100], [1050, 100], [1050, 140], [965, 140]]],
            "text_word": [["Enhed"], ["Pris"]],
            "text_word_region": [[[[830, 105], [910, 105], [910, 135], [830, 135]]], [[[980, 105], [1030, 105], [1030, 135], [980, 135]]]],
        }
        self.assertEqual(reconstruct_rows(text_boxes(result)), "Enhed  Pris")


class DocumentTests(unittest.TestCase):
    def test_png_and_scanned_pdf_preserve_original(self):
        for mime, format in [("image/png", "PNG"), ("application/pdf", "PDF")]:
            raw = receipt_bytes(format)
            before = hashlib.sha256(raw).hexdigest()
            count = 0
            for image in pages(raw, mime):
                self.assertEqual(image.mode, "RGB")
                self.assertLessEqual(max(image.size), 4000)
                count += 1
            self.assertEqual(count, 1)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), before)

    def test_invalid_and_mismatched_inputs(self):
        for raw, mime in [(b"", "image/png"), (b"not a PDF", "application/pdf"), (receipt_bytes(), "image/jpeg"), (b"a", "text/plain")]:
            with self.assertRaises(InvalidDocument):
                list(pages(raw, mime))

    def test_reject_multiple_image_frames(self):
        image = Image.new("RGB", (30, 30), "white")
        buf = io.BytesIO()
        image.save(buf, format="PNG", save_all=True, append_images=[Image.new("RGB", (30, 30), "black")])
        with self.assertRaises(InvalidDocument):
            list(pages(buf.getvalue(), "image/png"))

    def test_reject_too_many_pdf_pages(self):
        image = Image.new("RGB", (20, 20), "white")
        buf = io.BytesIO()
        image.save(buf, format="PDF", save_all=True, append_images=[image] * 10)
        with self.assertRaises(InvalidDocument):
            list(pages(buf.getvalue(), "application/pdf"))

    def test_heic_original_is_decoded_without_changes(self):
        raw = receipt_bytes("HEIF")
        before = hashlib.sha256(raw).hexdigest()
        self.assertEqual(sum(1 for _ in pages(raw, "image/heic")), 1)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), before)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_http_contract_and_no_persistence(self):
        data = receipt_bytes()
        with patch("service.run_child", return_value={"pages": ["TESTDATA  25,00"], "provider": "TESTDATA mock"}) as child:
            result = self.client.post("/v1/extract", content=data, headers={"Content-Type": "image/png"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["provider"], "TESTDATA mock")
        child.assert_called_once_with(data, "image/png")

    def test_http_size_empty_type_limits(self):
        for mime, body, status in [("text/plain", b"hello", 415), ("image/png", b"", 422), ("image/png", b"a" * (MAX_FILE_BYTES + 1), 413)]:
            self.assertEqual(self.client.post("/v1/extract", content=body, headers={"Content-Type": mime}).status_code, status)

    def test_concurrency_has_bounded_queue(self):
        with patch("service._busy", True):
            result = self.client.post("/v1/extract", content=b"x", headers={"Content-Type": "image/png"})
        self.assertEqual(result.status_code, 429)
        self.assertEqual(result.headers["Retry-After"], "5")

    def test_child_error_timeout_and_invalid_response(self):
        from fastapi import HTTPException
        for returned, status in [
            (subprocess.CompletedProcess([], 2, b""), 422),
            (subprocess.CompletedProcess([], 1, b"private content"), 503),
            (subprocess.CompletedProcess([], 0, b'{"pages":[42]}'), 503),
        ]:
            with patch("service.subprocess.run", return_value=returned):
                with self.assertRaises(HTTPException) as raised:
                    run_child(b"x", "image/png")
            self.assertEqual(raised.exception.status_code, status)
        with patch("service.subprocess.run", side_effect=subprocess.TimeoutExpired("test", 1)):
            with self.assertRaises(HTTPException) as raised:
                run_child(b"x", "image/png")
        self.assertEqual(raised.exception.status_code, 504)

    def test_lease_released_after_error(self):
        from fastapi import HTTPException
        with patch("service.run_child", side_effect=HTTPException(422, "TESTDATA invalid")):
            response = self.client.post("/v1/extract", content=b"x", headers={"Content-Type": "image/png"})
        self.assertEqual(response.status_code, 422)
        with patch("service.run_child", return_value={"pages": ["TESTDATA"], "provider": "TESTDATA mock"}):
            response = self.client.post("/v1/extract", content=b"x", headers={"Content-Type": "image/png"})
        self.assertEqual(response.status_code, 200)


class ModelAssetTests(unittest.TestCase):
    def test_archive_checksum_and_runtime_integrity(self):
        import model_assets
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "TESTDATA-model_infer.tar"
            with tarfile.open(archive_path, "w") as archive:
                for name in model_assets.MODEL_FILES:
                    data = b"TESTDATA model fixture"
                    member = tarfile.TarInfo("TESTDATA-model_infer/" + name)
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            manifest = root / "models.json"
            data = {"models": [{"name": "TESTDATA-model", "sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest()}]}
            manifest.write_text(json.dumps(data))
            with patch.object(model_assets, "MANIFEST", manifest):
                model_assets.bake_models(root / "models", root)
                with patch.dict(os.environ, {"OCR_MODELS_DIR": str(root / "models")}):
                    model_assets.verify_models.cache_clear()
                    model_assets.verify_models()
                    (root / "models/TESTDATA-model/inference.yml").write_bytes(b"TESTDATA changed model")
                    model_assets.verify_models.cache_clear()
                    with self.assertRaises(ValueError):
                        model_assets.verify_models()
                data["models"][0]["sha256"] = "0" * 64
                manifest.write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    model_assets.bake_models(root / "bad-models", root)
            model_assets.verify_models.cache_clear()


if __name__ == "__main__":
    unittest.main()

