"""Read virtual mailbox views while preserving each message's real IMAP identity."""
import heapq
import secrets
import time

import mailstore


def list_page(client, session, view, cursor, query, label, sender):
    folders = [f for f in session.cached_folders(client) if f["role"] not in {"trash", "junk", "all"}]
    key = (view, query, label, sender, tuple(f["id"] for f in folders))
    now = time.monotonic()
    saved = session.view_pages
    for token, (expiry, _, _) in list(saved.items()):
        if expiry <= now:
            del saved[token]
    positions = {}
    if cursor:
        snapshot = saved.get(cursor)
        if not snapshot or snapshot[1] != key:
            raise mailstore.MailError("Visningen er ændret. Åbn den igen.", 409)
        positions = snapshot[2].copy()

    heap, pages, labels = [], {}, set()
    for folder in folders:
        fid = folder["id"]
        if fid in positions and positions[fid] is None:
            continue
        page = mailstore.list_messages(client, folder["name"], positions.get(fid), query, address=session.email,
                                       sender=sender, label=label, view=view, positions=True)
        labels.update(page["availableLabels"])
        rows = page["messages"]
        if rows:
            pages[fid] = page
            heapq.heappush(heap, (-rows[0]["_arrival"], fid, 0))
        else:
            positions[fid] = None

    messages = []
    while heap and len(messages) < mailstore.PAGE:
        _, fid, index = heapq.heappop(heap)
        page = pages[fid]
        row = page["messages"][index]
        positions[fid] = row.pop("_after")
        row.pop("_arrival")
        messages.append(dict(row, folder=fid))
        if index + 1 < len(page["messages"]):
            heapq.heappush(heap, (-page["messages"][index + 1]["_arrival"], fid, index + 1))
        elif not page["nextCursor"]:
            positions[fid] = None

    next_cursor = None
    if heap or any(page["nextCursor"] for page in pages.values()):
        # The session lock serializes IMAP reads and cursor changes. A retried
        # request can reuse its snapshot. Other sessions cannot use its token.
        next_cursor = secrets.token_urlsafe(24)
        if len(saved) >= 32:
            del saved[next(iter(saved))]
        saved[next_cursor] = (now + 1800, key, positions)
    return dict(messages=messages, nextCursor=next_cursor, availableLabels=sorted(labels, key=str.casefold))
