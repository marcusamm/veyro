"""Run real inference on generated TESTDATA PNG + scanned PDF, locally or HTTP."""

import argparse
import hashlib
import json
import re
import time
import urllib.request

from fixtures import receipt_bytes
from fastapi.testclient import TestClient
from service import app


def smoke(url: str | None = None) -> dict:
    cases = []
    for mime, format in [("image/png", "PNG"), ("application/pdf", "PDF")]:
        raw = receipt_bytes(format)
        before = hashlib.sha256(raw).hexdigest()
        started = time.monotonic()
        if url:
            request = urllib.request.Request(url.rstrip("/") + "/v1/extract", data=raw, headers={"Content-Type": mime})
            with urllib.request.urlopen(request, timeout=120) as response:
                result = json.load(response)
        else:
            with TestClient(app) as client:
                if client.get("/health").status_code != 200:
                    raise AssertionError("Baked model integrity health check failed")
                response = client.post("/v1/extract", content=raw, headers={"Content-Type": mime})
                if response.status_code != 200:
                    raise AssertionError(f"Real OCR HTTP contract failed: {response.status_code}")
                result = response.json()
        text = "\n".join(result["pages"])
        # This is a synthetic regression, not an accuracy score on real receipts.
        for token in ["TESTDATA", "Skruer", "Fugemasse", "250,00", "120,00", "462,50"]:
            if token.casefold() not in text.casefold():
                raise AssertionError(f"TESTDATA expected OCR token missing: {token}")
        if "  " not in text:
            raise AssertionError("No reconstructed column spacing")
        header = next((line for line in text.splitlines() if "Antal" in line), "")
        if re.split(r"\s{2,}", header) != ["Vare", "Antal", "Enhed", "Pris", "Beløb"]:
            raise AssertionError("TESTDATA receipt headings do not have five separate columns")
        for name in ["Skruer", "Fugemasse"]:
            row = next((line for line in text.splitlines() if line.startswith(name)), "")
            if len(re.split(r"\s{2,}", row)) != 5:
                raise AssertionError("TESTDATA material columns are not aligned")
        if before != hashlib.sha256(raw).hexdigest():
            raise AssertionError("Original bytes changed")
        cases.append({"mime": mime, "seconds": round(time.monotonic() - started, 2), "sha256": before, "pages": result["pages"], "provider": result["provider"]})
    return {"fixture": "Synthetic TESTDATA only; no real purchase or personal data", "cases": cases}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url")
    args = parser.parse_args()
    print(json.dumps(smoke(args.url), ensure_ascii=False, indent=2))

