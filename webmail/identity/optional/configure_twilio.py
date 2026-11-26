#!/usr/bin/python3
"""Collect Twilio settings in a private guest terminal and publish one channel atomically."""

import argparse
import fcntl
import getpass
import os
import re
import secrets
import shutil
import sys
import tempfile
import termios
import warnings
from pathlib import Path


ROOT = Path("/etc/veyro-identity/phone-secrets")
PHONE = r"\+[1-9][0-9]{1,14}"
ACCOUNT = r"AC[0-9a-fA-F]{32}"
KEY = r"SK[0-9a-fA-F]{32}"


def ask(label, pattern):
    while True:
        value = getpass.getpass(label + " (skjult): ").strip()
        if re.fullmatch(pattern, value):
            return value
        print("Formatet er forkert. Prøv igen.", file=sys.stderr)


def settings(channel):
    result = {"account_sid": ask("Twilio Account SID, AC…", ACCOUNT)}
    if channel == "sms":
        result["auth_token"] = ask("Twilio Auth Token for kontoen", r"[!-~]{16,256}")
    else:
        mode = input("Brug en begrænset API-nøgle til WhatsApp? [J/n] ").strip().lower()
        if mode not in ("", "j", "y", "n"):
            raise ValueError("Vælg j eller n.")
        if mode == "n":
            result["auth_id"] = result["account_sid"]
            result["auth_secret"] = ask("Twilio Auth Token for kontoen", r"[!-~]{16,256}")
        else:
            result["auth_id"] = ask("Twilio API Key SID, SK…", KEY)
            result["auth_secret"] = ask("Twilio API Key Secret", r"[!-~]{16,256}")
        result["content_sid"] = ask("Twilio Content SID for den godkendte WhatsApp-skabelon, HX…", r"HX[0-9a-fA-F]{32}")
        result["internal_token"] = secrets.token_hex(32)
    result["sender"] = ask("Kanalens registrerede afsendernummer, med plus og landekode", PHONE)
    return result


def publish(root, channel, values):
    root.mkdir(mode=0o700, exist_ok=True)
    if root.is_symlink() or root.stat().st_uid != 0 or root.stat().st_mode & 0o077:
        raise ValueError("Mappen til kanalnøgler skal være privatejet af root med adgang 0700.")
    with (root / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = root / channel
        previous = None
        if current.is_symlink():
            previous = current.resolve(strict=True)
            if previous.parent != root or not previous.name.startswith("." + channel + "-"):
                raise ValueError("Uventet eksisterende nøglemappe.")
        elif current.exists():
            raise ValueError("Den eksisterende nøglemappe er ikke oprettet af Veyro-konfigurationen.")
        folder = Path(tempfile.mkdtemp(prefix="." + channel + "-", dir=root))
        link = root / (folder.name + ".link")
        try:
            for key, value in values.items():
                with (folder / key).open("x", encoding="ascii") as out:
                    out.write(value)
                    out.flush()
                    os.fchown(out.fileno(), 0, 1000)
                    os.fchmod(out.fileno(), 0o440)
                    os.fsync(out.fileno())
            link.symlink_to(folder.name)
            os.replace(link, current)
        except BaseException:
            link.unlink(missing_ok=True)
            if not current.is_symlink() or current.resolve() != folder:
                shutil.rmtree(folder)
            raise
        if previous:
            shutil.rmtree(previous)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("channel", nargs="?", choices=["sms", "whatsapp"])
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.exit(1, "Kør kommandoen med sudo.\n")
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        parser.exit(1, "Åbn en privat interaktiv terminal. Brug ssh -t ved fjernadgang.\n")
    with open("/dev/tty") as tty:
        termios.tcgetattr(tty.fileno())
    os.umask(0o077)
    warnings.simplefilter("error", getpass.GetPassWarning)
    channel = args.channel or input("Hvilken kanal vil du opsætte? [sms/whatsapp] ").strip().lower()
    if channel not in ("sms", "whatsapp"):
        parser.exit(1, "Vælg sms eller whatsapp.\n")
    print("Indtast værdierne fra Twilio Console. Afbryd med Ctrl-C.")
    values = settings(channel)
    publish(ROOT, channel, values)
    print(f"Indstillingerne til {channel} er gemt. Administratoren kan nu aktivere kanalen.")


if __name__ == "__main__":
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        sys.exit("\nAfbrudt.")
    except (OSError, ValueError, getpass.GetPassWarning) as exc:
        sys.exit(f"Opsætningen kunne ikke gennemføres: {exc}")
