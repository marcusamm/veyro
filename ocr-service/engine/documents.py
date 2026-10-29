"""Decode originals in memory; render temporary copies one page at a time."""

import io
import math
import warnings
from collections.abc import Iterator

import pypdfium2 as pdfium
from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener

from limits import InvalidDocument, MAX_FILE_BYTES, MAX_IMAGE_PIXELS, MAX_PAGES, MAX_RENDER_PIXELS, MAX_SIDE, MIME_TYPES

register_heif_opener()
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


def pages(data: bytes, mime: str) -> Iterator[Image.Image]:
    if mime not in MIME_TYPES or not data or len(data) > MAX_FILE_BYTES:
        raise InvalidDocument("Unsupported document")
    if mime == "application/pdf":
        if not data.startswith(b"%PDF-"):
            raise InvalidDocument("Not a PDF")
        try:
            document = pdfium.PdfDocument(data)
            try:
                if not 0 < len(document) <= MAX_PAGES:
                    raise InvalidDocument("PDF page limit exceeded")
                for index in range(len(document)):
                    page = document[index]
                    try:
                        width, height = page.get_size()
                        if not all(math.isfinite(x) and x > 0 for x in (width, height)):
                            raise InvalidDocument("Invalid PDF page size")
                        scale = min(200 / 72, MAX_SIDE / max(width, height), math.sqrt(MAX_RENDER_PIXELS / (width * height)))
                        bitmap = page.render(scale=scale)
                        try:
                            image = bitmap.to_pil().convert("RGB")
                            try:
                                yield image
                            finally:
                                image.close()
                        finally:
                            bitmap.close()
                    finally:
                        page.close()
            finally:
                document.close()
        except InvalidDocument:
            raise
        except Exception:
            raise InvalidDocument("Unreadable PDF") from None
        return
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as original:
                if original.format != MIME_TYPES[mime] or getattr(original, "n_frames", 1) != 1:
                    raise InvalidDocument("Image type mismatch or multiple frames")
                if original.width * original.height > MAX_IMAGE_PIXELS:
                    raise InvalidDocument("Image pixel limit exceeded")
                # EXIF and resizing apply only to an in-memory decoded copy.
                image = ImageOps.exif_transpose(original).convert("RGB")
                try:
                    image.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
                    yield image
                finally:
                    image.close()
    except InvalidDocument:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise InvalidDocument("Unreadable image") from None

