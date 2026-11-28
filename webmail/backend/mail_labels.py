"""Mailbox label catalog. Message membership is always stored in IMAP keywords."""
from contextlib import closing

from mailstore import MailError, label_flag, label_names
import snooze


def name_of(value):
    return label_names([label_flag(value)])[0]


def connection():
    db = snooze.connection()
    try:
        db.execute("""CREATE TABLE IF NOT EXISTS mail_labels (
            address TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, target TEXT,
            PRIMARY KEY (address, name))""")
    except Exception:
        db.close()
        raise
    return db


def snapshot(db, address):
    rows = db.execute("SELECT name,state,target FROM mail_labels WHERE address=? ORDER BY name", (address,))
    result = dict(labels=[], hidden=[], pending=[])
    for name, state, target in rows:
        result["hidden" if state == "hidden" else "labels"].append(name)
        if state in ("rename", "delete"):
            result["pending"].append(dict(name=name, operation=state, newName=target))
    return result


def discover(address, client, folders):
    names = set()
    for folder in folders:
        flags = client.select_folder(folder["name"], readonly=True).get(b"FLAGS", ())
        names.update(label_names(flags))
    with closing(connection()) as db, db:
        db.executemany("INSERT OR IGNORE INTO mail_labels VALUES (?,?,'active',NULL)",
                       [(address, name) for name in names])
        return snapshot(db, address)


def state_of(db, address, name):
    return db.execute("SELECT state,target FROM mail_labels WHERE address=? AND name=?",
                      (address, name)).fetchone()


def reserved(db, address, name):
    return db.execute("SELECT 1 FROM mail_labels WHERE address=? AND target=? AND state='rename'",
                      (address, name)).fetchone()


def record_message_label(address, value, apply):
    name = name_of(value)
    with closing(connection()) as db, db:
        state = state_of(db, address, name)
        if state and state[0] != "active" or reserved(db, address, name):
            raise MailError("Etiketten er ændret. Opdatér postkassen, og prøv igen.", 409)
        result = apply()
        db.execute("INSERT OR IGNORE INTO mail_labels VALUES (?,?,'active',NULL)", (address, name))
        return result


def replace_keywords(client, folders, old, new):
    for folder in folders:
        flags = client.select_folder(folder["name"], readonly=True).get(b"FLAGS", ())
        if old not in {flag.lower() for flag in flags}:
            continue
        # Never reuse a UID found before SELECT: a recreated mailbox can
        # reuse the same numeric UIDs under a new UIDVALIDITY.
        client.select_folder(folder["name"], readonly=False)
        uids = list(client.search(["KEYWORD", old]))
        for start in range(0, len(uids), 200):
            chunk = uids[start:start + 200]
            if new:
                added = client.add_flags(chunk, [new])
                if any(new not in {f.lower() for f in added.get(uid, ())} for uid in chunk):
                    raise MailError("Omdøbningen blev afbrudt. Fortsæt under Administrer etiketter.", 409)
            removed = client.remove_flags(chunk, [old])
            if any(uid not in removed or old in {f.lower() for f in removed[uid]} for uid in chunk):
                raise MailError("Ændringen blev afbrudt. Fortsæt under Administrer etiketter.", 409)


def manage(address, data, client, folders):
    operation = data.get("operation")
    if operation not in ("create", "rename", "delete"):
        raise MailError("Vælg en gyldig etikethandling.")
    name = name_of(data.get("name"))
    target = name_of(data.get("newName")) if operation == "rename" else None
    discover(address, client, folders)
    with closing(connection()) as db:
        with db:
            state = state_of(db, address, name)
            if reserved(db, address, name):
                raise MailError("Afslut den igangværende omdøbning først.", 409)
            if operation == "create":
                if state and state[0] not in ("active", "hidden"):
                    raise MailError("Afslut den igangværende ændring først.", 409)
                db.execute("INSERT OR REPLACE INTO mail_labels VALUES (?,?,'active',NULL)", (address, name))
                return snapshot(db, address)
            if not state or state[0] == "hidden":
                if state == ("hidden", target):
                    return snapshot(db, address)
                raise MailError("Etiketten blev ikke fundet.", 404)
            if state[0] in ("rename", "delete") and state != (operation, target):
                raise MailError("Afslut den igangværende ændring først.", 409)
            if state[0] == "active" and target:
                if target == name:
                    return snapshot(db, address)
                other = state_of(db, address, target)
                if other and other[0] != "hidden" or reserved(db, address, target):
                    raise MailError("Der findes allerede en etiket med det navn.", 409)
            db.execute("UPDATE mail_labels SET state=?, target=? WHERE address=? AND name=?",
                       (operation, target, address, name))
        # Persist the intent first. A retry reapplies additions before removals,
        # including after an IMAP disconnect or an application restart.
        replace_keywords(client, folders, label_flag(name), label_flag(target) if target else None)
        with db:
            db.execute("UPDATE mail_labels SET state='hidden' WHERE address=? AND name=?", (address, name))
            if target:
                db.execute("INSERT OR REPLACE INTO mail_labels VALUES (?,?,'active',NULL)", (address, target))
            return snapshot(db, address)
