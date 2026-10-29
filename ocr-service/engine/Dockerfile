FROM python:3.12-slim-bookworm

# Native image/PDF dependencies; no server, GPU runtime, or external OCR API.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.lock /app/requirements.lock
RUN python -m pip install --no-cache-dir -r /app/requirements.lock
COPY models.json model_assets.py bake_models.py /app/
RUN python /app/bake_models.py /opt/models \
    && chmod -R a-w /opt/models

COPY *.py /app/
ENV OCR_MODELS_DIR=/opt/models \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp

USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)"
CMD ["python", "-m", "uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-access-log", "--timeout-keep-alive", "5"]

