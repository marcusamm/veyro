'use strict';

// Native connector results contain sanitized bodies and attachment descriptors.
// Only cache completed reads whose folder generation was checked by the server.
class RecentMessages {
  constructor({maxEntries = 100, maxBytes = 64 * 1024 * 1024, ttl = 3 * 60_000} = {}) {
    this.entries = new Map();
    this.bytes = 0;
    this.viewports = new Map();
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.ttl = ttl;
  }

  key(accountId, {folder, uidValidity, uid}) {
    if (typeof folder !== 'string' || !uidValidity || typeof uidValidity !== 'string' || !Number.isSafeInteger(uid)) return;
    return JSON.stringify([accountId, folder, uidValidity, uid]);
  }

  setViewport(accountId, folder, uidValidity, uids) {
    const visible = new Set(Array.from(uids, uid => this.key(accountId, {folder, uidValidity, uid})));
    this.updateViewport(accountId, visible);
  }

  clearViewport(accountId) {
    this.updateViewport(accountId, new Set());
  }

  updateViewport(accountId, visible) {
    const previous = this.viewports.get(accountId);
    if (visible.size) this.viewports.set(accountId, visible);
    else this.viewports.delete(accountId);
    for (const [key, entry] of this.entries) {
      if (entry.accountId !== accountId || !!previous?.has(key) === visible.has(key)) continue;
      this.setExpiry(key, entry, visible.has(key));
    }
  }

  setExpiry(key, entry, visible) {
    clearTimeout(entry.timeout);
    entry.expires = visible ? Infinity : Date.now() + this.ttl;
    if (!visible) {
      entry.timeout = setTimeout(() => this.remove(key), this.ttl);
      entry.timeout.unref();
    }
  }

  get(accountId, request) {
    const key = this.key(accountId, request);
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= Date.now()) {
      this.remove(key);
      return;
    }
    if (request.markSeen !== false && !entry.message.seen) return;
    // Keep frequently opened messages within the size limit; reads do not extend their TTL.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.message;
  }

  remember(accountId, request, message) {
    const key = this.key(accountId, request);
    if (!key || message.uid !== request.uid || message.uidValidity !== request.uidValidity) return;
    this.remove(key);
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > this.maxBytes) return;
    const visible = this.viewports.get(accountId)?.has(key) || false;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      let victim;
      for (const [candidate, entry] of this.entries) {
        if (!this.viewports.get(entry.accountId)?.has(candidate)) { victim = candidate; break; }
      }
      if (victim === undefined && !visible) return;
      this.remove(victim ?? this.entries.keys().next().value);
    }
    const entry = {accountId, folder:request.folder, message, bytes};
    this.setExpiry(key, entry, visible);
    this.entries.set(key, entry);
    this.bytes += bytes;
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timeout);
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  refreshFolder(accountId, folder, {uidValidity, messages}) {
    const listed = new Map(messages.map(row => [row.uid, row]));
    for (const [key, entry] of this.entries) {
      if (entry.accountId !== accountId || entry.folder !== folder) continue;
      const row = listed.get(entry.message.uid);
      // A Gmail label can be edited in another client between two listings.
      // Rewarm changed bodies so cache accounting stays accurate for long label lists.
      const labelsChanged = Array.isArray(row?.labels) &&
        JSON.stringify(row.labels) !== JSON.stringify(entry.message.labels || []);
      if (!row || entry.message.uidValidity !== uidValidity || labelsChanged) this.remove(key);
      else {
        entry.message.seen = row.seen;
        entry.message.flagged = row.flagged;
        if (typeof row.important === 'boolean') entry.message.important = row.important;
      }
    }
  }

  applyAction(accountId, request) {
    const key = this.key(accountId, request);
    for (const [candidate, entry] of this.entries) {
      if (entry.accountId !== accountId) continue;
      // Gmail labels may give one message a different UID in another folder.
      if (!key || entry.folder !== request.folder) this.remove(candidate);
      else if (candidate === key) {
        switch (request.action) {
          case 'read': entry.message.seen = true; break;
          case 'unread': entry.message.seen = false; break;
          case 'star': entry.message.flagged = true; break;
          case 'unstar': entry.message.flagged = false; break;
          default: this.remove(key);
        }
      }
    }
  }

  clear(accountId) {
    if (accountId === undefined) this.viewports.clear();
    else this.viewports.delete(accountId);
    for (const [key, entry] of this.entries) {
      if (accountId === undefined || entry.accountId === accountId) this.remove(key);
    }
  }
}

function onlyOtherReadAcknowledgements(pending, request) {
  if (!pending?.size || request?.markSeen !== false) return false;
  for (const ack of pending.values()) {
    if (!ack || !Number.isSafeInteger(ack.uid) || ack.folder !== request.folder || ack.uidValidity !== request.uidValidity || ack.uid === request.uid) return false;
  }
  return true;
}

module.exports = {RecentMessages, onlyOtherReadAcknowledgements};
