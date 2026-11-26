import sqlite3
import time
from contextlib import closing
from datetime import datetime

from mailstore import MailError


DATABASE = "/var/lib/veyro-webmail/organizer.sqlite3"


def connection():
    db = sqlite3.connect(DATABASE, timeout=5)
    try:
        db.execute("""CREATE TABLE IF NOT EXISTS snoozed (
            address TEXT NOT NULL, validity INTEGER NOT NULL, uid INTEGER NOT NULL,
            wake_at INTEGER NOT NULL, PRIMARY KEY (address, validity, uid)
        )""")
    except Exception:
        db.close()
        raise
    return db


def active(address, validity):
    with closing(connection()) as db:
        rows = db.execute("SELECT uid FROM snoozed WHERE address=? AND validity=? AND wake_at>?",
                          (address, validity, int(time.time())))
        return {row[0] for row in rows}


def wake_time(value):
    if value is None:
        return None
    try:
        if not isinstance(value, str) or len(value) > 48:
            raise ValueError()
        date = datetime.fromisoformat(value)
        if date.tzinfo is None:
            raise ValueError()
        wake_at = int(date.timestamp())
    except (ValueError, OverflowError, OSError):
        raise MailError("Vælg en dato og et klokkeslæt.") from None
    if wake_at <= time.time():
        raise MailError("Vælg et tidspunkt i fremtiden.")
    return wake_at


def save(address, validity, uid, wake_at):
    with closing(connection()) as db, db:
        db.execute("DELETE FROM snoozed WHERE wake_at<=?", (int(time.time()),))
        if wake_at is None:
            db.execute("DELETE FROM snoozed WHERE address=? AND validity=? AND uid=?",
                       (address, validity, uid))
        else:
            db.execute("""INSERT INTO snoozed (address, validity, uid, wake_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (address,validity,uid) DO UPDATE SET wake_at=excluded.wake_at""",
                       (address, validity, uid, wake_at))
