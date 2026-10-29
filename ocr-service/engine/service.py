"""Private raw-byte HTTP API used only through Veyro's service binding."""

import asyncio
import json
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from limits import JOB_TIMEOUT_SECONDS, MAX_FILE_BYTES, MAX_PAGES, MAX_RESPONSE_BYTES, MAX_TEXT_CHARS, MIME_TYPES

ROOT = Path(__file__).resolve().parent
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_busy = False


def run_child(data: bytes, mime: str) -> dict:
    try:
        completed = subprocess.run(
            [sys.executable, "-m", "receipt_worker", mime], input=data,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=ROOT, timeout=JOB_TIMEOUT_SECONDS, check=False,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "OCR processing timed out") from None
    if completed.returncode == 2:
        raise HTTPException(422, "Document could not be read")
    if completed.returncode != 0 or len(completed.stdout) > MAX_RESPONSE_BYTES:
        raise HTTPException(503, "OCR processing unavailable")
    try:
        result = json.loads(completed.stdout)
        pages = result["pages"]
        if not isinstance(pages, list) or not 0 < len(pages) <= MAX_PAGES or not all(isinstance(p, str) for p in pages):
            raise ValueError("pages")
        if not any(pages) or sum(len(p) for p in pages) > MAX_TEXT_CHARS or not isinstance(result["provider"], str):
            raise ValueError("text")
    except (KeyError, ValueError, TypeError):
        raise HTTPException(503, "Invalid OCR result") from None
    return {"pages": pages, "provider": result["provider"][:80]}


@app.get("/health")
async def health():
    from model_assets import verify_models
    try:
        verify_models()
    except (OSError, ValueError):
        return JSONResponse({"ready": False}, status_code=503)
    return {"ready": True, "engine": "PaddleOCR", "version": "3.7.0"}


@app.post("/v1/extract")
async def extract(request: Request):
    global _busy
    mime = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if mime not in MIME_TYPES:
        raise HTTPException(415, "Unsupported content type")
    length = request.headers.get("content-length")
    if length is not None and (not length.isascii() or not length.isdecimal() or len(length) > 10 or int(length) > MAX_FILE_BYTES):
        raise HTTPException(413, "Document exceeds size limit")
    # No await between checking and claiming this process-local lease. Uvicorn
    # must run exactly one worker. Reject excess work instead of growing a queue.
    if _busy:
        return JSONResponse({"detail": "OCR is busy; retry later"}, status_code=429, headers={"Retry-After": "5"})
    _busy = True
    work = None
    try:
        body = bytearray()
        try:
            async with asyncio.timeout(10):
                async for chunk in request.stream():
                    if len(body) + len(chunk) > MAX_FILE_BYTES:
                        raise HTTPException(413, "Document exceeds size limit")
                    body.extend(chunk)
        except TimeoutError:
            raise HTTPException(408, "Document upload timed out") from None
        if not body:
            raise HTTPException(422, "Empty document")
        work = asyncio.create_task(asyncio.to_thread(run_child, bytes(body), mime))
        # A caller disconnect must not release the lease while native OCR runs.
        return await asyncio.shield(work)
    finally:
        if work is None or work.done():
            _busy = False
        else:
            def release(future):
                global _busy
                _busy = False
                # Retrieve an error even if its disconnected caller has gone.
                if not future.cancelled():
                    future.exception()
            work.add_done_callback(release)

