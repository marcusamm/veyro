"""Validate build-time model bytes; runtime has no model download path."""

import hashlib
import io
import json
import os
import tarfile
import urllib.request
from functools import lru_cache
from pathlib import Path

MANIFEST = Path(__file__).with_name("models.json")
MODEL_FILES = {"inference.json", "inference.yml", "inference.pdiparams"}


def bake_models(destination: Path, local_archives: Path | None = None) -> None:
    """Build-only downloader. URLs and checksums are fixed in the source tree."""
    destination.mkdir(parents=True, exist_ok=True)
    hashes = {}
    for model in json.loads(MANIFEST.read_text())["models"]:
        if local_archives:
            content = (local_archives / (model["name"] + "_infer.tar")).read_bytes()
        else:
            with urllib.request.urlopen(model["url"], timeout=180) as response:
                content = response.read(100 * 1024 * 1024 + 1)
        if len(content) > 100 * 1024 * 1024 or hashlib.sha256(content).hexdigest() != model["sha256"]:
            raise ValueError("OCR model archive checksum mismatch")
        output = destination / model["name"]
        output.mkdir(exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:*") as archive:
            found = set()
            for member in archive.getmembers():
                if member.isdir():
                    continue
                parts = member.name.split("/")
                if not member.isfile() or len(parts) != 2 or parts[0] != model["name"] + "_infer" or parts[1] not in MODEL_FILES or parts[1] in found or member.size > 100 * 1024 * 1024:
                    raise ValueError("Unexpected OCR model archive member")
                found.add(parts[1])
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError("Unreadable OCR model member")
                data = source.read()
                target = output / parts[1]
                target.write_bytes(data)
                hashes[str(target.relative_to(destination))] = hashlib.sha256(data).hexdigest()
            if found != MODEL_FILES:
                raise ValueError("Incomplete OCR model archive")
    (destination / "checksums.json").write_text(json.dumps(hashes, sort_keys=True, indent=2) + "\n")


@lru_cache(maxsize=1)
def verify_models() -> None:
    """Run once; image-owned model files are read-only to the runtime user."""
    directory = Path(os.environ.get("OCR_MODELS_DIR", "/opt/models"))
    actual = json.loads((directory / "checksums.json").read_text())
    expected_names = {f"{m['name']}/{f}" for m in json.loads(MANIFEST.read_text())["models"] for f in MODEL_FILES}
    if set(actual) != expected_names:
        raise ValueError("Unexpected OCR model manifest")
    for name, digest in actual.items():
        if hashlib.sha256((directory / name).read_bytes()).hexdigest() != digest:
            raise ValueError("OCR model integrity check failed")

