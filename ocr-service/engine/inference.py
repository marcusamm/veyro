"""The only module which imports Paddle; no user document paths or URLs."""

import os
from pathlib import Path

# Models are part of the image. Even source availability checks must stay offline.
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"

from limits import InvalidDocument, MAX_TEXT_CHARS
from layout import reconstruct_rows, text_boxes

MODEL_NAMES = ("PP-OCRv6_small_det", "PP-OCRv6_small_rec")
PROVIDER = "Veyro PaddleOCR 3.7.0 · PP-OCRv6 small · CPU"


def create_pipeline():
    from paddleocr import PaddleOCR

    models = Path(os.environ.get("OCR_MODELS_DIR", "/opt/models"))
    for name in MODEL_NAMES:
        if not (models / name / "inference.yml").is_file():
            raise RuntimeError("Baked OCR model is missing")
    return PaddleOCR(
        text_detection_model_name=MODEL_NAMES[0],
        text_detection_model_dir=str(models / MODEL_NAMES[0]),
        text_recognition_model_name=MODEL_NAMES[1],
        text_recognition_model_dir=str(models / MODEL_NAMES[1]),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
        cpu_threads=1,
        enable_mkldnn=False,
        text_recognition_batch_size=4,
        text_det_limit_side_len=2400,
        text_det_limit_type="max",
    )


def extract(data: bytes, mime: str) -> dict:
    import numpy as np
    from documents import pages

    pipeline = None
    output = []
    length = 0
    for image in pages(data, mime):
        if pipeline is None:
            pipeline = create_pipeline()
        # Paddle's NumPy image API expects OpenCV's BGR order.
        bgr = np.asarray(image)[:, :, ::-1].copy()
        results = list(pipeline.predict(bgr, return_word_box=True))
        if len(results) != 1:
            raise InvalidDocument("Unexpected OCR page result")
        text = reconstruct_rows(text_boxes(results[0]))
        length += len(text)
        if length > MAX_TEXT_CHARS:
            raise InvalidDocument("OCR text exceeds limit")
        output.append(text)
    if not output or not any(output):
        raise InvalidDocument("No readable text")
    return {"pages": output, "provider": PROVIDER}

