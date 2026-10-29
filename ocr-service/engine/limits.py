"""Shared limits. Requests are suggestions only, never stock/accounting writes."""

MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_PAGES = 10
MAX_TEXT_CHARS = 100_000
MAX_RESPONSE_BYTES = 500_000
MAX_IMAGE_PIXELS = 24_000_000
MAX_RENDER_PIXELS = 12_000_000
MAX_SIDE = 4000
JOB_TIMEOUT_SECONDS = 75
MIME_TYPES = {
    "application/pdf": "PDF",
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/heic": "HEIF",
}


class InvalidDocument(ValueError):
    """An input cannot safely be processed. Its content must not enter logs."""

