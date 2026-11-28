FROM python:3.12-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py mailstore.py message_view.py rich_email.py email_css.py account.py snooze.py remembered_sessions.py ai_connector.py org_admin_client.py org_broker.py org_admin.py team.py ./
RUN install -d -m 0700 -o 65532 -g 65532 /var/lib/veyro-webmail
USER 65532:65532
CMD ["gunicorn","--workers","1","--worker-class","gthread","--threads","8","--bind","127.0.0.1:18082","--timeout","60","--no-control-socket","--error-logfile","-","app:app"]
