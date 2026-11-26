"""Provision the local Mailcow settings used by webmail password recovery."""

import json
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path


MAILCOW = Path("/opt/mailcow-dockerized")
SECRETS = Path("/etc/veyro-webmail-api/secrets")
STAFF = ("marcus@veyro.dk", "efe@veyro.dk")
VERSION_USER = "veyro_webmail_version"
VIEW = "veyro_webmail_credential_version"
TRIGGER = "veyro_webmail_expire_reset_links"
NOTIFICATION = {
    "PW_RESET_FROM": "kontakt@veyro.dk",
    "PW_RESET_SUBJ": "Nulstil din adgangskode til Veyro Mail",
    "PW_RESET_TEXT": (
        "Du har bedt om en ny adgangskode til {{username}}. Åbn linket inden for "
        "{{token_lifetime}} minutter for at vælge en ny adgangskode.\n\n{{link}}\n\n"
        "Derefter kan du logge ind på https://mail.veyro.dk/. "
        "Hvis du ikke har bedt om en ny adgangskode, kan du ignorere denne mail."
    ),
    "PW_RESET_HTML": (
        "<p>Du har bedt om en ny adgangskode til {{username}}.</p>"
        '<p><a href="{{link}}">Nulstil adgangskoden</a> inden for {{token_lifetime}} minutter.</p>'
        '<p>Derefter kan du logge ind på <a href="https://mail.veyro.dk/">mail.veyro.dk</a>.</p>'
        "<p>Hvis du ikke har bedt om en ny adgangskode, kan du ignorere denne mail.</p>"
    ),
}

BACKUP = Path("/root/veyro-webmail-recovery-prior.json")


def run(args, data=None):
    result = subprocess.run(args, cwd=MAILCOW, input=data, capture_output=True, text=True)
    if result.returncode:
        # SQL and native command diagnostics can include secrets.
        raise RuntimeError("Mailcow provisioning command failed")
    return result.stdout.rstrip("\n")


def sql(statement):
    return run(["docker", "compose", "exec", "-T", "mysql-mailcow", "sh", "-c",
                'exec mariadb -NBr -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'], statement)


def redis(*args):
    return run(["docker", "compose", "exec", "-T", "redis-mailcow", "sh", "-c",
                'REDISCLI_AUTH="$REDISPASS" exec redis-cli --raw "$@"', "--", *args])


def db_gateway():
    db_container = run(["docker", "compose", "ps", "-q", "mysql-mailcow"])
    gateway = run(["docker", "inspect", "--format",
                   "{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}", db_container])
    if not re.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", gateway):
        raise RuntimeError("Unexpected private database gateway")
    return gateway


def save_new(path, data, mode, gid):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode), "w") as file:
        os.fchown(file.fileno(), 0, gid)
        os.fchmod(file.fileno(), mode)
        json.dump(data, file, ensure_ascii=False)


def install_trigger(addresses, trigger=TRIGGER):
    # Mailcow can issue several reset links. Replacing the recovery address or
    # password must also revoke links issued to the previous owner/address.
    sql(f"""DELIMITER //
CREATE TRIGGER IF NOT EXISTS `{trigger}` AFTER UPDATE ON mailbox FOR EACH ROW
BEGIN
  IF NEW.username IN ({addresses})
    AND (NOT (OLD.password <=> NEW.password)
      OR NOT (JSON_EXTRACT(OLD.attributes, '$.recovery_email') <=> JSON_EXTRACT(NEW.attributes, '$.recovery_email'))) THEN
    DELETE FROM reset_password WHERE username=NEW.username;
  END IF;
END//
DELIMITER ;
""")


def staff_addresses():
    return ",".join("'" + email + "'" for email in STAFF)


def mailbox_view_query(staff_only=False):
    addresses = staff_addresses()
    if staff_only:
        # Exact definition used by the release before customer login.
        return (
            "SELECT username, SHA2(CONCAT(password, '|', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(attributes, '$.passwd_update')), '')), 256) AS version "
            f"FROM mailbox WHERE active=1 AND authsource='mailcow' AND username IN ({addresses})"
        )
    # Only the final generation is exposed. App credentials can change without
    # a primary-password change. Include IMAP/SMTP grants and native factor state
    # so a cached login expires after underlying access is revoked or restricted.
    fingerprint = "SHA2(CONCAT_WS('|', ap.id, ap.password, ap.imap_access, ap.smtp_access), 256)"
    app_keys = f"GROUP_CONCAT({fingerprint} ORDER BY ap.id SEPARATOR '')"
    return f"""
SELECT m.username,
       SHA2(CONCAT(
           m.password, '|', COALESCE(JSON_VALUE(m.attributes, '$.passwd_update'), ''),
           (SELECT CASE WHEN COUNT(*)=0 THEN ''
                        WHEN LENGTH({app_keys})=64*COUNT(*) THEN CONCAT('|', SHA2({app_keys}, 256))
                        ELSE NULL END
              FROM app_passwd ap WHERE ap.mailbox=m.username AND ap.active=1),
           CASE WHEN EXISTS (SELECT 1 FROM tfa f WHERE f.username=m.username AND f.active=1)
                THEN '|tfa' ELSE '' END
       ), 256) AS version
FROM mailbox m
JOIN domain d ON d.domain=m.domain
WHERE m.active=1 AND d.active=1 AND d.backupmx=0 AND d.relay_all_recipients=0
  AND m.kind='' AND m.authsource='mailcow'
  AND COALESCE(JSON_VALUE(m.attributes, '$.shared'), '0')='0'
  AND COALESCE(JSON_VALUE(m.attributes, '$.imap_access'), '1')='1'
  AND COALESCE(JSON_VALUE(m.attributes, '$.sogo_access'), '1')='1'
  AND NOT EXISTS (SELECT 1 FROM admin a WHERE a.username=m.username)
  AND (m.username IN ({addresses}) OR (
       COALESCE(JSON_VALUE(m.attributes, '$.force_pw_update'), '0')='0'
       AND COALESCE(JSON_VALUE(m.attributes, '$.force_tfa'), '0')='0'
       AND NOT EXISTS (SELECT 1 FROM tfa f WHERE f.username=m.username)
  ))"""


def migrate_mailbox_view(staff_only=False):
    if os.geteuid() != 0:
        raise SystemExit("Run on the mail guest as root.")
    # ALTER is atomic and preserves the existing view's grants. It also fails
    # on an unprovisioned system rather than silently creating a new principal.
    sql(f"ALTER SQL SECURITY DEFINER VIEW `{VIEW}` AS {mailbox_view_query(staff_only)};")
    print("Restored staff-only login view." if staff_only else "Updated login view for provisioned mailboxes.")


def configure():
    if os.geteuid() != 0:
        raise SystemExit("Run on the mail guest as root.")
    addresses = staff_addresses()
    values = sql(f"SELECT username, pw_reset FROM user_acl WHERE username IN ({addresses}) ORDER BY username;")
    previous_acl = dict(line.split("\t") for line in values.splitlines())
    if set(previous_acl) != set(STAFF):
        raise RuntimeError("Missing mailbox ACL")
    db = sql("SELECT DATABASE()")
    if not re.fullmatch(r"[A-Za-z0-9_]+", db):
        raise RuntimeError("Unexpected database")
    binding = run(["docker", "compose", "port", "mysql-mailcow", "3306"])
    match = re.fullmatch(r"127\.0\.0\.1:(\d+)", binding)
    if not match:
        raise RuntimeError("The Mailcow database must be bound to loopback")
    port = int(match[1])
    gateway = db_gateway()
    principal = f"'{VERSION_USER}'@'{gateway}'"
    cfg_path = SECRETS / "credential-version.json"
    if not BACKUP.exists():
        previous = {key: redis("GET", key) if redis("EXISTS", key) == "1" else None for key in NOTIFICATION}
        save_new(BACKUP, {"user_acl": previous_acl, "notification": previous}, 0o600, 0)
    if not cfg_path.exists():
        existing = sql(f"SELECT COUNT(*) FROM mysql.user WHERE User='{VERSION_USER}';")
        view_exists = sql(f"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='{db}' AND TABLE_NAME='{VIEW}';")
        if existing != "0" or view_exists != "0":
            raise RuntimeError("Database objects already exist without matching local credentials")
        save_new(cfg_path, {"host": "127.0.0.1", "port": port, "database": db, "user": VERSION_USER,
                            "password": secrets.token_urlsafe(48)}, 0o440, 65532)
    cfg = json.loads(cfg_path.read_text())
    password = cfg["password"]
    if cfg["user"] != VERSION_USER or cfg["database"] != db or cfg["port"] != port or not re.fullmatch(r"[A-Za-z0-9_-]{64}", password):
        raise RuntimeError("Unexpected credential settings")
    # Do not replace or rotate a pre-existing database password on a retry.
    sql(f"CREATE USER IF NOT EXISTS {principal} IDENTIFIED BY '{password}';"
        f"CREATE OR REPLACE SQL SECURITY DEFINER VIEW `{VIEW}` AS {mailbox_view_query()};"
        f"GRANT SELECT ON `{db}`.`{VIEW}` TO {principal};")
    if sql(f"SELECT COUNT(*) FROM `{VIEW}` WHERE version IS NULL OR LENGTH(version)<>64;") != "0":
        raise RuntimeError("Invalid mailbox version")
    install_trigger(addresses)
    sql(f"UPDATE user_acl SET pw_reset=1 WHERE username IN ({addresses}) AND pw_reset=0;")
    for key in ("PW_RESET_FROM", "PW_RESET_SUBJ"):
        if not redis("GET", key):
            redis("SET", key, NOTIFICATION[key])
    if not redis("GET", "PW_RESET_TEXT"):
        if not redis("GET", "PW_RESET_HTML"):
            redis("SET", "PW_RESET_HTML", NOTIFICATION["PW_RESET_HTML"])
        redis("SET", "PW_RESET_TEXT", NOTIFICATION["PW_RESET_TEXT"])
    if any(not redis("GET", key) for key in ("PW_RESET_FROM", "PW_RESET_SUBJ", "PW_RESET_TEXT")):
        raise RuntimeError("Mailcow notification is incomplete")
    print("Configured Mailcow recovery notification, mailbox permissions and read-only credential versions.")


def rollback():
    # Run only after rolling back the API to a release that does not read this view.
    if os.geteuid() != 0 or not BACKUP.is_file():
        raise SystemExit("Run as root with the saved pre-install settings.")
    snapshot = json.loads(BACKUP.read_text())
    for email in STAFF:
        previous = snapshot["user_acl"][email]
        if previous not in ("0", "1"):
            raise ValueError("Invalid saved mailbox permission")
        sql(f"UPDATE user_acl SET pw_reset={previous} WHERE username='{email}' AND pw_reset=1;")
    for key, template in NOTIFICATION.items():
        if redis("GET", key) == template:
            prior = snapshot["notification"][key]
            if prior is None:
                redis("DEL", key)
            else:
                redis("SET", key, prior)
    sql(f"DROP TRIGGER IF EXISTS `{TRIGGER}`; DROP VIEW IF EXISTS `{VIEW}`;")
    sql(f"DROP USER IF EXISTS '{VERSION_USER}'@'{db_gateway()}';")
    (SECRETS / "credential-version.json").unlink(missing_ok=True)
    print("Restored pre-install settings and removed the recovery view, trigger and reader.")


if __name__ == "__main__":
    if sys.argv[1:] == ["--rollback"]:
        rollback()
    elif sys.argv[1:] == ["--upgrade-mailbox-view"]:
        migrate_mailbox_view()
    elif sys.argv[1:] == ["--rollback-mailbox-view"]:
        migrate_mailbox_view(staff_only=True)
    elif not sys.argv[1:]:
        configure()
    else:
        raise SystemExit("Usage: python3 configure-recovery.py [--upgrade-mailbox-view | --rollback-mailbox-view | --rollback]")
