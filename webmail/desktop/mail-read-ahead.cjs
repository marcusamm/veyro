'use strict';

const MAX_MESSAGE = 96 * 1024;
const MAX_TOTAL = 384 * 1024;
const MAX_COUNT = 8;

function smallMessages(rows) {
  const selected = new Map();
  let bytes = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.uid) || row.uid <= 0 || row.uid > 0xffffffff || selected.has(row.uid)) continue;
    if (!Number.isSafeInteger(row.size) || row.size <= 0 || row.size > MAX_MESSAGE || bytes + row.size > MAX_TOTAL) continue;
    selected.set(row.uid, row.size);
    bytes += row.size;
    if (selected.size === MAX_COUNT) break;
  }
  return selected;
}

// Coalesce row changes while the trackpad is still moving. The viewport is
// updated immediately so an in-flight off-screen transfer can be interrupted.
async function waitForScroll(task, run) {
  while (task.run === run && task.settleAt > Date.now()) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, task.settleAt - Date.now());
      run.stopWaiting = () => { clearTimeout(timer); resolve(); };
    });
    run.stopWaiting = null;
  }
}

function stopSession(task) {
  const run = task.run;
  task.run = null;
  run?.finishBatch?.();
  run?.stopWaiting?.();
  task.session?.close();
  task.session = null;
}

// Only the current viewport is eligible. Its temporary IMAP connection
// never owns the interactive connection or its queue.
class MailReadAhead {
  constructor({makeSession, connectorFor, cache}) {
    this.makeSession = makeSession;
    this.connectorFor = connectorFor;
    this.cache = cache;
    this.tasks = new Map();
  }

  schedule(id, account, folder, page) {
    const {uidValidity, messages} = page;
    const wanted = new Map();
    if (folder && uidValidity && Array.isArray(messages)) {
      for (const row of messages) {
        if (Number.isSafeInteger(row.uid) && row.uid > 0 && row.uid <= 0xffffffff) wanted.set(row.uid, row);
      }
    }
    if (!wanted.size) {
      this.cancel(id);
      return;
    }
    let task = this.tasks.get(id);
    if (task && (task.folder !== folder || task.uidValidity !== uidValidity)) {
      this.cancel(id);
      task = null;
    }
    if (!task) {
      task = {folder, uidValidity, attempted:new Set(), individually:new Set()};
      this.tasks.set(id, task);
    }
    this.cache.setViewport(id, folder, uidValidity, wanted.keys());
    const previousRows = task.wanted;
    if (previousRows && (wanted.size !== previousRows.size || Array.from(wanted.keys()).some(uid => !previousRows.has(uid)))) {
      task.settleAt = Date.now() + 80;
    }
    task.wanted = wanted;
    for (const uid of task.attempted) if (!wanted.has(uid)) task.attempted.delete(uid);
    for (const uid of task.individually) if (!wanted.has(uid)) task.individually.delete(uid);

    // Stop a partial FETCH if a scroll took one of its targets off screen.
    // A still-visible overlap can be retried; already cached rows cost no I/O.
    const previous = task.run;
    if (previous && previous.batch.some(row => !wanted.has(row.uid))) {
      stopSession(task);
    }
    if (task.run) return task.run.done;
    if (task.retryAfter > Date.now()) return;
    const request = {folder, uidValidity, markSeen:false};
    const pending = () => Array.from(task.wanted.values()).filter(row =>
      !task.attempted.has(row.uid) && !this.cache.get(id, {...request, uid:row.uid}));
    if (!pending().length) return;

    const run = {batch:[]};
    task.run = run;
    run.done = (async () => {
      if (task.settleAt > Date.now()) await waitForScroll(task, run);
      if (task.run !== run) return;
      const authenticated = typeof account === 'function' ? await account() : account;
      if (task.run !== run || !authenticated) return;
      // Across settled scrolls ImapSession reuses the authenticated socket or
      // reconnects after its own idle expiry / a credential change.
      task.session ??= this.makeSession();
      const connector = this.connectorFor(authenticated, task.session);
      let consecutiveErrors = 0;
      while (task.run === run) {
        if (task.settleAt > Date.now()) await waitForScroll(task, run);
        if (task.run !== run) return;
        const rows = pending();
        if (!rows.length) break;
        const small = task.singleOnly ? new Map() : smallMessages(rows.filter(row => !task.individually.has(row.uid)));
        run.batch = small.size ? rows.filter(row => small.has(row.uid)) : rows.slice(0, 1);
        run.batchDone = new Promise(resolve => { run.finishBatch = resolve; });
        let results = [];
        try {
          if (small.size) {
            results = await connector.warmMessages({folder, uidValidity, messages:run.batch});
          } else {
            // The normal reader can defer supported file attachments. Large
            // and unknown-size bodies run one at a time without setting Seen.
            const row = run.batch[0];
            results = [await connector.message({...request, uid:row.uid, sizeHint:row.size})];
          }
          consecutiveErrors = 0;
        } catch (error) {
          if (task.run !== run) return;
          if (error.authenticationFailed || error.responseStatus === 'BYE' ||
              ['MAIL_TIMEOUT','MAIL_DISCONNECTED','SESSION_CLOSED','STALE_MAILBOX','NoConnection','ECONNRESET','ETIMEDOUT','ETHROTTLE','ENOTFOUND','EHOSTUNREACH','ECONNREFUSED'].includes(error.code)) throw error;
          if (small.size && ['NO','BAD'].includes(error.responseStatus)) task.singleOnly = true;
          else if (!['NOT_FOUND','MESSAGE_TOO_LARGE'].includes(error.code) && ++consecutiveErrors >= 2) throw error;
          // A declined partial or a single malformed message must not stop
          // otherwise readable neighbours in this viewport.
        }
        if (task.run !== run) return;
        const batch = new Set(run.batch.map(row => row.uid));
        for (const msg of results) {
          const target = {...request, uid:msg.uid};
          if (batch.has(msg.uid) && task.wanted.has(msg.uid) && !task.attempted.has(msg.uid) &&
              msg.uidValidity === uidValidity) {
            if (!this.cache.get(id, target)) this.cache.remember(id, target, msg);
            task.attempted.add(msg.uid);
          }
        }
        // A size changed or a provider declined a partial. The normal reader
        // revalidates size and membership by UID before accepting a full body.
        for (const uid of batch) {
          if (small.size && !task.attempted.has(uid)) task.individually.add(uid);
          else task.attempted.add(uid);
        }
        run.finishBatch();
        run.batch = [];
      }
    })().catch(() => {
      // A failed speculative read must not retry continuously or block a click.
      if (task.run === run) {
        task.retryAfter = Date.now() + 30_000;
        stopSession(task);
      }
    }).finally(() => {
      run.finishBatch?.();
      if (task.run === run) task.run = null;
    });
    return run.done;
  }

  inFlight(id, {folder, uidValidity, uid}) {
    const task = this.tasks.get(id);
    const run = task?.run;
    if (!run?.batchDone || task.folder !== folder || task.uidValidity !== uidValidity ||
        task.attempted.has(uid) || !run.batch.some(row => row.uid === uid)) return;
    return new Promise(resolve => {
      const timer = setTimeout(resolve, 100);
      run.batchDone.then(() => { clearTimeout(timer); resolve(); });
    });
  }

  exclude(id, {folder, uidValidity, uid}) {
    const task = this.tasks.get(id);
    if (!task) return;
    // An action on a Gmail label can affect an alias in another folder.
    if (task.folder !== folder || task.uidValidity !== uidValidity) this.cancel(id);
    else if (task.wanted.has(uid)) task.attempted.add(uid);
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (task) stopSession(task);
    this.tasks.delete(id);
    this.cache.clearViewport(id);
  }

  clear() {
    for (const id of this.tasks.keys()) this.cancel(id);
  }
}

module.exports = {MailReadAhead, smallMessages};
