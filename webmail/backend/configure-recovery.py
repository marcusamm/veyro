"""Provision the local Mailcow settings used by webmail password recovery."""

import json
import os
import re
import secrets
import subprocess
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


def configure():
    if os.geteuid() != 0:
        raise SystemExit("Run on the mail guest as root.")
    addresses = ",".join("'" + email + "'" for email in STAFF)
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
    db_container = run(["docker", "compose", "ps", "-q", "mysql-mailcow"])
    gateway = run(["docker", "inspect", "--format",
                   "{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}", db_container])
    if not re.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", gateway):
        raise RuntimeError("Unexpected private database gateway")
    principal = f"'{VERSION_USER}'@'{gateway}'"
    cfg_path = SECRETS / "credential-version.json"
    backup = Path("/root/veyro-webmail-recovery-prior.json")
    if not backup.exists():
        previous = {key: redis("GET", key) if redis("EXISTS", key) == "1" else None for key in NOTIFICATION}
        save_new(backup, {"user_acl": previous_acl, "notification": previous}, 0o600, 0)
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
        f"CREATE OR REPLACE SQL SECURITY DEFINER VIEW `{VIEW}` AS "
        "SELECT username, SHA2(CONCAT(password, '|', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(attributes, '$.passwd_update')), '')), 256) AS version "
        f"FROM mailbox WHERE active=1 AND authsource='mailcow' AND username IN ({addresses});"
        f"GRANT SELECT ON `{db}`.`{VIEW}` TO {principal};")
    if sql(f"SELECT COUNT(*) FROM `{VIEW}` WHERE LENGTH(version)=64;") != str(len(STAFF)):
        raise RuntimeError("Missing mailbox version")
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


if __name__ == "__main__":
    configure()
