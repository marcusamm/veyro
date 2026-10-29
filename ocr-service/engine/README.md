# Veyro OCR engine

Private CPU-only PaddleOCR service. The Veyro Worker is the entry point; this
container does not need a public hostname or any production database access.
OCR proposes text only. It cannot approve a receipt or register stock/costs.

## Run and verify

Build with this directory as context:

```sh
docker build -t veyro-ocr-engine .
docker run --rm --network none --cpus 1 --memory 6g --read-only \
  --tmpfs /tmp:size=256m veyro-ocr-engine python /app/smoke.py
```

The real smoke performs PaddleOCR on a generated, clearly marked TESTDATA PNG
and a scanned/raster-only PDF. It asserts Danish text, amounts, five table
columns and unchanged original bytes. This is a regression fixture, not a
real-world receipt accuracy score. `smoke.py --url http://127.0.0.1:8080` can
exercise a running HTTP service instead.

Unit tests require the same Python dependencies and run from this directory:

```sh
python -m unittest discover -s tests -v
```

## Contract and bounds

- `GET /health`: checksum-verifies baked model files once; no inference or
  internet request. Returns 503 if model integrity is unavailable.
- `POST /v1/extract`: raw bytes, controlled `Content-Type` PDF/JPEG/PNG/HEIC.
  Returns `{ "pages": ["text including column spacing"], "provider": "..." }`.
- Maximum 15 MB, 10 PDF pages, one image frame, 24 MP source image, 12 MP rendered
  page, 4000-pixel longest output edge, 100,000 text characters, 500 KB response.
- One active request per container; excess requests receive 429 with retry hint.
  Native OCR and PDF decoding run in a disposable child process: one CPU thread,
  75-second wall-clock limit, Linux CPU/virtual-memory/core-dump limits. Use a
  platform memory limit of 6 GiB and one Uvicorn worker as in the Docker command.
- Original bytes travel through memory/stdin; no original or OCR result is
  written to disk or logged. PDF renders, EXIF rotation and image downscaling
  affect decoded copies only. PDFs are always rendered here; Veyro already
  handles readable text PDFs before invoking OCR.
- Model names and model archive SHA-256 are pinned in `models.json`; exact
  installed dependency versions are in `requirements.lock`. Build downloads
  from the official model links, rejects changed archives, creates an individual
  file checksum manifest, and makes model files read-only. Runtime uses explicit
  local model paths. Disable container outbound internet in the Worker as well.

`layout.py` tightens detection boxes using word geometry, groups boxes into rows,
and separates visual columns with two spaces for Veyro's existing receipt reader.
It does not invent missing values. Receipts without recognizable headings or
with complex layouts can still need manual correction. Whole-page rotation
without EXIF and curved-page dewarping are not enabled in this lightweight model.

## Sources and licenses

PaddleOCR 3.7.0 / PP-OCRv6 small was selected for local CPU inference and Danish
support. PaddleOCR's project license is Apache-2.0; retain applicable notices in
distributions. PDF rasterization uses pypdfium2; HEIC decoding uses pillow-heif.
The engine calls no hosted OCR API.

- [Official PaddleOCR usage, language list and model links](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/OCR.html)
- [PaddleOCR source and license](https://github.com/PaddlePaddle/PaddleOCR)
- [PaddleOCR installation](https://www.paddleocr.ai/latest/en/version3.x/installation.html)
- [pypdfium2 documentation](https://pypdfium2.readthedocs.io/)
- [pillow-heif documentation](https://pillow-heif.readthedocs.io/)

Local verification on 29 October 2026: actual CPU inference on synthetic PNG and
scanned PDF, with table columns and expected amounts preserved. Docker/Linux
verification is separate and must pass in CI before release.

